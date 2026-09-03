import type { CandidateRequest, CandidateResult, Tier } from '../candidates/types.js';
import type { CostSummaryEvent, Emit, EmittedEvent, Phase } from '../events/types.js';
import { patternMatches } from '../grid/pattern.js';
import { usdFor } from '../llm/pricing.js';
import type { BudgetCap } from '../policy/types.js';
import type { Profile } from '../profiles/schema.js';
import type { Puzzle, PuzzleStyle, Slot } from '../puzzle/types.js';
import type { Accuracy } from '../eval/types.js';
import { log } from '../util/log.js';
import { marginOf } from './ordering.js';
import type {
  Ac3Result,
  RepairOptions,
  RepairResult,
  SearchResult,
  SolveDeps,
  SolveOptions,
  SolveResult,
} from './types.js';

/**
 * T44: the 8 steps in order, with the event emissions the spec's pipeline
 * section brackets. Hitting a budget cap emits `budget:hit`, ends the current
 * phase gracefully and proceeds to the next; it never throws and never skips
 * step 8.
 *
 * What this module owns and what it delegates. Every collaborator arrives
 * through `SolveDeps` (T0), so nothing here constructs a transport, a service,
 * a search or a repair pass: the CLI (T45) is the composition root. What is
 * left is the orchestration itself - the phase brackets, the seed pass, the
 * budget observations, the last-resort fill the search leaves behind, and the
 * terminal `score:final` / `cost:summary` / `grid:final` / `run:end` block.
 *
 * Phase events are this module's alone. AC-3 (T36), the search (T37) and the
 * repair pass (T42) emit their own detail events and no `phase:start` /
 * `phase:end`, so the bracket around each of the five phases is emitted here
 * and is the same shape for every profile - including `repair.enabled: false`,
 * which still brackets an empty repair phase.
 */

/**
 * The prepass arc cap, passed explicitly on every call. The frozen
 * `Ac3Options` doc comment reads "0 or undefined means no cap" while T36
 * implements undefined as its own 50,000 default, so the number is stated here
 * rather than left to whichever reading the callee took.
 */
const AC3_MAX_ARCS = 50_000;

/** B37: at most one `progress` between phase transitions per this many ms. */
const PROGRESS_INTERVAL_MS = 250;

/** The run-global spend caps: crossing one stops this module spending. */
const SPEND_CAPS: ReadonlySet<BudgetCap> = new Set(['usd', 'tokens', 'wallMs']);

type PerTierCost = CostSummaryEvent['perTier'];

type EmittedOf<K extends EmittedEvent['type']> = Extract<EmittedEvent, { type: K }>;

/**
 * `phase:start` / `phase:end` plus the `skipped` flag a disabled repair pass
 * carries (this task's acceptance 5). `SolverEvent` is frozen and has no such
 * field, so it is added as an optional property: the object stays assignable
 * to the frozen event, a renderer that does not know the field ignores it, and
 * a `.events.jsonl` written today keeps it for whenever the contract gains
 * `skipped?: boolean`.
 */
interface SkippablePhaseStart extends EmittedOf<'phase:start'> {
  skipped?: boolean;
}

interface SkippablePhaseEnd extends EmittedOf<'phase:end'> {
  skipped?: boolean;
}

/**
 * `run:end` plus the message of the error that ended the run. Added the same
 * way and for the same reason as `skipped` above: `RunEndEvent` carries only
 * `status`, which is why T17's run recorder leaves `RunRecord.error` unset
 * ("no event on the stream carries an error message"). Emitting it here means
 * the message is on the stream the day the contract gains the field.
 */
interface RunEndWithError extends EmittedOf<'run:end'> {
  error?: string;
}

