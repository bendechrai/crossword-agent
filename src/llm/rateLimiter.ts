import type { Emit } from '../events/types.js';
import { limitsOf } from './pricing.js';
import type { RateLimiter, RateLimiterState, RateLimitSignal } from './types.js';

/** Applied to the catalogue RPM and TPM unless overridden (spec: "Rate limiting"). */
const DEFAULT_RPS_FRACTION = 0.9;

/**
 * Spec default for tier 1 (tier 2 is 16); this module has no notion of
 * tiers, so a caller building a tier-2 limiter passes `maxConcurrency: 16`
 * explicitly.
 */
const DEFAULT_MAX_CONCURRENCY = 8;

const RECOVERY_INTERVAL_MS = 10_000;
const RECOVERY_STEP_RPS = 0.5;
const MIN_RPS = 1;

/** The "per second" of requests-per-second: the sliding window's nominal span. */
const RPS_WINDOW_MS = 1000;

const RESET_DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/i;
const PLAIN_NUMBER_RE = /^\d+(?:\.\d+)?$/;

const DURATION_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

const HEADER = {
  remainingRequests: 'x-ratelimit-remaining-requests',
  resetRequests: 'x-ratelimit-reset-requests',
  remainingTokens: 'x-ratelimit-remaining-tokens',
  resetTokens: 'x-ratelimit-reset-tokens',
  retryAfter: 'retry-after',
  /**
   * Read but not mapped: `RateLimitSignal` has no field for the static
   * per-model ceiling, since that number already lives in `models.json` and
   * does not change response to response.
   */
  limitRequests: 'x-ratelimit-limit-requests',
  limitTokens: 'x-ratelimit-limit-tokens',
} as const;

/**
 * `RateLimitSignal.status` is not derivable from response headers alone (it
 * is the HTTP status line, not a header); the caller building the full
 * signal for `observe()` supplies it from the response it already has.
 */
export type RateLimitHeaderSignal = Omit<RateLimitSignal, 'status'>;

function parseIntHeader(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** `1s`, `60ms`, `1.5m` -> ms; a plain number is already milliseconds. */
function parseResetDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const durationMatch = RESET_DURATION_RE.exec(trimmed);
  if (durationMatch) {
    const [, amount, unit] = durationMatch;
    const unitMs = DURATION_UNIT_MS[unit!.toLowerCase()];
    if (amount !== undefined && unitMs !== undefined) return Number(amount) * unitMs;
  }
  if (PLAIN_NUMBER_RE.test(trimmed)) return Number(trimmed);
  return undefined;
}

/** RFC 7231: `retry-after` is either delay-seconds or an HTTP-date. */
function parseRetryAfter(value: string | undefined, nowMs: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (PLAIN_NUMBER_RE.test(trimmed)) return Number(trimmed) * 1000;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return parsed - nowMs;
}

/** The seven OpenAI-compatible rate-limit headers, all optional (spec). */
export function parseRateLimitHeaders(headers: Record<string, string>): RateLimitHeaderSignal {
  const result: RateLimitHeaderSignal = {};

  const remainingRequests = parseIntHeader(headers[HEADER.remainingRequests]);
  if (remainingRequests !== undefined) result.remainingRequests = remainingRequests;

  const remainingTokens = parseIntHeader(headers[HEADER.remainingTokens]);
  if (remainingTokens !== undefined) result.remainingTokens = remainingTokens;

  const resetRequestsMs = parseResetDuration(headers[HEADER.resetRequests]);
  if (resetRequestsMs !== undefined) result.resetRequestsMs = resetRequestsMs;

  const resetTokensMs = parseResetDuration(headers[HEADER.resetTokens]);
  if (resetTokensMs !== undefined) result.resetTokensMs = resetTokensMs;

  const retryAfterMs = parseRetryAfter(headers[HEADER.retryAfter], Date.now());
  if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;

  // HEADER.limitRequests and HEADER.limitTokens are named (so an unexpected
  // value there is never mistaken for one of the mapped fields above) but
  // have nowhere to go on `RateLimitSignal`; see the HEADER comment.

  return result;
}

