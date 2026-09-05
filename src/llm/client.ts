import { randomUUID } from 'node:crypto';

import type { PromptKind, Purpose, Tier } from '../candidates/types.js';
import type { Emit } from '../events/types.js';
import { providerError } from '../cli/exit.js';
import { log } from '../util/log.js';
import { usdFor } from './pricing.js';
import { PROMPT_VERSION } from './prompts.js';
import { getLimiter, parseRateLimitHeaders } from './rateLimiter.js';
import { REASONING_OFF_PARAM } from './tierRouter.js';
import type {
  InferenceLog,
  InferenceLogRecord,
  LlmRequest,
  LlmResult,
  LlmTransport,
  RateLimiter,
  RateLimitSignal,
  TokenUsage,
} from './types.js';

/** Nebius Token Factory's OpenAI-compatible base, absent an override. */
const DEFAULT_NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';

/** Spec: "exponential backoff with full jitter starting at 500 ms, max 5 retries". */
const DEFAULT_MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 500;

/**
 * T68 (docs/plan.md "Router: per-model reasoning-off value with a fallback
 * for providers that reject none"), layer 2. `tierRouter.ts` (layer 1)
 * already sends a per-model reasoning-off value, defaulting to `"none"` with
 * an override table for models known in advance to reject it (e.g.
 * `openai/gpt-oss-120b` -> `"low"`, a Harmony-format model). This is the
 * runtime safety net for every other model that turns out to reject `"none"`
 * too: an HTTP 400 whose body names `reasoning_effort` (Nebius's own
 * validator does, e.g. `Harmony does not support reasoning_effort='none'`)
 * is retried exactly once with this value substituted for whatever value was
 * sent, never looped further - if the retry also fails, the provider error
 * surfaces as it would have without this fallback.
 */
const REASONING_EFFORT_FALLBACK_VALUE = 'low';

function hasReasoningEffortParam(req: LlmRequest): boolean {
  return req.extra !== undefined && REASONING_OFF_PARAM in req.extra;
}

function mentionsReasoningEffort(message: string): boolean {
  return message.toLowerCase().includes(REASONING_OFF_PARAM);
}

/**
 * Placeholder context for the fields of `InferenceLogRecord` that identify
 * *why* a call was made (run, puzzle, slot, purpose, batch position, cache
 * key...). The transport is deliberately built with none of that knowledge
 * ("it moves text and usage" - T33 decisions), so every record it writes
 * carries these fixed, honestly-labelled placeholders rather than a guess
 * dressed up as real data. `cacheHit: false` and `promptVersion` are the two
 * exceptions: those genuinely are known here (a transport call is by
 * definition never a cache hit, and the prompt version is whatever
 * `llm/prompts.ts` currently renders, which is where `PROMPT_VERSION` is
 * imported from rather than re-spelled).
 *
 * A future caller that wants richer correlation (T34's candidate service, or
 * whatever wires the CLI together) would need either an extension to the
 * frozen `LlmRequest` type or a decorator around this transport that patches
 * these fields in before forwarding to the real sink; neither is this
 * task's to build (see "Out of scope": candidate handling is T34's).
 */
const UNKNOWN_PURPOSE: Purpose = 'smoke';
const UNKNOWN_PROMPT_KIND: PromptKind = 'seed';
const UNKNOWN_TIER: Tier = 1;

