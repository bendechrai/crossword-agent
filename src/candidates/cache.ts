import { notImplemented } from '../util/errors.js';
import type { TokenUsage } from '../llm/types.js';
import type { CandidateResponse } from './types.js';

/**
 * A disk cache entry at `<cacheDir>/<first2>/<sha1>.json`. `keyFields` is the
 * object that was hashed, so a cache file is self-describing.
 */
export interface CacheEntry {
  key: string;
  keyFields: Record<string, unknown>;
  response: CandidateResponse | null;
  usage: TokenUsage | null;
  latencyMs: number;
  model: string;
  /** ISO 8601. */
  createdAt: string;
}

export interface CacheStats {
  entries: number;
  bytes: number;
  /** True above 1 GB (B24). */
  overSizeWarning: boolean;
  byModel: Record<string, number>;
  byPromptVersion: Record<string, number>;
}

export interface CacheClearFilter {
  model?: string;
  promptVersion?: string;
}

export interface CandidateCache {
  get(key: string): CacheEntry | undefined;
  set(key: string, entry: CacheEntry): void;
  stats(): CacheStats;
  clear(filter?: CacheClearFilter): number;
}

export interface CandidateCacheOptions {
  cacheDir: string;
  /** In-process LRU size; 2,000 by default. */
  lruSize?: number;
}

/**
 * T12: an in-process LRU over a disk cache. Negative results (zero valid
 * candidates) are stored in the same shape, so backtracking never re-pays for
 * a known dead end.
 */
export function openCandidateCache(_opts: CandidateCacheOptions): CandidateCache {
  return notImplemented('src/candidates/cache.ts');
}
