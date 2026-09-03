import { describe, expect, it } from 'vitest';

import { createBudgetTracker, resolveBudget } from '../../../src/policy/budget.js';
import type { ResolvedBudget } from '../../../src/policy/types.js';
import { ProfileSchema } from '../../../src/profiles/schema.js';

/**
 * `builtins.ts` (T23) is not implemented yet, so "the `baseline` built-in"
 * is stood in for by the schema defaults it is defined to equal (see
 * docs/spec.md "Strategy profiles": `baseline` writes out every default
 * literally). `test/unit/profiles/schema.test.ts` pins that same object.
 */
const baselineProfile = ProfileSchema.parse({ name: 'baseline' });

/** A budget with every cap generously large, so a test can override just the one it cares about. */
function permissiveBudget(overrides: Partial<ResolvedBudget> = {}): ResolvedBudget {
  return {
    usd: 1_000,
    tokens: 1_000_000,
    wallMs: 1_000_000,
    tier2Calls: 1_000,
    backtracks: 1_000,
    repairCalls: 1_000,
    ...overrides,
  };
}

/** A cap left unset, the way an omitted profile field would resolve - typed `number` by the
 * frozen `ResolvedBudget` contract, but `undefined` in practice. */
const UNLIMITED = undefined as unknown as number;

describe('resolveBudget', () => {
  it('derives the spec defaults from the baseline profile, asserted as literals (acceptance 1)', () => {
    expect(resolveBudget(baselineProfile)).toEqual({
      usd: 0.5,
      tokens: 2_000_000,
      wallMs: 900_000,
      tier2Calls: 15,
      backtracks: 200,
      repairCalls: 30,
    });
  });

  it('reads tier2Calls, backtracks and repairCalls from their own profile groups, not budget', () => {
    const profile = ProfileSchema.parse({
      name: 'custom',
      escalation: { maxTier2CallsPerPuzzle: 3 },
      search: { maxBacktracks: 7 },
      repair: { maxCalls: 2 },
      budget: { usd: 9, tokens: 5, wallMs: 11 },
    });
    expect(resolveBudget(profile)).toEqual({
      usd: 9,
      tokens: 5,
      wallMs: 11,
      tier2Calls: 3,
      backtracks: 7,
      repairCalls: 2,
    });
  });
});

describe('BudgetTracker.charge', () => {
  it('returns exceeded: null under the cap, the cap on the charge that crosses it, and keeps returning it as actual grows (acceptance 2)', () => {
    const tracker = createBudgetTracker(permissiveBudget({ repairCalls: 10 }));

    expect(tracker.charge('repairCalls', 4).exceeded).toBeNull();
    expect(tracker.snapshot().repairCalls).toBe(4);

    // Exactly at the cap is not yet exceeded - a budget of 10 permits spending 10.
    expect(tracker.charge('repairCalls', 6).exceeded).toBeNull();
    expect(tracker.snapshot().repairCalls).toBe(10);

    // This charge crosses it.
    expect(tracker.charge('repairCalls', 1).exceeded).toBe('repairCalls');
    expect(tracker.snapshot().repairCalls).toBe(11);

    // A further charge still reports the same cap, and the recorded actual keeps growing.
    expect(tracker.charge('repairCalls', 5).exceeded).toBe('repairCalls');
    expect(tracker.snapshot().repairCalls).toBe(16);
  });

  it('is monotonic: every charge is recorded whether or not it exceeds', () => {
    const tracker = createBudgetTracker(permissiveBudget({ backtracks: 1 }));
    tracker.charge('backtracks', 1);
    tracker.charge('backtracks', 1);
    tracker.charge('backtracks', 1);
    expect(tracker.snapshot().backtracks).toBe(3);
  });

  it('a cap of 0 for tier2Calls makes the first charge exceed (acceptance 3)', () => {
    const tracker = createBudgetTracker(permissiveBudget({ tier2Calls: 0 }));
    expect(tracker.charge('tier2Calls', 1).exceeded).toBe('tier2Calls');
    expect(tracker.snapshot().tier2Calls).toBe(1);
  });

  it('undefined for a cap never exceeds after 10,000 charges (acceptance 4)', () => {
    const tracker = createBudgetTracker(permissiveBudget({ backtracks: UNLIMITED }));
    let last: { exceeded: string | null } = { exceeded: 'unset' };
    for (let i = 0; i < 10_000; i += 1) {
      last = tracker.charge('backtracks', 1);
    }
    expect(last.exceeded).toBeNull();
    expect(tracker.snapshot().backtracks).toBe(10_000);
  });

  it('two caps crossed by one charge report the earlier one in the declared order (acceptance 6)', () => {
    let t = 0;
    const tracker = createBudgetTracker(permissiveBudget({ tokens: 100, wallMs: 1_000 }), {
      now: () => t,
    });

    // Wall-clock has already run past its cap before any charge is made...
    t = 5_000;
    // ...and this charge also crosses tokens. tokens precedes wallMs in the
    // declared order (usd, tokens, tier2Calls, backtracks, repairCalls, wallMs).
    expect(tracker.charge('tokens', 150).exceeded).toBe('tokens');
  });

  it('reports usd ahead of backtracks when both are already exceeded (declared order, general case)', () => {
    const tracker = createBudgetTracker(permissiveBudget({ usd: 1, backtracks: 1 }));
    tracker.charge('usd', 2); // exceeds usd only; reports usd
    expect(tracker.charge('backtracks', 2).exceeded).toBe('usd');
  });
});