export interface NebiusTransportOptions {
  /** Defaults to `$NEBIUS_API_KEY`. Missing/empty is a startup error, never a bare 401. */
  apiKey?: string;
  /** Defaults to `$NEBIUS_BASE_URL`, then the Nebius default. */
  baseUrl?: string;
  inferenceLog: InferenceLog;
  /** Injected so tests never touch an external network. */
  fetch?: typeof globalThis.fetch;
  maxRetries?: number;
  /** Receives `rate:limited` on every 429/5xx retry. `rate:adjusted` comes from the limiter itself. */
  emit?: Emit;
  /** B38: the PRNG behind full-jitter backoff, so retry timing is reproducible in tests. */
  random?: () => number;
  /**
   * The delay behind retry backoff, injected so a test never actually waits
   * out a real 500 ms-to-16 s backoff: it can substitute an instant resolve
   * while still recording (and asserting on) the millisecond value this
   * transport computed. Real production callers never pass this and get a
   * genuine `setTimeout`-based wait.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Test-only: defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function extractText(body: unknown): string {
  if (!isRecord(body)) return '';
  const choices = body['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first: unknown = choices[0];
  if (!isRecord(first)) return '';
  const message = first['message'];
  if (!isRecord(message)) return '';
  const content = message['content'];
  return typeof content === 'string' ? content : '';
}

/**
 * B29: reasoning tokens (when the provider reports them) are read into
 * `TokenUsage.reasoningTokens` and are also folded into `completionTokens`
 * for billing.
 */
function extractUsage(body: unknown): TokenUsage | undefined {
  if (!isRecord(body)) return undefined;
  const usage = body['usage'];
  if (!isRecord(usage)) return undefined;
  const promptTokens = usage['prompt_tokens'];
  const completionTokensRaw = usage['completion_tokens'];
  if (typeof promptTokens !== 'number' || typeof completionTokensRaw !== 'number') {
    return undefined;
  }
  const details = usage['completion_tokens_details'];
  const reasoningTokens =
    isRecord(details) && typeof details['reasoning_tokens'] === 'number'
      ? details['reasoning_tokens']
      : undefined;
  const completionTokens = completionTokensRaw + (reasoningTokens ?? 0);
  const result: TokenUsage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
  if (reasoningTokens !== undefined) result.reasoningTokens = reasoningTokens;
  return result;
}

function extractErrorMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const error = body['error'];
  if (isRecord(error) && typeof error['message'] === 'string') return error['message'];
  const message = body['message'];
  return typeof message === 'string' ? message : undefined;
}

/** `Headers` already lower-cases keys per spec; kept explicit since callers rely on it. */
function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function buildRequestBody(req: LlmRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature,
    max_tokens: req.maxTokens,
  };
  if (req.topP !== undefined) body['top_p'] = req.topP;
  if (req.responseFormat !== undefined) body['response_format'] = req.responseFormat;
  if (req.extra !== undefined) Object.assign(body, req.extra);
  return body;
}

/** Rough tokens-per-request estimate: chars/4 for the prompt, plus the requested completion budget. */
function estimateRequestTokens(req: LlmRequest): number {
  const promptChars = req.messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(promptChars / 4) + req.maxTokens;
}

/** Full jitter (AWS's term): uniform in `[0, min(cap, base * 2^attempt))`, no cap in v1. */
function backoffMs(attempt: number, random: () => number): number {
  return random() * (BASE_BACKOFF_MS * 2 ** attempt);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

interface AttemptRecordInput {
  req: LlmRequest;
  attempt: number;
  httpStatus: number | null;
  headers: Record<string, string>;
  rawResponse: string | null;
  usage: TokenUsage | null;
  latencyMs: number;
  error: string | null;
}

function buildRecord(input: AttemptRecordInput): InferenceLogRecord {
  const billed =
    input.usage !== null && input.httpStatus === 200
      ? usdFor({
          model: input.req.model,
          promptTokens: input.usage.promptTokens,
          completionTokens: input.usage.completionTokens,
          calls: 1,
        })
      : null;

  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    runId: null,
    puzzleId: null,
    slotId: null,
    purpose: UNKNOWN_PURPOSE,
    promptKind: UNKNOWN_PROMPT_KIND,
    tier: UNKNOWN_TIER,
    model: input.req.model,
    promptVersion: PROMPT_VERSION,
    cacheKey: '',
    cacheHit: false,
    batchSize: 1,
    batchIndex: null,
    sampleIndex: 0,
    request: {
      messages: input.req.messages,
      temperature: input.req.temperature,
      maxTokens: input.req.maxTokens,
      topP: input.req.topP,
      responseFormat: input.req.responseFormat,
      extra: input.req.extra,
    },
    rawResponse: input.rawResponse,
    parsed: null,
    parseError: null,
    httpStatus: input.httpStatus,
    responseHeaders: input.headers,
    attempt: input.attempt,
    usage: input.usage,
    // usdCounterfactual === usdBilled here: a live transport call is by
    // definition cold, so "what it cost" and "what it would have cost cold"
    // are the same number (B2's distinction only bites on a cache hit).
    usdBilled: billed,
    usdCounterfactual: billed,
    latencyMs: input.latencyMs,
    error: input.error,
  };
}

/**
 * The outcome of one HTTP round trip (one `InferenceLogRecord` written),
 * before any retry policy is applied. `complete()`'s main loop and the T68
 * 400-reasoning_effort fallback (below) both drive a single request through
 * `attemptOnce` and decide what to do with the result themselves; this keeps
 * the one-shot fallback from duplicating the fetch/log/observe plumbing.
 */