/**
 * `SolveDeps` (T0) plus what the orchestration needs and the frozen record
 * does not carry. Every addition is optional, so `solve` stays assignable to
 * the frozen `SolveFn` and a caller holding only the contract type can still
 * call it.
 *
 * Wiring rules for T45, which assembles the real thing:
 *
 *  - **One inference record per call.** Both `CandidateService` (T34) and the
 *    Nebius transport (T33) write an `InferenceLogRecord` for a cold call, so
 *    wiring both to a live sink double-logs every call. The service's record
 *    is the richer one (it alone knows `purpose`, `promptKind`, `cacheKey` and
 *    `slotId`), so construct the transport with its inference log disabled
 *    (`InferenceLogOptions.enabled: false`, or a no-op sink) and give the real
 *    sink to the service.
 *  - **One emit.** Pass the bus's `emit` to the service, the hooks and to
 *    `deps.emit`, so the service's `slot:ask` / `llm:usage` events and this
 *    module's phase events land on the same ordered stream.
 *  - **One budget.** `hooks.chargeBudget` is the only handle this module has
 *    on the run's `BudgetTracker`, so the hooks must be built over the same
 *    tracker the rest of the run charges. Build a second one and the seed
 *    pass's spend will not count towards the search's caps, and `run:end`
 *    will report `ok` for a run that blew its budget.
 *  - **`costs`.** This module prices only the calls it makes itself (the seed
 *    pass). A run's full per-tier cost lives on the `llm:usage` events the
 *    service emits directly to the bus, which never pass through here, so pass
 *    `costs` (a tally kept by subscribing to `llm:usage`) when `cost:summary`
 *    must account for re-asks, escalations and repair calls too. T17's run
 *    record derives its own figures from the same events either way.
 */
export interface SolveOrchestrationDeps extends SolveDeps {
  /**
   * The puzzle behind `deps.grid`. `Grid` deliberately holds no style, title,
   * block map or numbering, and all four are needed: the first two by every
   * `CandidateRequest`, the last two by `grid:init` (B32). Without it the
   * block map and the numbering are derived from the slots, which is exact for
   * any grid whose white cells all belong to a slot and reads an unclued run
   * as blocks otherwise.
   */
  puzzle?: Puzzle;
  /** Injected so a test can drive the 250 ms progress rule without waiting (B37). */
  now?: () => number;
  /** The run's full per-tier cost, when the caller tracks it (see above). */
  costs?: () => PerTierCost;
}

/**
 * `SolveResult` (T0) plus the message of the error that ended the run, which
 * the frozen record has nowhere to put. `errorCause` is the original throw:
 * `CliError`s carry the exit code the CLI must exit with (an offline miss is
 * 4, a provider failure 5, B6), and this is the only way T45 can honour them
 * once this module has swallowed the error to keep its promise that step 8
 * always runs.
 */
export interface SolveOrchestrationResult extends SolveResult {
  error?: string;
  errorCause?: unknown;
}

/**
 * The values a phase that never ran contributes to `SolveResult`. Fresh
 * objects rather than shared constants, so a caller that mutates a result
 * cannot reach into the next run.
 */
function emptyAc3(): Ac3Result {
  return { arcsVisited: 0, reductions: 0, wipeouts: [] };
}

function emptyRepair(): RepairResult {
  return { proposals: 0, accepted: 0, callsUsed: 0 };
}

function emptyAccuracy(): Accuracy {
  return { letters: 0, words: 0, perfect: false, emptyCells: 0 };
}

function emptySearch(): SearchResult {
  return {
    complete: false,
    assigned: 0,
    backtracks: 0,
    discrepancies: 0,
    wipeouts: 0,
    ldsRestarts: 0,
    emptySlotIds: [],
  };
}

function newTierCost(): PerTierCost {
  return {
    tier1: { calls: 0, usdBilled: 0, usdCounterfactual: 0 },
    tier2: { calls: 0, usdBilled: 0, usdCounterfactual: 0 },
  };
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return JSON.stringify(cause) ?? 'unknown error';
}

/**
 * B38: `--seed` seeds only this local PRNG, which is the search's tie-break
 * source. mulberry32, chosen because it is four lines and deterministic across
 * platforms; an unseeded run falls back to `Math.random`.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The 8 steps of the spec's "Solver pipeline", in order.
 *
 * Assignable to the frozen `SolveFn`: `SolveOrchestrationDeps` only adds
 * optional properties and `SolveOrchestrationResult` only adds optional
 * fields, so a caller typed against `SolveDeps` / `SolveResult` is unaffected.
 */
