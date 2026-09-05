import { randomUUID } from 'node:crypto';

import { offlineMissError } from '../cli/exit.js';
import type { Emit } from '../events/types.js';
import { parseCandidateResponse, type ParseOutcome } from '../llm/parser.js';
import {
  promptKindFor,
  promptVersionOf,
  renderBatchedSeedPrompt,
  renderPrompt,
} from '../llm/prompts.js';
import { usdFor } from '../llm/pricing.js';
import { route } from '../llm/tierRouter.js';
import type {
  InferenceLog,
  InferenceLogRecord,
  LlmRequest,
  LlmResult,
  LlmTransport,
  TokenUsage,
} from '../llm/types.js';
import { constrainedSamplesOf, type Profile } from '../profiles/schema.js';
import { calibrate } from '../score/calibrate.js';
import { cacheKey, canonicalJson, sha1 } from '../util/hash.js';
import { log } from '../util/log.js';
import { validateCandidates } from '../validate/normalise.js';
import type { CacheEntry, CandidateCache } from './cache.js';
import type {
  Candidate,
  CandidateRequest,
  CandidateResponse,
  CandidateResult,
  CandidateService,
  PromptKind,
} from './types.js';

export interface CandidateServiceDeps {
  transport: LlmTransport;
  cache: CandidateCache;
  inferenceLog: InferenceLog;
  profile: Profile;
  emit: Emit;
  runId: string | null;
  puzzleId: string | null;
  /** A cache miss is fatal, exit 4 (B6). */
  offline: boolean;
  /** Implies offline, but returns an empty domain instead of exiting. */
  offlineLenient: boolean;
  /**
   * `xw solve --seed <n>` (B38), forwarded to the router, which passes it on
   * only when the catalogue advertises `seed` for the routed model.
   */
  seed?: number;
}

/**
 * What the service knows and `policy/escalation.ts` (T18) needs: the service
 * reports facts and never decides anything.
 */
export interface RunCandidateService extends CandidateService {
  /**
   * Cumulative tier-1 parse failures for that slot in this run, which is
   * `EscalationContext.parseFailures`. A batch element the parser could not
   * realign counts, as does each failed attempt of a single ask.
   */
  parseFailures(slotId: string): number;
}

/** The second attempt after a parse failure is always at temperature 0 (spec step 3). */
const RETRY_TEMPERATURE = 0;

/**
 * T71. What one extra sample agreeing on an answer is worth, added to the
 * best single-sample score of that answer and capped at 1.0. Agreement across
 * samples is the "sampling agreement" signal of docs/crossword-algorithms.md
 * (Calibration): with `rank` calibration a first-placed answer scores 0.5 and
 * a second-placed 0.333, so 0.15 a vote is enough for two samples agreeing on
 * their second choice to outrank one sample's unsupported first choice, and
 * not enough for a single lucky sample to be overtaken by noise.
 */
const VOTE_BONUS = 0.15;

interface Prepared {
  promptKind: PromptKind;
  model: string;
  inlineSchema: boolean;
  request: LlmRequest;
  key: string;
  batchSize: number;
}

/** One constrained sample's outcome, before the votes are merged (T71). */
interface SampleOutcome {
  /** Null when nothing came back at all: two parse failures, or an offline-lenient miss. */
  response: CandidateResponse | null;
  cacheHit: boolean;
  usage: TokenUsage | null;
}

function chunkInto<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * A batched call's tokens, divided between the clues it answered so that the
 * shares add back up to the call exactly (any remainder goes to the first
 * clue). Each clue's cache entry and inference record then carries its own
 * share, which is what keeps `usdCounterfactual` honest when only some of a
 * batch's keys are replayed later.
 */
function splitUsage(usage: TokenUsage, parts: number): TokenUsage[] {
  const share = (total: number, index: number): number => {
    const base = Math.floor(total / parts);
    return index === 0 ? total - base * (parts - 1) : base;
  };
  return Array.from({ length: parts }, (_unused, index) => {
    const out: TokenUsage = {
      promptTokens: share(usage.promptTokens, index),
      completionTokens: share(usage.completionTokens, index),
      totalTokens: share(usage.totalTokens, index),
    };
    if (usage.reasoningTokens !== undefined) {
      out.reasoningTokens = share(usage.reasoningTokens, index);
    }
    return out;
  });
}