type AttemptOutcome =
  | { kind: 'success'; result: LlmResult }
  | { kind: 'network-error'; message: string | null }
  | { kind: 'http-error'; status: number; message: string; retryAfterMs: number | undefined };

/**
 * T33: the Nebius transport behind `LlmTransport` (B51). It acquires from the
 * per-model rate limiter before each attempt, captures every response header,
 * feeds the rate-limit signal back to `observe()`, retries per the spec, and
 * writes one `InferenceLogRecord` per attempt.
 */
export function createNebiusTransport(opts: NebiusTransportOptions): LlmTransport {
  const env = opts.env ?? process.env;
  const apiKey = opts.apiKey ?? env['NEBIUS_API_KEY'];
  if (apiKey === undefined || apiKey.trim() === '') {
    throw providerError(
      'Nebius transport: NEBIUS_API_KEY is not set',
      'cp .env.example .env',
    );
  }

  const baseUrl = (opts.baseUrl ?? env['NEBIUS_BASE_URL'] ?? DEFAULT_NEBIUS_BASE_URL).replace(
    /\/+$/,
    '',
  );
  const doFetch = opts.fetch ?? globalThis.fetch;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? wait;
  const inferenceLog = opts.inferenceLog;
  const emit = opts.emit;

  /**
   * One HTTP round trip against `req`, logged as attempt `attempt`. Retry
   * policy (backoff, `rate:limited`, the T68 400 fallback) lives in the
   * callers below; this only sends the request, reads the response, writes
   * exactly one `InferenceLogRecord`, and reports back what happened.
   */
  async function attemptOnce(
    requestToSend: LlmRequest,
    attempt: number,
    limiter: RateLimiter,
    estimatedTokens: number,
  ): Promise<AttemptOutcome> {
    await limiter.acquire(estimatedTokens);

    // Exactly one `observe()` per `acquire()`: the HTTP path below calls
    // `observeOnce` with the real status once a response arrives, and the
    // `finally` below covers every other exit from this attempt (a
    // rethrown AbortError, a network error, or any future early return) so
    // a slot is never left permanently checked out of the limiter (see the
    // T33 review fix: acquire() without a matching observe() starves
    // `maxConcurrency` after `maxConcurrency` failed attempts). `status: 0`
    // is not 429, so it never triggers the AIMD backoff meant for real
    // rate-limit responses.
    let observed = false;
    const observeOnce = (signal: RateLimitSignal): void => {
      if (observed) return;
      observed = true;
      limiter.observe(signal);
    };

    try {
      const startedAt = Date.now();
      let response: Response | undefined;
      let networkErrorMessage: string | null = null;
      try {
        response = await doFetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(buildRequestBody(requestToSend)),
          ...(requestToSend.signal !== undefined ? { signal: requestToSend.signal } : {}),
        });
      } catch (err) {
        if (isAbortError(err)) throw err;
        networkErrorMessage = err instanceof Error ? err.message : String(err);
      }
      const latencyMs = Date.now() - startedAt;

      if (response === undefined) {
        inferenceLog.write(
          buildRecord({
            req: requestToSend,
            attempt,
            httpStatus: null,
            headers: {},
            rawResponse: null,
            usage: null,
            latencyMs,
            error: networkErrorMessage,
          }),
        );
        return { kind: 'network-error', message: networkErrorMessage };
      }

      const bodyText = await response.text();
      const headers = headersToRecord(response.headers);
      const parsedBody = tryParseJson(bodyText);
      const rateLimitHeaders = parseRateLimitHeaders(headers);
      const signal: RateLimitSignal = { status: response.status, ...rateLimitHeaders };
      observeOnce(signal);

      if (response.status === 200) {
        const usage = extractUsage(parsedBody);
        if (usage === undefined) {
          inferenceLog.write(
            buildRecord({
              req: requestToSend,
              attempt,
              httpStatus: response.status,
              headers,
              rawResponse: bodyText,
              usage: null,
              latencyMs,
              error: 'malformed 200 response: no usable usage block',
            }),
          );
          throw providerError(
            `Nebius transport: ${requestToSend.model} returned 200 with no usable usage block`,
          );
        }
        inferenceLog.write(
          buildRecord({
            req: requestToSend,
            attempt,
            httpStatus: response.status,
            headers,
            rawResponse: bodyText,
            usage,
            latencyMs,
            error: null,
          }),
        );
        return {
          kind: 'success',
          result: { text: extractText(parsedBody), usage, httpStatus: 200, headers, latencyMs },
        };
      }

      const errorMessage = extractErrorMessage(parsedBody) ?? `HTTP ${response.status}`;
      inferenceLog.write(
        buildRecord({
          req: requestToSend,
          attempt,
          httpStatus: response.status,
          headers,
          rawResponse: bodyText,
          usage: null,
          latencyMs,
          error: errorMessage,
        }),
      );
      return {
        kind: 'http-error',
        status: response.status,
        message: errorMessage,
        retryAfterMs: rateLimitHeaders.retryAfterMs,
      };
    } finally {
      observeOnce({ status: 0 });
    }
  }

  async function complete(req: LlmRequest): Promise<LlmResult> {
    const limiter = getLimiter(req.model, emit !== undefined ? { emit } : {});
    const estimatedTokens = estimateRequestTokens(req);

    let lastStatus: number | null = null;
    let lastErrorMessage: string | null = null;
    // T68: this fallback fires at most once per `complete()` call, never
    // inside a loop of its own - "retry ONCE with 'low' (do not loop)".
    let reasoningEffortRetryUsed = false;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const outcome = await attemptOnce(req, attempt, limiter, estimatedTokens);

      if (outcome.kind === 'success') return outcome.result;

      if (outcome.kind === 'network-error') {
        lastStatus = null;
        lastErrorMessage = outcome.message;
        if (attempt === maxRetries) break;
        await sleep(backoffMs(attempt, random));
        continue;
      }

      lastStatus = outcome.status;
      lastErrorMessage = outcome.message;

      // T68: a Harmony-format model (or any other model whose accepted
      // reasoning_effort values differ from what tierRouter.ts's per-model
      // table currently assumes) rejects the value we sent with HTTP 400
      // naming `reasoning_effort` in the body. This is not the general
      // retryable-status path below (400 is never in that set): it is a
      // one-shot substitution of the offending value for
      // `REASONING_EFFORT_FALLBACK_VALUE` ("low"), tried exactly once,
      // outside the normal backoff loop.
      if (
        outcome.status === 400 &&
        !reasoningEffortRetryUsed &&
        hasReasoningEffortParam(req) &&
        mentionsReasoningEffort(outcome.message)
      ) {
        reasoningEffortRetryUsed = true;
        const rejectedValue = req.extra?.[REASONING_OFF_PARAM];
        log.warn(
          `Nebius transport: ${req.model} rejected ${REASONING_OFF_PARAM}=${JSON.stringify(rejectedValue)} ` +
            `(HTTP 400: ${outcome.message}); retrying once with ${REASONING_OFF_PARAM}="${REASONING_EFFORT_FALLBACK_VALUE}"`,
        );
        const retryReq: LlmRequest = {
          ...req,
          extra: { ...req.extra, [REASONING_OFF_PARAM]: REASONING_EFFORT_FALLBACK_VALUE },
        };
        const retryOutcome = await attemptOnce(retryReq, attempt + 1, limiter, estimatedTokens);
        if (retryOutcome.kind === 'success') return retryOutcome.result;

        const retryStatusText =
          retryOutcome.kind === 'network-error' ? 'a network error' : `HTTP ${retryOutcome.status}`;
        const retryMessage = retryOutcome.message;
        throw providerError(
          `Nebius transport: ${req.model} failed after retrying reasoning_effort="${REASONING_EFFORT_FALLBACK_VALUE}" ` +
            `(last: ${retryStatusText}${retryMessage !== null ? `: ${retryMessage}` : ''})`,
        );
      }

      const retryable = outcome.status === 429 || (outcome.status >= 500 && outcome.status < 600);
      if (!retryable) {
        throw providerError(
          `Nebius transport: ${req.model} returned HTTP ${outcome.status}: ${outcome.message}`,
        );
      }
      if (attempt === maxRetries) break;

      const retryAfterMs = outcome.status === 429 ? outcome.retryAfterMs : undefined;
      const clampedRetryAfterMs = retryAfterMs !== undefined ? Math.max(0, retryAfterMs) : null;
      emit?.({
        type: 'rate:limited',
        model: req.model,
        status: outcome.status,
        retryAfterMs: clampedRetryAfterMs,
        attempt,
      });
      const delayMs = clampedRetryAfterMs ?? backoffMs(attempt, random);
      await sleep(delayMs);
    }

    const lastStatusText = lastStatus === null ? 'a network error' : `HTTP ${lastStatus}`;
    throw providerError(
      `Nebius transport: ${req.model} failed after ${maxRetries + 1} attempts (last: ${lastStatusText}` +
        `${lastErrorMessage !== null ? `: ${lastErrorMessage}` : ''})`,
    );
  }

  return { complete };
}
