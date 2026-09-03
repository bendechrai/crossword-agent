import type { Profile } from '../profiles/schema.js';

/** B44: the caps a run is tracked against. */
export interface ResolvedBudget {
  usd: number;
  tokens: number;
  wallMs: number;
  /** From escalation.maxTier2CallsPerPuzzle. */
  tier2Calls: number;
  /** From search.maxBacktracks. */
  backtracks: number;
  /** From repair.maxCalls. */
  repairCalls: number;
}

/** The name of a cap, which is also the key of what is spent against it. */
export type BudgetCap = keyof ResolvedBudget;

export type BudgetSpend = Record<BudgetCap, number>;

export interface BudgetHit {
  cap: BudgetCap;
  limit: number;
  actual: number;
  atMs: number;
}

/** B13: the full input to the escalation decision, and nothing else. */
export interface EscalationContext {
  slotId: string;
  point: 'after-candidates' | 'at-termination';
  clueUnderstood: number | null;
  domainSize: number;
  parseFailures: number;
  reasksUsed: number;
  escalationsUsed: number;
  tier2CallsUsed: number;
  patternFixedLetters: number;
  lastPatternQueried: string | null;
  currentPattern: string;
  budget: ResolvedBudget;
  spent: BudgetSpend;
  profile: Profile;
}

export interface EscalationDecision {
  action: 'none' | 'reask' | 'escalate' | 'give-up';
  trigger?: 1 | 2 | 3 | 4 | 5;
  reason: string;
}