/**
 * T71's vote merge over the accepted candidates of N constrained samples of
 * one slot: one entry per normalised answer, carrying how many samples
 * proposed it, the best single-sample score plus `VOTE_BONUS` for each
 * additional sample that agreed (capped at 1.0), and the rest of the fields
 * of whichever sample scored it best.
 *
 * `validate/normalise.ts` dedupes within a sample, so an answer appears at
 * most once per sample and `votes` is a count of samples, never of repeats
 * inside one list.
 *
 * The order is votes, then score, then the answer itself: a total order over
 * distinct answers, so the merged list is a function of the samples alone and
 * not of the order the map happened to be built in.
 */
function mergeSamples(samples: ReadonlyArray<ReadonlyArray<Candidate>>): Candidate[] {
  const byAnswer = new Map<string, { best: Candidate; votes: number }>();
  for (const sample of samples) {
    for (const candidate of sample) {
      const seen = byAnswer.get(candidate.answer);
      if (seen === undefined) {
        byAnswer.set(candidate.answer, { best: candidate, votes: 1 });
        continue;
      }
      seen.votes += 1;
      if (candidate.score > seen.best.score) seen.best = candidate;
    }
  }
  return [...byAnswer.values()]
    .map(({ best, votes }) => ({
      ...best,
      votes,
      score: Math.min(1, best.score + VOTE_BONUS * (votes - 1)),
    }))
    .sort((a, b) => {
      if (b.votes !== a.votes) return b.votes - a.votes;
      if (b.score !== a.score) return b.score - a.score;
      return a.answer < b.answer ? -1 : a.answer > b.answer ? 1 : 0;
    });
}

/** Element-wise sum of the usage blobs of several calls (T71); null when there are none. */
function sumUsage(usages: ReadonlyArray<TokenUsage>): TokenUsage | null {
  if (usages.length === 0) return null;
  const total: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let reasoning: number | undefined;
  for (const usage of usages) {
    total.promptTokens += usage.promptTokens;
    total.completionTokens += usage.completionTokens;
    total.totalTokens += usage.totalTokens;
    if (usage.reasoningTokens !== undefined) reasoning = (reasoning ?? 0) + usage.reasoningTokens;
  }
  if (reasoning !== undefined) total.reasoningTokens = reasoning;
  return total;
}

/** Reasoning tokens are billed as completion tokens unless measured otherwise (spec). */
function usdOf(model: string, usage: TokenUsage): number {
  return usdFor({
    model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    calls: 1,
  });
}

/** The parse errors attributable to one clue, including a whole-response failure. */
function parseErrorFor(outcome: ParseOutcome, slotId: string): string | null {
  const mine = outcome.failures
    .filter((failure) => failure.id === slotId || failure.id === null)
    .map((failure) => failure.error);
  return mine.length === 0 ? null : mine.join('; ');
}

/**
 * The ids the parser could not deliver. A whole-response failure arrives as one
 * failure with `id: null` and means every expected id failed (T11), and a
 * duplicate id appears in both `byId` and `failures`, so an id already answered
 * is never counted as failed.
 */
function failedIds(outcome: ParseOutcome, expectedIds: ReadonlyArray<string>): string[] {
  return expectedIds.filter((id) => !outcome.byId.has(id));
}

/**
 * T34. `getCandidates` is the solver's only route to the outside world, and it
 * does five things in order: cache lookup, tier routing, transport call, parse
 * (retrying once at temperature 0, whose different temperature gives it a
 * different cache key by B23), validation and calibration.
 *
 * It talks to an injected `LlmTransport` (B51), so it never opens a socket, and
 * it decides nothing: a parse failure, an empty domain and a low
 * `clue_understood` are reported as facts for `policy/escalation.ts` to weigh.
 */
