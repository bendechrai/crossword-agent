import { notImplemented } from '../util/errors.js';
import type { Candidate, RejectedAnswer, Tier } from '../candidates/types.js';
import type { ValidationResult } from './types.js';

export interface ValidateInput {
  /** Raw answers as the model returned them, in model order. */
  raw: ReadonlyArray<{ answer: string; confidence: number }>;
  length: number;
  pattern: string;
  clue: string;
  tier: Tier;
  fromCache: boolean;
  /** The slot's persistent rejection set. */
  rejected: ReadonlyArray<RejectedAnswer>;
  /** Clue-echo rejection is waived when the slot would otherwise be empty. */
  allowClueEcho?: boolean;
}

/**
 * Uppercase; strip spaces, hyphens, apostrophes and punctuation;
 * NFD-decompose and drop combining marks.
 */
export function normaliseAnswer(_raw: string): string {
  return notImplemented('src/validate/normalise.ts');
}

/**
 * T6: the chain in exactly this order - normalise, charset, length, pattern,
 * dedupe, clue-echo, persistent rejection set. Every drop carries a
 * `RejectReason`.
 */
export function validateCandidates(_input: ValidateInput): ValidationResult {
  return notImplemented('src/validate/normalise.ts');
}

/** Convenience for callers that already hold `Candidate` objects. */
export function dedupeCandidates(_candidates: ReadonlyArray<Candidate>): Candidate[] {
  return notImplemented('src/validate/normalise.ts');
}
