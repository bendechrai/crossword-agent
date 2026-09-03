import { notImplemented } from '../util/errors.js';
import type { Emit } from '../events/types.js';
import type { InferenceLog, LlmTransport } from '../llm/types.js';
import type { Profile } from '../profiles/schema.js';
import type { CandidateCache } from './cache.js';
import type { CandidateService } from './types.js';

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
}

/**
 * T34: cache lookup, tier routing, transport call, parse, validation,
 * calibration - in that order.
 */
export function createCandidateService(_deps: CandidateServiceDeps): CandidateService {
  return notImplemented('src/candidates/service.ts');
}
