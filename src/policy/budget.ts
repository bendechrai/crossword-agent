import type { Profile } from '../profiles/schema.js';
import type { BudgetCap, BudgetHit, BudgetSpend, ResolvedBudget } from './types.js';

/**
 * The caps `charge` accepts. `wallMs` is excluded: it is never "spent" by an
 * explicit amount, it accrues on its own from the injected `now()`, and is
 * observed through `checkWallClock` (or picked up incidentally by any
 * `charge` call, since every check evaluates all six caps together).
 */
export type ChargeableBudgetCap = Exclude<BudgetCap, 'wallMs'>;

/**
 * Accumulates spend against a `ResolvedBudget`. Hitting a cap is reported,
 * never thrown: the caller emits `budget:hit` and ends the current phase
 * gracefully.
 */
export interface BudgetTracker {
  /**
   * Records `amount` against `cap`, then evaluates every cap (including
   * wall-clock) in the declared order (usd, tokens, tier2Calls, backtracks,
   * repairCalls, wallMs) and returns the first one currently exceeded - not
   * necessarily `cap` itself, since a charge to one cap can surface an
   * already-crossed cap earlier in the order. Monotonic: the charge is
   * recorded whether or not it exceeds, so `snapshot()` stays truthful.
   */
  charge(cap: ChargeableBudgetCap, amount: number): { exceeded: BudgetCap | null };
  /**
   * Evaluates every cap against the injected `now()` without recording a
   * charge - the way wall-clock exhaustion is noticed between charges, e.g.
   * at a search-loop iteration boundary that spent nothing this tick.
   */
  checkWallClock(): { exceeded: BudgetCap | null };
  /** Every counter's current value, a plain object safe to embed in a `budget:hit` payload. */
  snapshot(): BudgetSpend;
  /** The resolved caps this tracker was created against. */
  budget(): ResolvedBudget;
  /** Every cap-exceeded evaluation, in the order they occurred. */
  hits(): readonly BudgetHit[];
}

/** The order caps are checked in when more than one is exceeded at once. */
const DECLARED_ORDER: readonly BudgetCap[] = [
  'usd',
  'tokens',
  'tier2Calls',
  'backtracks',
  'repairCalls',
  'wallMs',
];

/**
 * A cap of 0 means "disallowed" (any positive charge exceeds it
 * immediately); a cap that is not a finite number - `undefined` reaching
 * here despite `ResolvedBudget`'s type, which is the contract's own
 * language for "no limit was configured" - means unlimited and never
 * exceeds. `Infinity` is treated the same way for the same reason.
 */
function isCapped(limit: number): boolean {
  return limit !== undefined && Number.isFinite(limit);
}

/**
 * T19 (B44): derives the caps a run is tracked against from a resolved
 * `Profile`. Token counts are integers taken as-is; USD is a running figure
 * the caller supplies from T8's pricing at write time, not computed here.
 */
export function resolveBudget(profile: Profile): ResolvedBudget {
  return {
    usd: profile.budget.usd,
    tokens: profile.budget.tokens,
    wallMs: profile.budget.wallMs,
    tier2Calls: profile.escalation.maxTier2CallsPerPuzzle,
    backtracks: profile.search.maxBacktracks,
    repairCalls: profile.repair.maxCalls,
  };
}

export function createBudgetTracker(
  budget: ResolvedBudget,
  opts?: { now?: () => number },
): BudgetTracker {
  const now = opts?.now ?? Date.now;
  const startMs = now();

  const spent: BudgetSpend = {
    usd: 0,
    tokens: 0,
    tier2Calls: 0,
    backtracks: 0,
    repairCalls: 0,
    wallMs: 0,
  };
  const hits: BudgetHit[] = [];

  function evaluate(): BudgetCap | null {
    spent.wallMs = now() - startMs;
    for (const cap of DECLARED_ORDER) {
      const limit = budget[cap];
      const actual = spent[cap];
      if (isCapped(limit) && actual > limit) {
        hits.push({ cap, limit, actual, atMs: spent.wallMs });
        return cap;
      }
    }
    return null;
  }

  return {
    charge(cap, amount) {
      spent[cap] += amount;
      return { exceeded: evaluate() };
    },
    checkWallClock() {
      return { exceeded: evaluate() };
    },
    snapshot() {
      spent.wallMs = now() - startMs;
      return { ...spent };
    },
    budget() {
      return { ...budget };
    },
    hits() {
      return [...hits];
    },
  };
}