export async function solve(
  deps: SolveOrchestrationDeps,
  profile: Profile,
  opts: SolveOptions,
): Promise<SolveOrchestrationResult> {
  const { grid, domains, service, hooks, wordList, emit: rawEmit } = deps;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const slots: Slot[] = [...grid.slots.values()];
  const total = slots.length;
  const style: PuzzleStyle = deps.puzzle?.style ?? 'unknown';
  const title = deps.puzzle?.title;
  const rng = opts.seed === null ? Math.random : mulberry32(opts.seed);

  const cost = newTierCost();
  /**
   * True once any cap has been reported, whoever reported it. It is what makes
   * `run:end` report `partial` rather than `ok`, and there are three routes to
   * it, because this module holds no budget tracker of its own:
   *
   *  - A cap returned by a charge made here (the seed pass, and the
   *    `chargeBudget` handed to the repair pass).
   *  - The wall-clock observation at every phase transition. This is the one
   *    that catches a cap crossed *inside* another module: T38's hooks emit
   *    `budget:hit` on the bus directly rather than through the `emit` this
   *    module wraps, so the event itself is not visible here, but T19's
   *    tracker re-evaluates every run-global cap on any evaluation, so the
   *    next transition's observation returns the crossed cap.
   *  - A `budget:hit` that does arrive through this module's `emit`, which is
   *    the case for anything given the `emit` passed to `deps.ac3`,
   *    `deps.search` or `deps.repair`.
   *
   * Phase-scoped counters (`backtracks`, `repairCalls`) are never surfaced by
   * an observation - T19 checks them only when they are the cap charged - so
   * an exhausted `backtracks` allowance is noticed from the search's own
   * result instead.
   */
  let budgetHit = false;
  /** Set when a run-global *spend* cap is crossed: this module stops calling. */
  let spendingStopped = false;
  let currentPhase: Phase = 'seed';
  let lastProgressAt = startedAt;

  const emit: Emit = (event) => {
    if (event.type === 'budget:hit') budgetHit = true;
    rawEmit(event);
  };

  function noteCap(cap: BudgetCap | null): void {
    if (cap === null) return;
    budgetHit = true;
    // The `budget:hit` event belongs to whoever holds the tracker (T38's
    // hooks emit it once per cap); emitting it here as well would double it.
    if (SPEND_CAPS.has(cap)) spendingStopped = true;
  }

  function countAssigned(): number {
    let count = 0;
    for (const slot of slots) {
      if (grid.assignmentOf(slot.id) !== undefined) count += 1;
    }
    return count;
  }

  function emitProgress(force: boolean): void {
    const at = now();
    if (!force && at - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = at;
    emit({
      type: 'progress',
      phase: currentPhase,
      assigned: countAssigned(),
      total,
      elapsedMs: at - startedAt,
      usd: cost.tier1.usdBilled + cost.tier2.usdBilled,
    });
  }

  /**
   * One phase, bracketed. `phase:end` is emitted from a `finally`, so a phase
   * whose body throws still closes its bracket before the error is caught and
   * turned into the run's terminal status.
   */
  async function runPhase<T>(phase: Phase, body: () => Promise<T>, skipped = false): Promise<T> {
    const phaseStartedAt = now();
    currentPhase = phase;
    const start: SkippablePhaseStart = { type: 'phase:start', phase };
    if (skipped) start.skipped = true;
    emit(start);
    // B37: a `progress` on every phase transition, whatever the 250 ms rule
    // would say.
    emitProgress(true);
    // The wall clock accrues on its own, so it is observed rather than
    // charged (T19); the observation also surfaces any other run-global cap
    // crossed since the last charge.
    //
    // B38/B49: this is the only reading of the wall clock in the pipeline that
    // can reach an output field (a crossed `wallMs` sets `budgetHit`, which
    // turns `run:end` from `ok` into `partial`), and T19 re-evaluates `wallMs`
    // on *every* charge besides. Neither is disabled here: an offline replay
    // instead gets an uncapped `wallMs` from the composition root
    // (`src/cli/solve.ts`), which is the one place that knows the run is a
    // replay. `progress` events still carry real elapsed times; they are
    // reporting only and never feed a decision.
    noteCap(hooks.chargeBudget('wallMs', 0).exceeded);
    try {
      return await body();
    } finally {
      const end: SkippablePhaseEnd = {
        type: 'phase:end',
        phase,
        durationMs: now() - phaseStartedAt,
      };
      if (skipped) end.skipped = true;
      emit(end);
    }
  }

  // -------------------------------------------------------------------------
  // Step 1. Load. The grid, the slots and the empty domain store arrive built.
  // -------------------------------------------------------------------------

  function blockMap(): boolean[][] {
    const puzzle = deps.puzzle;
    if (puzzle !== undefined) return puzzle.cells.map((row) => row.map((cell) => cell.block));
    const letters = grid.snapshot().letters;
    const covered = new Set<string>();
    for (const slot of slots) {
      for (const [row, col] of slot.cells) covered.add(`${row},${col}`);
    }
    return letters.map((row, rowIndex) => row.map((_cell, col) => !covered.has(`${rowIndex},${col}`)));
  }

  function numberMap(): (number | null)[][] {
    const puzzle = deps.puzzle;
    if (puzzle !== undefined) {
      return puzzle.cells.map((row) => row.map((cell) => cell.number ?? null));
    }
    const letters = grid.snapshot().letters;
    const numbers = new Map<string, number>();
    for (const slot of slots) numbers.set(`${slot.row},${slot.col}`, slot.number);
    return letters.map((row, rowIndex) =>
      row.map((_cell, col) => numbers.get(`${rowIndex},${col}`) ?? null),
    );
  }

  function emitGridInit(): void {
    const letters = grid.snapshot().letters;
    emit({
      type: 'grid:init',
      width: letters[0]?.length ?? 0,
      height: letters.length,
      blocks: blockMap(),
      numbers: numberMap(),
      slots: slots.map((slot) => ({
        id: slot.id,
        row: slot.row,
        col: slot.col,
        length: slot.length,
        direction: slot.direction,
        clue: slot.clue,
      })),
    });
  }

  // -------------------------------------------------------------------------
  // Step 2. Seed.
  // -------------------------------------------------------------------------

  function seedRequest(slot: Slot): CandidateRequest {
    return {
      slotId: slot.id,
      clue: slot.clue,
      length: slot.length,
      pattern: grid.patternFor(slot.id),
      style,
      enumeration: slot.enumeration,
      title,
      rejected: [],
      tier: 1,
      purpose: 'seed',
      n: profile.candidatesPerAsk,
      samples: profile.samples,
      // B1: the repeat index is the sample index, so `--repeat N` takes a
      // fresh sample per repeat instead of re-reading repeat 1's cache entry.
      sampleIndex: opts.repeatIndex,
    };
  }

  /**
   * Tokens and USD for a call this module made, against the same tracker the
   * hooks charge (the only handle `SolveDeps` gives it). A cache hit is billed
   * nothing and charged nothing, but is still priced into
   * `usdCounterfactual` (B2).
   */
  function chargeCall(tier: Tier, result: CandidateResult): void {
    const usage = result.usage;
    if (usage === undefined) return;
    const model = tier === 1 ? profile.tier1 : profile.tier2;
    const usd = usdFor({
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      calls: 1,
    });
    const tally = tier === 1 ? cost.tier1 : cost.tier2;
    tally.calls += 1;
    tally.usdCounterfactual += usd;
    if (result.cacheHit) return;
    tally.usdBilled += usd;
    if (usage.totalTokens > 0) {
      noteCap(hooks.chargeBudget('tokens', usage.totalTokens).exceeded);
    }
    if (usd > 0) noteCap(hooks.chargeBudget('usd', usd).exceeded);
  }

  /**
   * One tier-1 ask per slot with the empty pattern. The pass has no
   * concurrency cap of its own - the per-model rate limiter is the only gate
   * (B5) - so every request is in flight at once and the results are folded in
   * afterwards, in slot order, so the event stream does not depend on which
   * call returned first.
   *
   * `getCandidatesBatch` is used when `profile.batchSize > 1` and single calls
   * otherwise (B3); the service does its own chunking, so the whole request
   * list goes in one call.
   *
   * Every return is put to the escalation policy through
   * `hooks.onCandidatesReturned` (B13), which is what puts a slot that is
   * empty after validation on the escalation queue immediately (step 2).
   */
  async function seedPhase(): Promise<void> {
    const requests = slots.map((slot) => seedRequest(slot));
    const results = new Map<string, CandidateResult>();

    if (profile.batchSize > 1) {
      const batched = await service.getCandidatesBatch(requests);
      for (const request of requests) {
        const result = batched.get(request.slotId);
        if (result !== undefined) results.set(request.slotId, result);
      }
    } else {
      const settled = await Promise.all(
        requests.map((request) => service.getCandidates(request)),
      );
      requests.forEach((request, index) => {
        const result = settled[index];
        if (result !== undefined) results.set(request.slotId, result);
      });
    }

    for (const request of requests) {
      const result = results.get(request.slotId);
      // A batch element the service could not deliver at all leaves the slot
      // with no domain, which is the same state as a validated-away one.
      if (result === undefined) continue;
      domains.setBase(request.slotId, result.candidates);
      chargeCall(1, result);
      emitProgress(false);
      // Ending the phase gracefully on a crossed spend cap: the calls already
      // in flight are folded in, and no further spending is asked for.
      if (spendingStopped) continue;
      await hooks.onCandidatesReturned(request.slotId, result);
    }
  }

  // -------------------------------------------------------------------------
  // Steps 4-6. Search, re-ask and escalation (T37 and T38 own the loop).
  // -------------------------------------------------------------------------

  /**
   * The last-resort fill for the slots the search handed back unassigned.
   *
   * T37 calls `hooks.onSearchTermination` exactly once and ignores what it
   * returns, so acting on it is this module's job: a termination-pass re-ask
   * or escalation merges into the base domain, and the slot is still
   * unassigned. T18's trigger 5 only fires for a slot whose domain is empty at
   * termination, so a slot can also arrive here with a perfectly good live
   * domain and no assignment (the search restores its best partial fill before
   * terminating). Either way the top candidate that fits the pattern the grid
   * now holds is assigned, and a slot with nothing that fits is left for the
   * repair pass's word-list fill.
   */
  function fillFromDomains(emptySlotIds: readonly string[]): void {
    for (const slotId of emptySlotIds) {
      if (grid.assignmentOf(slotId) !== undefined) continue;
      const pattern = grid.patternFor(slotId);
      const viable = domains.get(slotId).filter((c) => patternMatches(pattern, c.answer));
      if (viable.length === 0) continue;
      const best = viable.reduce((a, b) => (b.score > a.score ? b : a));
      try {
        grid.assign(slotId, best.answer);
      } catch (cause) {
        // Only a crossing conflict can land here, and the pattern filter above
        // makes that unreachable; a changed grid must never end the run.
        log.debug(`solve: could not fill ${slotId} with "${best.answer}": ${messageOf(cause)}`);
        continue;
      }
      emit({
        type: 'search:assign',
        slotId,
        answer: best.answer,
        score: best.score,
        margin: marginOf(viable),
        tier: best.tier,
        producedBy: `tier${best.tier}`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // The pipeline.
  // -------------------------------------------------------------------------

  emit({
    type: 'run:start',
    puzzleId: opts.puzzleId,
    profileName: profile.name,
    models: { tier1: profile.tier1, tier2: profile.tier2 },
    seed: opts.seed,
  });
  emitGridInit();

  let ac3Result: Ac3Result = emptyAc3();
  let searchResult: SearchResult = emptySearch();
  let repairResult: RepairResult = emptyRepair();
  let accuracy: Accuracy = emptyAccuracy();
  let error: string | undefined;
  let errorCause: unknown;

  try {
    await runPhase('seed', seedPhase);

    await runPhase('prepass', () => {
      ac3Result = deps.ac3(grid, domains, emit, { maxArcs: AC3_MAX_ARCS });
      return Promise.resolve();
    });

    await runPhase('search', async () => {
      searchResult = await deps.search(grid, domains, hooks, emit, {
        ordering: profile.search.ordering,
        ldsLimitStart: profile.search.ldsLimitStart,
        ldsLimitMax: profile.search.ldsLimitMax,
        maxBacktracks: profile.search.maxBacktracks,
        rng,
      });
      // `backtracks` is a phase-scoped cap (T19) and T37 stops *at* the limit
      // rather than past it, so `charge` never reports it exceeded and no
      // `budget:hit` is emitted for it. A search that ended on the cap without
      // completing is a partial run, so it is noticed here instead.
      if (
        !searchResult.complete &&
        profile.search.maxBacktracks > 0 &&
        searchResult.backtracks >= profile.search.maxBacktracks
      ) {
        budgetHit = true;
      }
      fillFromDomains(searchResult.emptySlotIds);
    });

    // -----------------------------------------------------------------------
    // Step 7. Repair. Disabled means no repair work at all, but the phase is
    // still bracketed (with `skipped`), so the event stream has the same shape
    // for every profile.
    // -----------------------------------------------------------------------
    const repairEnabled = profile.repair.enabled;
    await runPhase(
      'repair',
      async () => {
        if (!repairEnabled) return;
        const repairOpts: RepairOptions & {
          chargeBudget: (cap: BudgetCap, amount: number) => { exceeded: BudgetCap | null };
          style: PuzzleStyle;
          title?: string;
          candidatesPerAsk: number;
          samples: number;
          sampleIndex: number;
        } = {
          enabled: true,
          maxCalls: profile.repair.maxCalls,
          maxEditDistance: profile.repair.maxEditDistance === 1 ? 1 : 2,
          // T42 charges one `repairCalls` unit per scoring call through this
          // and ends its own phase on a reported cap.
          chargeBudget: (cap, amount) => {
            const result = hooks.chargeBudget(cap, amount);
            noteCap(result.exceeded);
            return result;
          },
          style,
          title,
          candidatesPerAsk: profile.candidatesPerAsk,
          samples: profile.samples,
          sampleIndex: opts.repeatIndex,
        };
        // A repair pass that spends all its calls is not by itself a partial
        // run - the fill it produced may well be complete - so, unlike the
        // search's `backtracks`, an exhausted `repairCalls` counter is left to
        // the `budget:hit` the hooks emit if it is genuinely exceeded.
        repairResult = await deps.repair(grid, service, wordList, emit, repairOpts);
      },
      !repairEnabled,
    );
  } catch (cause) {
    // Nothing a phase throws escapes: the run ends with `status: "error"` and
    // step 8 still runs, so a partial fill is still measured. The original
    // throw is handed back on the result, because a `CliError` carries the
    // exit code the CLI has to honour (B6).
    error = messageOf(cause);
    errorCause = cause;
    log.error(`solve: ${error}`);
  }

  // -------------------------------------------------------------------------
  // Step 8. Score. Always runs: after a budget hit, after an error, and over
  // an empty grid.
  // -------------------------------------------------------------------------
  const snapshot = await runPhase('score', () => {
    const taken = grid.snapshot();
    try {
      accuracy = deps.score(taken);
    } catch (cause) {
      // A scorer that cannot read its solution must not cost the run its
      // terminal events either.
      if (error === undefined) {
        error = messageOf(cause);
        errorCause = cause;
      }
      log.error(`solve: scoring failed: ${messageOf(cause)}`);
    }
    emit({ type: 'score:final', accuracy });
    emit({ type: 'cost:summary', perTier: deps.costs?.() ?? cost });
    emit({ type: 'grid:final', letters: taken.letters });
    return Promise.resolve(taken);
  });

  const wallMs = now() - startedAt;
  const status =
    error !== undefined ? 'error' : budgetHit || !grid.isComplete() ? 'partial' : 'ok';
  const runEnd: RunEndWithError = { type: 'run:end', status, wallMs };
  if (error !== undefined) runEnd.error = error;
  emit(runEnd);

  const result: SolveOrchestrationResult = {
    status,
    snapshot,
    accuracy,
    ac3: ac3Result,
    search: searchResult,
    repair: repairResult,
    wallMs,
  };
  if (error !== undefined) {
    result.error = error;
    result.errorCause = errorCause;
  }
  return result;
}
