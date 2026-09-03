import { notImplemented } from '../util/errors.js';
import type { InferenceLog, LlmTransport } from './types.js';

export interface NebiusTransportOptions {
  apiKey: string;
  baseUrl?: string;
  inferenceLog: InferenceLog;
  /** Injected so tests never touch an external network. */
  fetch?: typeof globalThis.fetch;
  maxRetries?: number;
}

/**
 * T33: the Nebius transport behind `LlmTransport` (B51). It acquires from the
 * per-model rate limiter before each attempt, captures every response header,
 * feeds the rate-limit signal back to `observe()`, retries per the spec, and
 * writes one `InferenceLogRecord` per attempt.
 */
export function createNebiusTransport(_opts: NebiusTransportOptions): LlmTransport {
  return notImplemented('src/llm/client.ts');
}
