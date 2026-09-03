import { randomUUID } from 'node:crypto';

import { offlineMissError } from '../cli/exit.js';
import type { Emit } from '../events/types.js';
import { parseCandidateResponse, type ParseOutcome } from '../llm/parser.js';
import { promptKindFor, renderBatchedSeedPrompt, renderPrompt } from '../llm/prompts.js';
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
import type { Profile } from '../profiles/schema.js';
import { calibrate } from '../score/calibrate.js';
import { cacheKey } from '../util/hash.js';
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

interface Prepared {
  promptKind: PromptKind;
  model: string;
  inlineSchema: boolean;
  request: LlmRequest;
  key: string;
  batchSize: number;
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
  // `--offline-lenient` implies `--offline`; it only changes what a miss does.
  const offline = deps.offline || deps.offlineLenient;
  const routeOptions = deps.seed === undefined ? {} : { seed: deps.seed };

  /** B43: every candidate ever returned for a slot in this run, in memory only. */
  const ledger = new Map<string, Candidate[]>();
  const parseFailureCount = new Map<string, number>();

  function keyFor(
    req: CandidateRequest,
    model: string,
    promptKind: PromptKind,
    batchSize: number,
    request: LlmRequest,
  ): string {
    return cacheKey({
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
  }

  /** Steps 1 and 2 for one clue: route, render, and derive the cache key. */
  function prepareSingle(req: CandidateRequest, temperature?: number): Prepared {
    const promptKind = promptKindFor(req.purpose);
    const routed = route(req, profile, routeOptions);
    const rendered = renderPrompt(req, promptKind, { inlineSchema: routed.inlineSchema });
    const request: LlmRequest = { ...routed.request, messages: rendered.messages };
    if (temperature !== undefined) request.temperature = temperature;
    return {
      promptKind,
      model: routed.model,
      inlineSchema: routed.inlineSchema,
      request,
      key: keyFor(req, routed.model, promptKind, 1, request),
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
    const rendered = renderBatchedSeedPrompt(reqs, { inlineSchema: routed.inlineSchema });
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
      batchIndex: input.batchIndex,
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

  /** Steps 4 and 5: validate, calibrate, emit, and add to the run ledger. */
  function finish(
    req: CandidateRequest,
    response: CandidateResponse,
    fromCache: boolean,
    usage: TokenUsage | null,
  ): CandidateResult {
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

    const candidates = calibrate(validated.accepted, {
      mode: profile.calibration,
      samples: profile.samples,
    });
    remember(req.slotId, candidates);
    emit({
      type: 'slot:candidates',
      slotId: req.slotId,
      accepted: candidates.map((c) => ({ answer: c.answer, score: c.score })),
      clueUnderstood: response.clue_understood,
      cacheHit: fromCache,
    });

    const result: CandidateResult = {
      candidates,
      clueUnderstood: response.clue_understood,
      cacheHit: fromCache,
    };
    if (response.notes !== undefined) result.notes = response.notes;
    if (usage !== null) result.usage = usage;
    return result;
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
  async function askSingle(req: CandidateRequest): Promise<CandidateResult> {
    emitAsk(req, promptKindFor(req.purpose), null);

    for (let attempt = 0; attempt <= 1; attempt += 1) {
      const prepared = prepareSingle(req, attempt === 0 ? undefined : RETRY_TEMPERATURE);
      const hit = await lookup(req, prepared.key);
      if (hit !== undefined) {
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
        return finish(req, hit.response, true, hit.usage);
      }

      if (offline) {
        if (deps.offlineLenient) return emptyResult(req);
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
        return finish(req, response, false, call.usage);
      }

      noteParseFailure(req.slotId);
    }

    return emptyResult(req);
  }

  /**
   * One batched seed call for a whole chunk. Every clue's result is stored
   * under its own key with `batchSize` set to the chunk length, so a batch-1
   * and a batch-3 answer for the same clue can never be mistaken for each
   * other (B23); any element the parser could not deliver is re-asked singly.
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
      writeRecord({
        req,
        prepared,
        key: keys[index] ?? '',
        batchIndex: index,
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

    // A partially cached chunk is re-asked whole: the key's `batchSize` has to
    // describe the prompt that actually produced the answer, so the batch
    // cannot be narrowed to only its misses without invalidating every key.
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
