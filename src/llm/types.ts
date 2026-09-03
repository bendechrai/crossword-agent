import type { CandidateResponse, PromptKind, Purpose, Tier } from '../candidates/types.js';

/** B15. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
}

export interface LlmMessage {
  role: 'system' | 'user';
  content: string;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  temperature: number;
  maxTokens: number;
  topP?: number;
  /** Present only when the model advertises `structured_outputs` (B9). */
  responseFormat?: unknown;
  /** Capability-gated params (reasoning off, provider seed). */
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface LlmResult {
  text: string;
  usage: TokenUsage;
  httpStatus: number;
  headers: Record<string, string>;
  latencyMs: number;
}

/**
 * The seam that lets the candidate service and the Nebius client be built
 * independently (B51): the service is written against a stub transport, the
 * client against this interface.
 */
export interface LlmTransport {
  complete(req: LlmRequest): Promise<LlmResult>;
}

export interface InferenceLogRecord {
  /** uuid v4, one per call attempt. */
  id: string;
  /** ISO 8601. */
  ts: string;
  /** null outside a run (smoke, calibrate). */
  runId: string | null;
  puzzleId: string | null;
  slotId: string | null;
  purpose: Purpose;
  promptKind: PromptKind;
  tier: Tier;
  model: string;
  promptVersion: string;
  cacheKey: string;
  cacheHit: boolean;
  /** 1 for a single-clue call. */
  batchSize: number;
  /** The clue's position within the batch; null on a cache hit. */
  batchIndex: number | null;
  sampleIndex: number;
  /** null on a cache hit. */
  request: {
    messages: LlmMessage[];
    temperature: number;
    maxTokens: number;
    topP?: number;
    responseFormat?: unknown;
    extra?: Record<string, unknown>;
  } | null;
  /** Verbatim text; null on a cache hit or a transport error. */
  rawResponse: string | null;
  parsed: CandidateResponse | null;
  parseError: string | null;
  httpStatus: number | null;
  /**
   * Response headers only. Never carries authorization or any API-key header:
   * those are request headers, and request headers are not logged at all.
   */
  responseHeaders: Record<string, string>;
  /** 0-based retry index. */
  attempt: number;
  /** Populated on cache hits too, from the cached usage blob. */
  usage: TokenUsage | null;
  /** 0 on a cache hit. */
  usdBilled: number | null;
  /** What the call would have cost cold (B2). */
  usdCounterfactual: number | null;
  latencyMs: number | null;
  /** Transport or abort error message. */
  error: string | null;
}

export interface InferenceLog {
  write(record: InferenceLogRecord): void;
  close(): void;
}

export interface RateLimitSignal {
  status: number;
  retryAfterMs?: number;
  remainingRequests?: number;
  remainingTokens?: number;
  resetRequestsMs?: number;
  resetTokensMs?: number;
}

export interface RateLimiterState {
  model: string;
  rps: number;
  inFlight: number;
  queued: number;
  lastSignal?: RateLimitSignal;
}

export interface RateLimiter {
  acquire(estimatedTokens: number): Promise<void>;
  observe(signal: RateLimitSignal): void;
  snapshot(): RateLimiterState;
}

/** Price entry for one model, as USD-per-token decimal strings. */
export interface ModelPricing {
  prompt: string;
  completion: string;
  request: string;
}

export interface ModelCapabilities {
  supportsStructuredOutputs: boolean;
  supportsReasoning: boolean;
  supportsSeed: boolean;
  supportedSamplingParameters: string[];
}

export interface ModelLimits {
  requestsPerMinute: number;
  tokensPerMinute: number;
  burstRatio: number;
}