/**
 * Continuous refill token bucket: `capacity` tokens available at full,
 * refilling at `ratePerMs` tokens/ms up to `capacity`. Used for the
 * tokens-per-minute allowance, where a full bucket at start-up is the
 * intended behaviour - a fresh minute really does have the whole TPM budget
 * available. Requests-per-second is gated by `SlidingWindowGate` instead;
 * see the note there for why a seeded bucket is the wrong shape for it.
 */
class TokenBucket {
  private tokens: number;
  private lastUpdateMs: number;

  constructor(
    private capacity: number,
    private ratePerMs: number,
    nowMs: number,
  ) {
    this.tokens = capacity;
    this.lastUpdateMs = nowMs;
  }

  private refill(nowMs: number): void {
    const elapsed = nowMs - this.lastUpdateMs;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerMs);
    this.lastUpdateMs = nowMs;
  }

  /** ms until `amount` tokens are available; 0 when already available. */
  waitMs(amount: number, nowMs: number): number {
    this.refill(nowMs);
    if (this.tokens >= amount) return 0;
    if (this.ratePerMs <= 0) return Infinity;
    return (amount - this.tokens) / this.ratePerMs;
  }

  consume(amount: number, nowMs: number): void {
    this.refill(nowMs);
    this.tokens -= amount;
  }

  getCapacity(): number {
    return this.capacity;
  }
}

/**
 * Requests-per-second gate: a grant is allowed only while fewer than `limit`
 * grants have been recorded in the trailing `windowMs`, so the count in any
 * window of that length can never exceed `limit`.
 *
 * A refilling token bucket cannot express this. Seeded full at capacity
 * `rps` it also refills at `rps` per second, so after an idle second it
 * hands out its whole seeded burst AND everything the refill added during
 * the wait - about 2 * rps grants inside the first second (measured: rps 10,
 * 20 queued acquires, 19 released in [0, 1000) ms). Seeding it empty instead
 * would fix the count but destroy the burst the seed pass depends on.
 *
 * The window keeps both: `limit` grants land immediately, and the next one
 * waits until the oldest of them falls out of the window.
 *
 * A fractional rps (AIMD halving, or a low-RPM catalogue entry) is expressed
 * by stretching the window rather than rounding the limit away: `limit` is
 * `floor(rps)` with a floor of 1, and `windowMs` is `limit / rps` seconds,
 * so 2.5 rps is 2 grants per 800 ms and 0.3 rps is 1 grant per 3333 ms -
 * both exactly the requested long-run rate.
 */
class SlidingWindowGate {
  /** Timestamps of the grants still inside the window, oldest first. */
  private readonly grants: number[] = [];
  private limit = 1;
  private windowMs = RPS_WINDOW_MS;

  constructor(rps: number) {
    this.setRate(rps);
  }

  /** Re-rates the gate in place (AIMD); recorded grants are kept. */
  setRate(rps: number): void {
    this.limit = rps > 0 ? Math.max(1, Math.floor(rps)) : 1;
    this.windowMs = rps > 0 ? (this.limit / rps) * RPS_WINDOW_MS : Number.POSITIVE_INFINITY;
  }

  /**
   * Drops grants that have aged out. A grant exactly `windowMs` old is
   * already outside the window: the window is the half-open interval
   * `(now - windowMs, now]`, which is what makes the 10 grants at t=0
   * stop counting at t=1000 rather than t=1001.
   */
  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    let expired = 0;
    while (expired < this.grants.length && this.grants[expired]! <= cutoff) expired += 1;
    if (expired > 0) this.grants.splice(0, expired);
  }

  /** ms until a grant is allowed; 0 when one is allowed right now. */
  waitMs(nowMs: number): number {
    this.prune(nowMs);
    if (this.grants.length < this.limit) return 0;
    // length >= limit >= 1, so the oldest grant exists.
    return this.grants[0]! + this.windowMs - nowMs;
  }

  record(nowMs: number): void {
    this.grants.push(nowMs);
  }
}

