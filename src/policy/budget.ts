import { notImplemented } from '../util/errors.js';
import type { Profile } from '../profiles/schema.js';
import type { BudgetCap, BudgetHit, BudgetSpend, ResolvedBudget } from './types.js';

/**
 * Accumulates spend against a `ResolvedBudget`. Hitting a cap is reported,
 * never thrown: the caller emits `budget:hit` and ends the current phase
 * gracefully.
 */
export interface BudgetTracker {
  charge(cap: BudgetCap, amount: number): { exceeded: BudgetCap | null };
  spent(): BudgetSpend;
  budget(): ResolvedBudget;
  hits(): BudgetHit[];
}

/** T19 (B44). */
export function resolveBudget(_profile: Profile): ResolvedBudget {
  return notImplemented('src/policy/budget.ts');
}

export function createBudgetTracker(
  _budget: ResolvedBudget,
  _opts?: { now?: () => number },
): BudgetTracker {
  return notImplemented('src/policy/budget.ts');
}
