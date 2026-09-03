import { randomUUID } from 'node:crypto';

import type { PromptKind, Purpose, Tier } from '../candidates/types.js';
import type { Emit } from '../events/types.js';
import { providerError } from '../cli/exit.js';
import { usdFor } from './pricing.js';
import { getLimiter, parseRateLimitHeaders } from './rateLimiter.js';
import type {
  InferenceLog,
  InferenceLogRecord,
  LlmRequest,
  LlmResult,
  LlmTransport,
  RateLimitSignal,
  TokenUsage,
} from './types.js';

/** Nebius Token Factory's OpenAI-compatible base, absent an override. */
const DEFAULT_NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';

/** Spec: "exponential backoff with full jitter starting at 500 ms, max 5 retries". */
const DEFAULT_MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 500;

/** B: promptVersion is "1" for all of v1; only T31 ever bumps it. */
const PROMPT_VERSION = '1';

/**
 * Placeholder context for the fields of `InferenceLogRecord` that identify
 * *why* a call was made (run, puzzle, slot, purpose, batch position, cache
 * key...). The transport is deliberately built with none of that knowledge
 * ("it moves text and usage" - T33 decisions), so every record it writes
 * carries these fixed, honestly-labelled placeholders rather than a guess
 * dressed up as real data. `cacheHit: false` and `promptVersion: "1"` are
 * the two exceptions: those genuinely are known here (a transport call is by
 * definition never a cache hit, and promptVersion never varies in v1).
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

  async function complete(req: LlmRequest): Promise<LlmResult> {
    const limiter = getLimiter(req.model, emit !== undefined ? { emit } : {});
    const estimatedTokens = estimateRequestTokens(req);

    let lastStatus: number | null = null;
    let lastErrorMessage: string | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
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
            body: JSON.stringify(buildRequestBody(req)),
            ...(req.signal !== undefined ? { signal: req.signal } : {}),
          });
        } catch (err) {
          if (isAbortError(err)) throw err;
          networkErrorMessage = err instanceof Error ? err.message : String(err);
        }
        const latencyMs = Date.now() - startedAt;

        if (response === undefined) {
          inferenceLog.write(
            buildRecord({
              req,
              attempt,
              httpStatus: null,
              headers: {},
              rawResponse: null,
              usage: null,
              latencyMs,
              error: networkErrorMessage,
            }),
          );
          lastStatus = null;
          lastErrorMessage = networkErrorMessage;
          if (attempt === maxRetries) break;
          await sleep(backoffMs(attempt, random));
          continue;
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
                req,
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
              `Nebius transport: ${req.model} returned 200 with no usable usage block`,
            );
          }
          inferenceLog.write(
            buildRecord({
              req,
              attempt,
              httpStatus: response.status,
              headers,
              rawResponse: bodyText,
              usage,
              latencyMs,
              error: null,
            }),
          );
          return { text: extractText(parsedBody), usage, httpStatus: 200, headers, latencyMs };
        }

        const errorMessage = extractErrorMessage(parsedBody) ?? `HTTP ${response.status}`;
        inferenceLog.write(
          buildRecord({
            req,
            attempt,
            httpStatus: response.status,
            headers,
            rawResponse: bodyText,
            usage: null,
            latencyMs,
            error: errorMessage,
          }),
        );
        lastStatus = response.status;
        lastErrorMessage = errorMessage;

        const retryable =
          response.status === 429 || (response.status >= 500 && response.status < 600);
        if (!retryable) {
          throw providerError(
            `Nebius transport: ${req.model} returned HTTP ${response.status}: ${errorMessage}`,
          );
        }
        if (attempt === maxRetries) break;

        const retryAfterMs = response.status === 429 ? rateLimitHeaders.retryAfterMs : undefined;
        const clampedRetryAfterMs = retryAfterMs !== undefined ? Math.max(0, retryAfterMs) : null;
        emit?.({
          type: 'rate:limited',
          model: req.model,
          status: response.status,
          retryAfterMs: clampedRetryAfterMs,
          attempt,
        });
        const delayMs = clampedRetryAfterMs ?? backoffMs(attempt, random);
        await sleep(delayMs);
      } finally {
        observeOnce({ status: 0 });
      }
    }

    const lastStatusText = lastStatus === null ? 'a network error' : `HTTP ${lastStatus}`;
    throw providerError(
      `Nebius transport: ${req.model} failed after ${maxRetries + 1} attempts (last: ${lastStatusText}` +
        `${lastErrorMessage !== null ? `: ${lastErrorMessage}` : ''})`,
    );
  }

  return { complete };
}