interface QueueEntry {
  estimatedTokens: number;
  resolve: () => void;
}

/**
 * Drops a timer's hold on the event loop while leaving it scheduled: an
 * unref'd timer still fires as long as something else keeps the process
 * alive, but stops being a reason on its own not to exit.
 *
 * Nothing in this codebase calls `process.exit` (`src/cli/exit.ts`), so the
 * process ends only when the event loop drains; a timer that re-arms itself
 * would otherwise keep it running long after the command finished.
 *
 * Under Node the handle is a `NodeJS.Timeout` and always has `unref`, but
 * vitest's fake timers substitute a stand-in, so its presence is checked
 * rather than assumed.
 */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref();
}

class RateLimiterImpl implements RateLimiter {
  private readonly ceilingRps: number;
  private rps: number;
  private readonly rpsGate: SlidingWindowGate;
  private readonly tpmBucket: TokenBucket;
  private readonly queue: QueueEntry[] = [];
  private inFlight = 0;
  private lastSignal: RateLimitSignal | undefined;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly model: string,
    rps: number,
    tpm: number,
    private readonly maxConcurrency: number,
    private readonly emit: Emit | undefined,
  ) {
    this.ceilingRps = rps;
    this.rps = rps;
    this.rpsGate = new SlidingWindowGate(rps);
    this.tpmBucket = new TokenBucket(tpm, tpm / 60_000, Date.now());
  }

  acquire(estimatedTokens: number): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ estimatedTokens, resolve });
      this.drain();
    });
  }

  observe(signal: RateLimitSignal): void {
    this.lastSignal = signal;
    if (this.inFlight > 0) this.inFlight -= 1;
    if (signal.status === 429) this.applyDecrease();
    this.drain();
  }

  snapshot(): RateLimiterState {
    return {
      model: this.model,
      rps: this.rps,
      inFlight: this.inFlight,
      queued: this.queue.length,
      ...(this.lastSignal !== undefined ? { lastSignal: this.lastSignal } : {}),
    };
  }

  /**
   * Clears pending timers, so a disposed limiter holds nothing on the event
   * loop. Called by `resetRegistryForTests`, and available to a caller that
   * abandons queued `acquire()` promises (see `scheduleWake`).
   */
  dispose(): void {
    this.clearWake();
    if (this.recoveryTimer !== undefined) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
  }

  private drain(): void {
    const now = Date.now();
    for (;;) {
      const head = this.queue[0];
      if (head === undefined) {
        // Invariant: a wake timer exists only while somebody is queued. The
        // timer's sole job is to release the head, so once the queue is
        // empty it has nothing to do, and leaving it armed would hold the
        // event loop open (up to a full TPM window) with no work pending.
        this.clearWake();
        return;
      }
      if (this.inFlight >= this.maxConcurrency) {
        // Concurrency only frees up through `observe()`, which re-drains
        // itself, so no timer is needed here.
        return;
      }
      // A caller that estimates more tokens than the bucket can ever hold
      // (estimatedTokens > capacity) would otherwise wait forever, since
      // `refill` caps `tokens` at `capacity` and `waitMs` would stay
      // positive no matter how long the queue waits - starving every
      // later caller behind it in this strict-FIFO queue. Clamp the
      // demand to the bucket's capacity so such a request is instead
      // granted as soon as the bucket is full.
      const tpmDemand = Math.min(head.estimatedTokens, this.tpmBucket.getCapacity());
      const wait = Math.max(this.rpsGate.waitMs(now), this.tpmBucket.waitMs(tpmDemand, now));
      if (wait > 0) {
        this.scheduleWake(wait);
        return;
      }
      this.rpsGate.record(now);
      this.tpmBucket.consume(tpmDemand, now);
      this.inFlight += 1;
      this.queue.shift();
      head.resolve();
    }
  }

  private clearWake(): void {
    if (this.wakeTimer !== undefined) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
  }

  /**
   * Deliberately NOT unref'd, unlike the recovery timer: this timer is the
   * only thing that will ever settle the queued `acquire()` promises, and an
   * awaited promise is not itself a reason for Node to keep running. Unref
   * it and a run whose workers are all waiting on the rate gate - with no
   * socket open at that instant - exits the moment the loop drains, leaving
   * every queued caller unresolved and the command silently truncated.
   *
   * It cannot outlive the work either: `drain` clears it as soon as the
   * queue empties, so a pending wake timer always means a pending
   * `acquire()`. A caller that abandons queued acquires (an aborted solve)
   * must `dispose()` the limiter rather than rely on the timer expiring.
   */
  private scheduleWake(waitMs: number): void {
    this.clearWake();
    const delay = Math.max(1, Math.ceil(waitMs));
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.drain();
    }, delay);
  }

  private applyDecrease(): void {
    // The floor is normally MIN_RPS, but a model whose catalogue ceiling is
    // itself below MIN_RPS (e.g. a low RPM model) must never be floored
    // above its own ceiling - that would push rps past the ceiling on a
    // single 429 and `scheduleRecovery` would then see `rps >= ceilingRps`
    // and never schedule a step back down.
    const floor = Math.min(MIN_RPS, this.ceilingRps);
    const next = Math.max(floor, this.rps / 2);
    if (next !== this.rps) {
      this.rps = next;
      this.rpsGate.setRate(this.rps);
      this.emit?.({ type: 'rate:adjusted', model: this.model, rps: this.rps, reason: '429' });
    }
    this.scheduleRecovery();
  }

  private scheduleRecovery(): void {
    if (this.recoveryTimer !== undefined) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    if (this.rps >= this.ceilingRps) return;
    // Unref'd: recovery is pure background maintenance of `rps` - nobody
    // awaits it, and it re-arms itself every 10s until the ceiling is back,
    // so after a single 429 a ref'd timer would keep the process alive for
    // (ceilingRps - rps) / 0.5 * 10s past the end of the command (160s to
    // climb from 1 rps to 9 on a 600 RPM model). It still fires normally
    // while anything else keeps the loop alive.
    const timer = setTimeout(() => {
      this.recoveryTimer = undefined;
      this.rps = Math.min(this.ceilingRps, this.rps + RECOVERY_STEP_RPS);
      this.rpsGate.setRate(this.rps);
      this.emit?.({
        type: 'rate:adjusted',
        model: this.model,
        rps: this.rps,
        reason: 'recovery',
      });
      this.drain();
      this.scheduleRecovery();
    }, RECOVERY_INTERVAL_MS);
    unrefTimer(timer);
    this.recoveryTimer = timer;
  }
}

