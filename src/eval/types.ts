import type { RejectReason, Tier } from '../candidates/types.js';
import type { BudgetHit } from '../policy/types.js';
import type { Profile, ProfileSource } from '../profiles/schema.js';
import type { PuzzleStyle, Stratum } from '../puzzle/types.js';

export interface Accuracy {
  /** Correct letters over non-block cells, in [0,1]. */
  letters: number;
  /** Correct slots over all slots, in [0,1]. */
  words: number;
  perfect: boolean;
  emptyCells: number;
}

/** Which tier produced an assignment; the word list is neither tier. */
export type ProducedByTier = Tier | 'wordlist';

/** B28. */
export type RunStatus = 'ok' | 'partial' | 'error';

export interface PerSlotRecord {
  slotId: string;
  clue: string;
  length: number;
  truth: string;
  filled: string | null;
  correct: boolean;
  producedBy: ProducedByTier | null;
  /** The clue's position within its batch; null when unbatched (B14). */
  batchIndex: number | null;
  truthInCandidates: boolean;
  truthRank: number | null;
  rejectCounts: Record<RejectReason, number>;
  parseFailures: number;
  latencyMs: number;
  usd: number;
  reasks: number;
  escalated: boolean;
  candidatesSeen: number;
  pickedRank: number | null;
}

export interface TierCallStats {
  count: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  /** What actually left the account; zero for a cache hit (B2). */
  usdBilled: number;
  /** Every call priced as if cold, including cache hits (B2). */
  usdCounterfactual: number;
  cacheHits: number;
  avgLatencyMs: number;
}

export interface RunProvenance {
  /** "unknown" rather than a failed run (B30). */
  gitCommit: string;
  nodeVersion: string;
  packageVersion: string;
  profileSource: ProfileSource;
}

export interface RunRecord {
  runId: string;
  /** ISO 8601. */
  timestamp: string;
  status: RunStatus;
  /** Present when status is 'error'. */
  error?: string;
  puzzle: {
    id: string;
    source: string;
    style: PuzzleStyle;
    stratum: Stratum;
    /** For example "15x15". */
    size: string;
    slots: number;
  };
  /** The fully resolved profile, exactly as the run used it (B12). */
  profile: Profile;
  provenance: RunProvenance;
  repeatIndex: number;
  seed: number | null;
  models: { tier1: string; tier2: string };
  accuracy: Accuracy;
  perSlot: PerSlotRecord[];
  calls: Record<'tier1' | 'tier2', TierCallStats>;
  search: { backtracks: number; discrepancies: number; wipeouts: number; ac3Reductions: number };
  repair: { proposals: number; accepted: number };
  wallMs: number;
  budgetHits: BudgetHit[];
}
