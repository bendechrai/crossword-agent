import { notImplemented } from '../util/errors.js';
import type { CandidateResponse } from '../candidates/types.js';

export interface ParseOptions {
  batchSize: number;
  /** Slot ids expected back; a batched response is realigned by these. */
  expectedIds: string[];
}

export interface ParseFailure {
  /** null when the whole response was unusable. */
  id: string | null;
  error: string;
}

export interface ParseOutcome {
  byId: Map<string, CandidateResponse>;
  failures: ParseFailure[];
  /** The substring that was actually parsed, for the inference log. */
  rawUsed: string;
}

/**
 * T11. Order of operations: strip `reasoning_content` and any `<think>` block
 * (B41), strip code fences, take the LAST balanced JSON object, then
 * ajv-validate. A batched response is validated element by element and
 * realigned by `id`, never by position.
 */
export function parseCandidateResponse(_raw: string, _opts: ParseOptions): ParseOutcome {
  return notImplemented('src/llm/parser.ts');
}