export function createCandidateService(deps: CandidateServiceDeps): RunCandidateService {
  const { transport, cache, inferenceLog, profile, emit } = deps;
  // Which prompt template every render below uses (T65). Resolved once, here,
  // from the profile rather than from a module constant, because
  // `profile.promptVersion` is also the version the B23 cache key carries
  // (`keyFor` below) and the inference log records: reading the two from
  // different places is what would let one version's prompt bytes sit behind
  // another version's cache entry. An unrenderable value fails here, before any
  // call is made or any key is derived.
  const promptVersion = promptVersionOf(profile.promptVersion);
  // `--offline-lenient` implies `--offline`; it only changes what a miss does.
  const offline = deps.offline || deps.offlineLenient;
  const routeOptions = deps.seed === undefined ? {} : { seed: deps.seed };

  /** B43: every candidate ever returned for a slot in this run, in memory only. */
  const ledger = new Map<string, Candidate[]>();
  const parseFailureCount = new Map<string, number>();

  /**
   * The B23 key for one call, plus T71's reasoning effort when there is one.
   *
   * `request.maxTokens` and `request.temperature` are already B23 key fields,
   * so a constrained call's raised token budget separates its key from the
   * same call's key with reasoning off. The effort itself is not a member of
   * `CacheKeyInput` (`src/util/hash.ts` is a frozen contract module), so it
   * is folded in as a second hash over the B23 key: byte-identical to the
   * B23 key whenever no effort applies - which is every call every profile
   * made before T71, so every committed cache entry still matches - and
   * distinct per effort when one does, which is what stops a `medium` answer
   * being served to a `high` request.
   */
  function keyFor(
    req: CandidateRequest,
    model: string,
    promptKind: PromptKind,
    batchSize: number,
    request: LlmRequest,
    constrainedReasoningEffort: string | null = null,
  ): string {
    const key = cacheKey({
      model,
      promptVersion: profile.promptVersion,
      promptKind,
      clue: req.clue,
      enumeration: req.enumeration,
      length: req.length,
      pattern: req.pattern,
      style: req.style,
      title: req.title,
      n: req.n,
      samples: req.samples,
      sampleIndex: req.sampleIndex,
      batchSize,
      rejected: req.rejected,
      crossingContext: req.crossingContext ?? null,
      temperature: request.temperature,
      topP: request.topP,
      maxTokens: request.maxTokens,
    });
    if (constrainedReasoningEffort === null) return key;
    return sha1(canonicalJson({ key, reasoningEffort: constrainedReasoningEffort }));
  }

  /** Steps 1 and 2 for one clue: route, render, and derive the cache key. */
  function prepareSingle(req: CandidateRequest, temperature?: number): Prepared {
    const promptKind = promptKindFor(req.purpose);
    const routed = route(req, profile, routeOptions);
    const rendered = renderPrompt(req, promptKind, {
      inlineSchema: routed.inlineSchema,
      version: promptVersion,
    });
    const request: LlmRequest = { ...routed.request, messages: rendered.messages };
    if (temperature !== undefined) request.temperature = temperature;
    return {
      promptKind,
      model: routed.model,
      inlineSchema: routed.inlineSchema,
      request,
      key: keyFor(req, routed.model, promptKind, 1, request, routed.constrainedReasoningEffort),
      batchSize: 1,
    };
  }

  /** The same, for a whole batch: one prompt, one key per clue (B3, B23). */
  function prepareBatch(reqs: ReadonlyArray<CandidateRequest>): {
    prepared: Prepared;
    keys: string[];
  } {
    const first = reqs[0];
    if (first === undefined) throw new Error('prepareBatch: a batch needs at least one request');
    const routed = route(first, profile, routeOptions);
    const rendered = renderBatchedSeedPrompt(reqs, {
      inlineSchema: routed.inlineSchema,
      version: promptVersion,
    });
    const request: LlmRequest = { ...routed.request, messages: rendered.messages };
    const prepared: Prepared = {
      promptKind: rendered.promptKind,
      model: routed.model,
      inlineSchema: routed.inlineSchema,
      request,
      key: '',
      batchSize: reqs.length,
    };
    const keys = reqs.map((req) =>
      keyFor(req, routed.model, rendered.promptKind, reqs.length, request),
    );
    return { prepared, keys };
  }

  interface RecordInput {
    req: CandidateRequest;
    prepared: Prepared;
    key: string;
    batchIndex: number | null;
    attempt: number;
    cacheHit: boolean;
    call: LlmResult | null;
    usage: TokenUsage | null;
    parsed: CandidateResponse | null;
    parseError: string | null;
    error?: string | null;
  }

  /**
   * One record per clue per attempt. A cache hit is logged too, with
   * `request` and `rawResponse` null and the cached usage, which is what makes
   * `usdCounterfactual` computable for a replayed run (spec).
   */
  function writeRecord(input: RecordInput): void {
    const { req, prepared, call, usage } = input;
    const counterfactual = usage === null ? null : usdOf(prepared.model, usage);
    const billed = input.cacheHit || call === null ? 0 : (counterfactual ?? 0);
    const record: InferenceLogRecord = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      runId: deps.runId,
      puzzleId: deps.puzzleId,
      slotId: req.slotId,
      purpose: req.purpose,
      promptKind: prepared.promptKind,
      tier: req.tier,
      model: prepared.model,
      promptVersion: profile.promptVersion,
      cacheKey: input.key,
      cacheHit: input.cacheHit,
      batchSize: prepared.batchSize,
      // A hit made no call, so it has no position within one: the frozen
      // contract says `batchIndex` is null on a cache hit, and `xw report --by
      // batchIndex` counts positional samples with it. Nulled here, next to
      // `request` and `rawResponse`, so no call site can get it wrong.
      batchIndex: input.cacheHit ? null : input.batchIndex,
      sampleIndex: req.sampleIndex,
      request: input.cacheHit
        ? null
        : {
            messages: prepared.request.messages,
            temperature: prepared.request.temperature,
            maxTokens: prepared.request.maxTokens,
            topP: prepared.request.topP,
            responseFormat: prepared.request.responseFormat,
            extra: prepared.request.extra,
          },
      rawResponse: input.cacheHit ? null : (call?.text ?? null),
      parsed: input.parsed,
      parseError: input.parseError,
      httpStatus: call?.httpStatus ?? null,
      responseHeaders: call?.headers ?? {},
      attempt: input.attempt,
      usage,
      usdBilled: billed,
      usdCounterfactual: counterfactual,
      latencyMs: call?.latencyMs ?? null,
      error: input.error ?? null,
    };
    inferenceLog.write(record);
  }

  function entryFor(
    req: CandidateRequest,
    prepared: Prepared,
    key: string,
    response: CandidateResponse,
    usage: TokenUsage | null,
    latencyMs: number,
  ): CacheEntry {
    return {
      key,
      model: prepared.model,
      promptVersion: profile.promptVersion,
      promptKind: prepared.promptKind,
      clue: req.clue,
      length: req.length,
      pattern: req.pattern,
      style: req.style,
      sampleIndex: req.sampleIndex,
      batchSize: prepared.batchSize,
      response,
      usage,
      latencyMs,
      createdAt: new Date().toISOString(),
    };
  }

  function remember(slotId: string, candidates: ReadonlyArray<Candidate>): void {
    const known = ledger.get(slotId) ?? [];
    for (const candidate of candidates) {
      const at = known.findIndex((seen) => seen.answer === candidate.answer);
      if (at === -1) {
        known.push({ ...candidate });
        continue;
      }
      const seen = known[at];
      // The ledger keeps the strongest evidence for a letter, never merges
      // votes: two asks for the same slot are not two samples of one ask.
      if (seen !== undefined && candidate.score > seen.score) known[at] = { ...candidate };
    }
    ledger.set(slotId, known);
  }

  function noteParseFailure(slotId: string): void {
    parseFailureCount.set(slotId, (parseFailureCount.get(slotId) ?? 0) + 1);
  }

  function emitAsk(req: CandidateRequest, promptKind: PromptKind, batchIndex: number | null): void {
    emit({
      type: 'slot:ask',
      slotId: req.slotId,
      clue: req.clue,
      length: req.length,
      pattern: req.pattern,
      tier: req.tier,
      purpose: req.purpose,
      promptKind,
      batchIndex,
    });
  }

  /**
   * Steps 4 and 5 for one response: validate (emitting a `candidate:reject`
   * per drop) and calibrate. Split out of `finish` so that T71's sampled ask
   * can evaluate each sample on its own and still emit a single
   * `slot:candidates` for the merged list.
   */
  function evaluate(
    req: CandidateRequest,
    response: CandidateResponse,
    fromCache: boolean,
  ): Candidate[] {
    const validated = validateCandidates({
      raw: response.candidates,
      length: req.length,
      pattern: req.pattern,
      clue: req.clue,
      tier: req.tier,
      fromCache,
      rejected: req.rejected,
      // Spec: clue-echo rejection is waived when the slot would otherwise be
      // empty. T6 waives it only in exactly that case.
      allowEchoWhenEmpty: true,
    });
    for (const reject of validated.rejects) {
      emit({
        type: 'candidate:reject',
        slotId: req.slotId,
        answer: reject.answer,
        reason: reject.reason,
      });
    }
    if (validated.echoWaived) {
      // `src/events/types.ts` has no waiver event and is frozen for this task,
      // so the waiver is reported here instead; see the PR deviation note.
      log.debug(
        `candidate service: clue-echo rejection waived for ${req.slotId} ("${req.clue}"): every surviving candidate echoed the clue`,
      );
    }

    return calibrate(validated.accepted, {
      mode: profile.calibration,
      samples: profile.samples,
    });
  }

  /**
   * The other half of `finish`: put the candidates the slot ends up with into
   * the run ledger, announce them once, and shape the result. One call per
   * ask, whether that ask was one request or T71's N samples merged.
   */
  function deliver(
    req: CandidateRequest,
    candidates: ReadonlyArray<Candidate>,
    clueUnderstood: number,
    fromCache: boolean,
    usage: TokenUsage | null,
    notes?: string,
  ): CandidateResult {
    remember(req.slotId, candidates);
    emit({
      type: 'slot:candidates',
      slotId: req.slotId,
      accepted: candidates.map((c) => ({ answer: c.answer, score: c.score })),
      clueUnderstood,
      cacheHit: fromCache,
    });

    const result: CandidateResult = {
      candidates: [...candidates],
      clueUnderstood,
      cacheHit: fromCache,
    };
    if (notes !== undefined) result.notes = notes;
    if (usage !== null) result.usage = usage;
    return result;
  }

  /** Steps 4 and 5 for a single unsampled ask: evaluate, then deliver. */
  function finish(
    req: CandidateRequest,
    response: CandidateResponse,
    fromCache: boolean,
    usage: TokenUsage | null,
  ): CandidateResult {
    return deliver(
      req,
      evaluate(req, response, fromCache),
      response.clue_understood,
      fromCache,
      usage,
      response.notes,
    );
  }

  /** What a slot gets when nothing came back at all: an empty domain, not an error. */
  function emptyResult(req: CandidateRequest): CandidateResult {
    emit({
      type: 'slot:candidates',
      slotId: req.slotId,
      accepted: [],
      clueUnderstood: null,
      cacheHit: false,
    });
    return { candidates: [], clueUnderstood: 0, cacheHit: false };
  }

  function offlineMiss(req: CandidateRequest, key: string): never {
    throw offlineMissError(
      `offline: no cached response for ${req.slotId} "${req.clue}" (cache key ${key})`,
      'run once without --offline to populate the cache, or pass --offline-lenient to continue with an empty domain',
    );
  }

  async function lookup(req: CandidateRequest, key: string): Promise<CacheEntry | undefined> {
    const entry = await cache.get(key);
    emit({ type: 'cache:lookup', key, hit: entry !== undefined, slotId: req.slotId });
    return entry;
  }

  /**
   * B2. A cache hit costs nothing but is still a call the strategy made, so it
   * is reported on the same `llm:usage` event a cold call is, priced from the
   * usage blob the `CacheEntry` stored for exactly this purpose: `usdBilled`
   * is zero, `usdCounterfactual` is what the call would cost cold today, and
   * `cacheHit` is true so the recorder can tell them apart. Without this,
   * a profile that inherited another profile's cache reports near-zero cost
   * and wins the bench on run order alone.
   *
   * `latencyMs` is 0: no provider was waited on. An entry written before
   * usage was recorded (or by a transport that reported none) carries no
   * usage blob and so cannot be priced; nothing is emitted for it rather
   * than a fabricated zero.
   */
  function emitCachedUsage(model: string, entry: CacheEntry): void {
    const usage = entry.usage;
    if (usage === null) {
      log.debug(
        `candidate service: cache entry ${entry.key} has no usage blob; its cache hit cannot be priced counterfactually`,
      );
      return;
    }
    emit({
      type: 'llm:usage',
      model,
      usage,
      usdBilled: 0,
      usdCounterfactual: usdOf(model, usage),
      cacheHit: true,
      latencyMs: 0,
    });
  }

  async function callTransport(prepared: Prepared, slotId: string | null): Promise<LlmResult> {
    emit({
      type: 'llm:request',
      model: prepared.model,
      slotId,
      prompt: prepared.request.messages.map((m) => m.content).join('\n\n'),
    });
    const call = await transport.complete(prepared.request);
    emit({ type: 'llm:response', model: prepared.model, slotId, raw: call.text });
    const usd = usdOf(prepared.model, call.usage);
    emit({
      type: 'llm:usage',
      model: prepared.model,
      usage: call.usage,
      usdBilled: usd,
      usdCounterfactual: usd,
      // Emitted exactly once per cold call, so the run record can never
      // double-count it against `emitCachedUsage` above (B2).
      cacheHit: false,
      latencyMs: call.latencyMs,
    });
    return call;
  }

  /**
   * One clue, up to two attempts: the first at the profile's temperature, the
   * second at temperature 0 after a parse failure. Two failures return an empty
   * domain and leave `parseFailures` at 2, which is the tier-1 failure T18 acts
   * on.
   */
  async function askOnce(req: CandidateRequest): Promise<SampleOutcome> {
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      const prepared = prepareSingle(req, attempt === 0 ? undefined : RETRY_TEMPERATURE);
      const hit = await lookup(req, prepared.key);
      if (hit !== undefined) {
        emitCachedUsage(prepared.model, hit);
        writeRecord({
          req,
          prepared,
          key: prepared.key,
          batchIndex: null,
          attempt,
          cacheHit: true,
          call: null,
          usage: hit.usage,
          parsed: hit.response,
          parseError: null,
        });
        return { response: hit.response, cacheHit: true, usage: hit.usage };
      }

      if (offline) {
        if (deps.offlineLenient) return { response: null, cacheHit: false, usage: null };
        offlineMiss(req, prepared.key);
      }

      const call = await callTransport(prepared, req.slotId);
      const outcome = parseCandidateResponse(call.text, {
        batchSize: 1,
        expectedIds: [req.slotId],
      });
      for (const warning of outcome.warnings) {
        log.debug(`candidate service: ${req.slotId}: ${warning.warning}`);
      }
      const response = outcome.byId.get(req.slotId) ?? null;
      writeRecord({
        req,
        prepared,
        key: prepared.key,
        batchIndex: null,
        attempt,
        cacheHit: false,
        call,
        usage: call.usage,
        parsed: response,
        parseError: response === null ? parseErrorFor(outcome, req.slotId) : null,
      });

      if (response !== null) {
        // Negative results are cached in the same shape as positive ones, so a
        // known dead end is never re-paid for (spec).
        await cache.set(
          prepared.key,
          entryFor(req, prepared, prepared.key, response, call.usage, call.latencyMs),
        );
        return { response, cacheHit: false, usage: call.usage };
      }

      noteParseFailure(req.slotId);
    }

    return { response: null, cacheHit: false, usage: null };
  }

  /** One ask, one request: the pre-T71 path, and the path every seed ask takes. */
  async function askSingle(req: CandidateRequest): Promise<CandidateResult> {
    emitAsk(req, promptKindFor(req.purpose), null);
    const outcome = await askOnce(req);
    if (outcome.response === null) return emptyResult(req);
    return finish(req, outcome.response, outcome.cacheHit, outcome.usage);
  }

  /**
   * T71. One constrained ask (re-ask, repair or escalation) as `sampleCount`
   * requests whose accepted answers are merged by vote, for a profile that
   * sets `constrainedSamples` above 1. This is the "sampling agreement"
   * calibration of docs/crossword-algorithms.md applied where a crossword
   * solver can afford it: a constrained ask happens for a minority of slots
   * and is the ask whose answer the search is about to commit to, whereas
   * sampling every seed ask would multiply the whole run's cost (that knob is
   * `samples` with `calibration: 'votes'`, M6/T53, and it is untouched here).
   *
   * Each sample is a request in its own right - its own cache key, its own
   * `slot:ask` event, its own inference-log record, its own temperature-0
   * retry on a parse failure - and the samples are issued one after another
   * rather than concurrently, so the event and log order of a sampled ask is
   * a function of the samples alone and not of which call returned first.
   *
   * The sample index is `req.sampleIndex * sampleCount + i`: 0..N-1 for the
   * usual repeat index 0, and a disjoint block for every further repeat of a
   * bench, so two repeats of the same puzzle never share a constrained key
   * (which is the whole point of `--repeat` feeding `sampleIndex`).
   *
   * Only the merged list is announced: one `slot:candidates` for the ask, as
   * the unsampled path emits. A sample that came back with nothing at all
   * (two parse failures, or an offline-lenient miss) contributes no votes and
   * does not sink the ask; only every sample failing yields an empty domain.
   */
  async function askSampled(req: CandidateRequest, sampleCount: number): Promise<CandidateResult> {
    const promptKind = promptKindFor(req.purpose);
    const accepted: Candidate[][] = [];
    const clueUnderstood: number[] = [];
    const cachedUsage: TokenUsage[] = [];
    const coldUsage: TokenUsage[] = [];
    let notes: string | undefined;
    let everySampleCached = true;

    for (let index = 0; index < sampleCount; index += 1) {
      const sample: CandidateRequest = {
        ...req,
        sampleIndex: req.sampleIndex * sampleCount + index,
      };
      emitAsk(sample, promptKind, null);
      const outcome = await askOnce(sample);
      if (!outcome.cacheHit) everySampleCached = false;
      if (outcome.usage !== null) {
        (outcome.cacheHit ? cachedUsage : coldUsage).push(outcome.usage);
      }
      if (outcome.response === null) continue;
      accepted.push(evaluate(sample, outcome.response, outcome.cacheHit));
      clueUnderstood.push(outcome.response.clue_understood);
      if (notes === undefined && outcome.response.notes !== undefined) {
        notes = outcome.response.notes;
      }
    }

    if (accepted.length === 0) return emptyResult(req);

    // What the caller is charged for. A hit is billed nothing (B2, and
    // `solver/hooks.ts` skips a result flagged `cacheHit`), so a mixed ask
    // reports the cold samples' tokens only, and an ask served entirely from
    // cache reports the cached blobs - which is exactly what the unsampled
    // path does for its one call in each of those two cases.
    const usage = everySampleCached ? sumUsage(cachedUsage) : sumUsage(coldUsage);
    const meanClueUnderstood =
      clueUnderstood.reduce((sum, value) => sum + value, 0) / clueUnderstood.length;

    return deliver(
      req,
      mergeSamples(accepted),
      meanClueUnderstood,
      everySampleCached,
      usage,
      notes,
    );
  }

  /**
   * One batched seed call for a whole chunk. Every clue's result is stored
   * under its own key with `batchSize` set to the chunk length, so a batch-1
   * and a batch-3 answer for the same clue can never be mistaken for each
   * other (B23); any element the parser could not deliver is re-asked singly,
   * and so is any element the chunk's cache lookup missed, so a chunk that has
   * lost one element costs that one clue and never the whole chunk again.
   */
  async function askBatch(reqs: ReadonlyArray<CandidateRequest>): Promise<Map<string, CandidateResult>> {
    const results = new Map<string, CandidateResult>();
    const { prepared, keys } = prepareBatch(reqs);
    reqs.forEach((req, index) => {
      emitAsk(req, prepared.promptKind, index);
    });

    const hits: Array<CacheEntry | undefined> = [];
    for (const [index, req] of reqs.entries()) {
      const key = keys[index] ?? '';
      hits.push(await lookup(req, key));
    }

    const serveHit = (req: CandidateRequest, index: number, hit: CacheEntry): void => {
      emitCachedUsage(prepared.model, hit);
      writeRecord({
        req,
        prepared,
        key: keys[index] ?? '',
        // Null, not `index`: nothing was asked for this clue (spec, and
        // `InferenceLogRecord.batchIndex`), exactly as the single-clue hit
        // path records it.
        batchIndex: null,
        attempt: 0,
        cacheHit: true,
        call: null,
        usage: hit.usage,
        parsed: hit.response,
        parseError: null,
      });
      results.set(req.slotId, finish(req, hit.response, true, hit.usage));
    };

    if (hits.every((hit) => hit !== undefined)) {
      reqs.forEach((req, index) => {
        const hit = hits[index];
        if (hit !== undefined) serveHit(req, index, hit);
      });
      return results;
    }

    if (offline) {
      const missAt = hits.findIndex((hit) => hit === undefined);
      const missed = reqs[missAt];
      if (!deps.offlineLenient && missed !== undefined) offlineMiss(missed, keys[missAt] ?? '');
      // Lenient: whatever is cached is still served; only the misses degrade.
      reqs.forEach((req, index) => {
        const hit = hits[index];
        if (hit === undefined) results.set(req.slotId, emptyResult(req));
        else serveHit(req, index, hit);
      });
      return results;
    }

    if (hits.some((hit) => hit !== undefined)) {
      // A partially cached chunk is never re-asked whole. The key's `batchSize`
      // has to describe the prompt that produced the answer, so narrowing the
      // batched prompt would invalidate the chunk's keys; instead each hit is
      // served from cache and each miss is asked singly under its own batch-1
      // key, exactly as the offline-lenient and parser-failure paths do. A
      // missing element then costs that clue only ("Batching clues per
      // request"), and a clue already cached is never re-paid for nor
      // overwritten by a later run of the same chunk.
      for (const [index, req] of reqs.entries()) {
        const hit = hits[index];
        if (hit === undefined) results.set(req.slotId, await askSingle(req));
        else serveHit(req, index, hit);
      }
      return results;
    }

    const call = await callTransport(prepared, null);
    const expectedIds = reqs.map((req) => req.slotId);
    const outcome = parseCandidateResponse(call.text, {
      batchSize: reqs.length,
      expectedIds,
    });
    for (const warning of outcome.warnings) {
      log.debug(`candidate service: ${warning.id ?? 'batch'}: ${warning.warning}`);
    }

    const usages = splitUsage(call.usage, reqs.length);
    const failed = new Set(failedIds(outcome, expectedIds));

    for (const [index, req] of reqs.entries()) {
      const key = keys[index] ?? '';
      const usage = usages[index] ?? null;
      const response = outcome.byId.get(req.slotId) ?? null;
      writeRecord({
        req,
        prepared,
        key,
        batchIndex: index,
        attempt: 0,
        cacheHit: false,
        call,
        usage,
        parsed: response,
        parseError: response === null ? parseErrorFor(outcome, req.slotId) : null,
      });
      if (response === null) {
        noteParseFailure(req.slotId);
        continue;
      }
      await cache.set(key, entryFor(req, prepared, key, response, usage, call.latencyMs));
      results.set(req.slotId, finish(req, response, false, usage));
    }

    for (const req of reqs) {
      if (!failed.has(req.slotId)) continue;
      results.set(req.slotId, await askSingle(req));
    }
    return results;
  }

  return {
    getCandidates(req: CandidateRequest): Promise<CandidateResult> {
      // T71: `constrainedSamples` applies to the constrained and escalate
      // templates only - a seed ask is never sampled here.
      const sampleCount = constrainedSamplesOf(profile);
      if (sampleCount > 1 && promptKindFor(req.purpose) !== 'seed') {
        return askSampled(req, sampleCount);
      }
      return askSingle(req);
    },

    async getCandidatesBatch(
      reqs: ReadonlyArray<CandidateRequest>,
    ): Promise<Map<string, CandidateResult>> {
      const offender = reqs.find((req) => req.purpose !== 'seed');
      if (offender !== undefined) {
        // B3: a batched re-ask would mix slots whose patterns are changing
        // under each other mid-search.
        throw new Error(
          `getCandidatesBatch: batching applies to purpose "seed" only (B3), got "${offender.purpose}" for ${offender.slotId}`,
        );
      }

      const results = new Map<string, CandidateResult>();
      const size = Math.max(1, profile.batchSize);
      for (const group of chunkInto(reqs, size)) {
        const first = group[0];
        if (group.length === 1 && first !== undefined) {
          // A chunk of one is the `batchSize: 1` case of the same schema, and
          // takes the single-clue path so it can use the temperature-0 retry.
          results.set(first.slotId, await askSingle(first));
          continue;
        }
        for (const [slotId, result] of await askBatch(group)) results.set(slotId, result);
      }
      return results;
    },

    peek(slotId: string): Candidate[] {
      return (ledger.get(slotId) ?? []).map((candidate) => ({ ...candidate }));
    },

    parseFailures(slotId: string): number {
      return parseFailureCount.get(slotId) ?? 0;
    },
  };
}