export interface RateLimiterOptions {
  /** 0.9 by default; applied to the catalogue RPM and TPM. */
  rpsFraction?: number;
  /** 8 by default (spec's tier-1 default; pass 16 for a tier-2 model). */
  maxConcurrency?: number;
  /** Receives `rate:adjusted` (level 2) whenever AIMD changes the rps. */
  emit?: Emit;
}

/** Process-wide, keyed by model id (spec: "Rate limiting"). */
const registry = new Map<string, RateLimiterImpl>();

/**
 * The per-model `RateLimiterRegistry`: repeated calls for the same model
 * return the same instance, so all callers - including parallel puzzles in
 * `bench` - share one rate gate and TPM bucket per model.
 */
export function getLimiter(model: string, opts: RateLimiterOptions = {}): RateLimiter {
  const existing = registry.get(model);
  if (existing !== undefined) return existing;

  const limits = limitsOf(model);
  const rpsFraction = opts.rpsFraction ?? DEFAULT_RPS_FRACTION;
  const maxConcurrency = opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const rps = (rpsFraction * limits.requestsPerMinute) / 60;
  const tpm = rpsFraction * limits.tokensPerMinute;

  const limiter = new RateLimiterImpl(model, rps, tpm, maxConcurrency, opts.emit);
  registry.set(model, limiter);
  return limiter;
}

/** Every test calls this in `beforeEach` (decision baked in). */
export function resetRegistryForTests(): void {
  for (const limiter of registry.values()) limiter.dispose();
  registry.clear();
}
