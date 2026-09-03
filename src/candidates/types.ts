import type { PuzzleStyle } from '../puzzle/types.js';
import type { TokenUsage } from '../llm/types.js';

export type Tier = 1 | 2;

export type RejectReason =
  | 'length'
  | 'charset'
  | 'pattern'
  | 'clue-echo'
  | 'duplicate'
  | 'rejected-before';

export type Purpose = 'seed' | 'reask' | 'escalate' | 'repair' | 'smoke' | 'calibrate';

/** Three prompt templates; re-ask and repair both render `constrained` (B23). */
export type PromptKind = 'seed' | 'constrained' | 'escalate';

export interface Candidate {
  /** Normalised A-Z. */
  answer: string;
  /** As returned by the model. */
  raw: string;
  /** 0-based position in the model's list. */
  rank: number;
  /** Clamped 0..1. */
  selfConfidence: number;
  /** 1 unless samples > 1. */
  votes: number;
  /** Calibrated search score. */
  score: number;
  tier: Tier;
  fromCache: boolean;
}

export interface RejectedAnswer {
  answer: string;
  reason: string;
}

export interface CrossingContextEntry {
  slotId: string;
  clue: string;
  fill: string | null;
  confidence: number;
}

export interface CandidateRequest {
  slotId: string;
  clue: string;
  length: number;
  pattern: string;
  style: PuzzleStyle;
  enumeration?: string;
  title?: string;
  rejected: ReadonlyArray<RejectedAnswer>;
  tier: Tier;
  purpose: Purpose;
  n: number;
  samples: number;
  sampleIndex: number;
  crossingContext?: ReadonlyArray<CrossingContextEntry>;
}

/** Wire shape returned by the model; schemas/candidate-response.schema.json. */
export interface CandidateResponse {
  clue_understood: number;
  candidates: Array<{ answer: string; confidence: number }>;
  /** May carry `crossing_suspect: "<slotId>"`. */
  notes?: string;
}

/** The batched wire shape: one element per clue, realigned by `id`. */
export interface BatchedCandidateResponse {
  results: Array<CandidateResponse & { id: string }>;
}

export interface CandidateResult {
  candidates: Candidate[];
  clueUnderstood: number;
  notes?: string;
  cacheHit: boolean;
  usage?: TokenUsage;
}

export interface CandidateService {
  getCandidates(req: CandidateRequest): Promise<CandidateResult>;
  /**
   * Batched seeding (B3): batching applies to `purpose: 'seed'` only. Results
   * are keyed by `CandidateRequest.slotId`, and every request in `reqs` is
   * present in the result, singly re-asked if its batch element failed.
   */
  getCandidatesBatch(reqs: ReadonlyArray<CandidateRequest>): Promise<Map<string, CandidateResult>>;
  /**
   * Every candidate ever returned for that slot in this run (B43). This is the
   * ledger the repair gate reads, deliberately not the current domain: a
   * candidate pruned by AC-3 or by a since-undone assignment is still evidence
   * that a letter is plausible.
   */
  peek(slotId: string): Candidate[];
}
