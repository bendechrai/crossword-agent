import { notImplemented } from '../util/errors.js';
import type { FetchLike, SourceAdapter } from './types.js';

export interface GuardianSourceOptions {
  /** Injected so tests stay offline. */
  fetch?: FetchLike;
}

/** Hard maximum for `--limit` on this source; above it is a usage error (A2). */
export const GUARDIAN_LIMIT_MAX = 20;

/** One request per second, independent of any other rate limiting (A2). */
export const GUARDIAN_MIN_REQUEST_INTERVAL_MS = 1000;

/**
 * T28. An unofficial endpoint, deliberately constrained to personal-research
 * volumes: a descriptive User-Agent, 1 rps, `--limit` default 1 and max 20,
 * and no archive-backfill command.
 */
export function createGuardianSource(_opts: GuardianSourceOptions = {}): SourceAdapter {
  return {
    id: 'guardian',
    list: () => notImplemented('src/sources/guardian.ts'),
    download: () => notImplemented('src/sources/guardian.ts'),
    normalise: () => notImplemented('src/sources/guardian.ts'),
  };
}

/** The instance the registry holds. */
export const guardianSource: SourceAdapter = createGuardianSource();
