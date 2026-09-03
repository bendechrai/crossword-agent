import type { Profile } from '../profiles/schema.js';
import type { BudgetCap, BudgetHit, BudgetSpend, ResolvedBudget } from './types.js';

/**
 * The caps `charge` accepts. `wallMs` is excluded: it is never "spent" by an
 * explicit amount, it accrues on its own from the injected `now()`, and is
 * observed through `checkWallClock` (or picked up incidentally by any
 * `charge` call, since it is a run-global cap checked on every evaluation).
 */
export type ChargeableBudgetCap = Exclude<BudgetCap, 'wallMs'>;

/**
 * Accumulates spend against a `ResolvedBudget`. Hitting a cap is reported,
 * never thrown: the caller emits `budget:hit` and ends the current phase
 * gracefully, then the pipeline proceeds to the next phase (docs/spec.md
 * "Budget-cap behaviour").
 */
export interface BudgetTracker {
  /**
   * Records `amount` against `cap`, then evaluates the *run-global* caps
   * (usd, tokens, tier2Calls, wallMs) plus `cap` itself, in the declared
   * order (usd, tokens, tier2Calls, backtracks, repairCalls, wallMs), and
   * returns the first one currently exceeded - not necessarily `cap`
   * itself, since a charge to one cap can surface an already-crossed
   * run-global cap earlier in the order. The two phase-scoped caps
   * (backtracks, repairCalls) are checked only when they are the cap being
   * charged: an exhausted search-phase `backtracks` cap must not block the
   * repair phase's `repairCalls` charges, since the spec has the pipeline
   * proceed to the next phase on a cap hit rather than stay blocked by a
   * prior phase's counter. Monotonic: the charge is recorded whether or not
   * it exceeds, so `snapshot()` stays truthful. A `BudgetHit` is appended to
   * `hits()` only the first time a given cap is found exceeded; later
   * charges keep returning that cap without growing `hits()`.
   */
  charge(cap: ChargeableBudgetCap, amount: number): { exceeded: BudgetCap | null };
  /**
   * Evaluates the run-global caps (usd, tokens, tier2Calls, wallMs) against
   * the injected `now()` without recording a charge - the way wall-clock
   * exhaustion is noticed between charges, e.g. at a search-loop iteration
   * boundary that spent nothing this tick. The phase-scoped caps
   * (backtracks, repairCalls) are never surfaced here, since no charge is
   * being made against either of them.
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
 * Caps that apply across the whole run and are therefore checked on every
 * evaluation regardless of which cap was charged. `backtracks` and
 * `repairCalls` are deliberately excluded: they are phase-scoped counters
 * (search and repair respectively), and an already-exceeded one must not
 * stop a later phase's own charges from being evaluated on their own terms
 * - see docs/spec.md "Budget-cap behaviour" ("the pipeline proceeds to the
 * next phase").
 */
const GLOBAL_CAPS: ReadonlySet<BudgetCap> = new Set(['usd', 'tokens', 'tier2Calls', 'wallMs']);

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
  /** Caps a `BudgetHit` has already been recorded for, so later evaluations
   * of an already-exceeded cap keep returning it without appending again. */
  const hitCaps = new Set<BudgetCap>();

  /**
   * Checks the run-global caps plus `chargedCap` (if given) in declared
   * order and returns the first one currently exceeded. `chargedCap` is
   * omitted for `checkWallClock()`, which never charges anything and so
   * only ever surfaces a run-global cap.
   */
  function evaluate(chargedCap?: ChargeableBudgetCap): BudgetCap | null {
    spent.wallMs = now() - startMs;
    for (const cap of DECLARED_ORDER) {
      if (!GLOBAL_CAPS.has(cap) && cap !== chargedCap) {
        continue;
      }
      const limit = budget[cap];
      const actual = spent[cap];
      if (isCapped(limit) && actual > limit) {
        if (!hitCaps.has(cap)) {
          hitCaps.add(cap);
          hits.push({ cap, limit, actual, atMs: spent.wallMs });
        }
        return cap;
      }
    }
    return null;
  }

  return {
    charge(cap, amount) {
      spent[cap] += amount;
      return { exceeded: evaluate(cap) };
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
