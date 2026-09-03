import { notImplemented } from '../util/errors.js';
import type { RateLimitSignal, RateLimiter } from './types.js';

export interface RateLimiterOptions {
  model: string;
  /** 0.9 by default; applied to the catalogue RPM and TPM. */
  rpsFraction?: number;
  maxConcurrency?: number;
}

export interface RateLimiterRegistry {
  /** One limiter per model id, shared by every caller in the process. */
  forModel(opts: RateLimiterOptions): RateLimiter;
  reset(): void;
}

/** T9: the process-wide registry. */
export function getRateLimiterRegistry(): RateLimiterRegistry {
  return notImplemented('src/llm/rateLimiter.ts');
}

/** The seven OpenAI-compatible headers, all optional. */
export function parseRateLimitHeaders(_headers: Record<string, string>): RateLimitSignal {
  return notImplemented('src/llm/rateLimiter.ts');
}