describe('BudgetTracker.checkWallClock', () => {
  it('exceeds when the injected clock passes wallMs, with no charge call at all (acceptance 5)', () => {
    let t = 0;
    const tracker = createBudgetTracker(permissiveBudget({ wallMs: 1_000 }), { now: () => t });

    expect(tracker.checkWallClock().exceeded).toBeNull();

    t = 1_500;
    expect(tracker.checkWallClock().exceeded).toBe('wallMs');
  });

  it('never exceeds when wallMs is unlimited, however long the clock runs', () => {
    let t = 0;
    const tracker = createBudgetTracker(permissiveBudget({ wallMs: UNLIMITED }), { now: () => t });
    t = 10_000_000;
    expect(tracker.checkWallClock().exceeded).toBeNull();
  });
});

describe('BudgetTracker.snapshot', () => {
  it('returns every counter (acceptance 7)', () => {
    let t = 0;
    const tracker = createBudgetTracker(permissiveBudget(), { now: () => t });
    tracker.charge('usd', 1);
    tracker.charge('tokens', 2);
    tracker.charge('tier2Calls', 3);
    tracker.charge('backtracks', 4);
    tracker.charge('repairCalls', 5);
    t = 42;

    expect(tracker.snapshot()).toEqual({
      usd: 1,
      tokens: 2,
      tier2Calls: 3,
      backtracks: 4,
      repairCalls: 5,
      wallMs: 42,
    });
  });

  it('is safe to embed in a budget:hit payload - a plain, JSON-serialisable object', () => {
    const tracker = createBudgetTracker(permissiveBudget());
    tracker.charge('usd', 1);
    const snapshot = tracker.snapshot();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('returns a fresh object each time, not a live reference to internal state', () => {
    const tracker = createBudgetTracker(permissiveBudget());
    const first = tracker.snapshot();
    tracker.charge('usd', 1);
    expect(first.usd).toBe(0);
    expect(tracker.snapshot().usd).toBe(1);
  });
});

describe('BudgetTracker.budget', () => {
  it('returns the resolved caps the tracker was created against', () => {
    const budget = permissiveBudget({ usd: 42 });
    const tracker = createBudgetTracker(budget);
    expect(tracker.budget()).toEqual(budget);
  });
});

describe('BudgetTracker.hits', () => {
  it('accumulates one entry per exceeded evaluation, naming the cap, its limit and the actual at that point', () => {
    const tracker = createBudgetTracker(permissiveBudget({ repairCalls: 1 }));
    tracker.charge('repairCalls', 1); // at the cap, not exceeded
    tracker.charge('repairCalls', 1); // exceeds: actual 2 > limit 1
    tracker.charge('repairCalls', 1); // still exceeds: actual 3 > limit 1

    const hits = tracker.hits();
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ cap: 'repairCalls', limit: 1, actual: 2 });
    expect(hits[1]).toMatchObject({ cap: 'repairCalls', limit: 1, actual: 3 });
  });
});
