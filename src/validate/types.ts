import type { Candidate, RejectReason } from '../candidates/types.js';

/** Single import point for the validation chain's reject reasons. */
export type { RejectReason };

export interface CandidateReject {
  answer: string;
  raw: string;
  reason: RejectReason;
}

export interface ValidationResult {
  accepted: Candidate[];
  rejects: CandidateReject[];
}

/**
 * B35. `openWordList` returns a null object when no list is present: `has` is
 * always false, `score` always 0 and `match` always empty, which disables the
 * repair word-list gate and leaves empty slots blank.
 */
export interface WordList {
  has(w: string): boolean;
  score(w: string): number;
  /** Words matching an `A?I?N` pattern, best first, at most `limit` of them. */
  match(pattern: string, limit: number): string[];
  /** False for the null object, so callers can warn once. */
  readonly loaded: boolean;
}
