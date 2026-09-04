import { describe, expect, it } from 'vitest';

import { decide } from '../../../src/policy/escalation.js';
import type { EscalationContext } from '../../../src/policy/types.js';
import type { Profile } from '../../../src/profiles/schema.js';

/** A fully-populated Profile, close to the `baseline` built-in. */
function makeProfile(overrides: {
  policy?: 'reask-first' | 'eager' | 'patient';
  reasksPerSlot?: number;
  maxTier2CallsPerPuzzle?: number;
  escalationsPerSlot?: number;
  clueUnderstoodThreshold?: number;
}): Profile {
  return {
    name: 'test-profile',
    tier1: 'nvidia/Nemotron-3_5-Lightning',
    tier2: 'deepseek-ai/DeepSeek-V4-Pro',
    candidatesPerAsk: 10,
    calibration: 'rank',
    samples: 1,
    batchSize: 1,
    reasksPerSlot: overrides.reasksPerSlot ?? 2,
    sampling: { temperature: 0.2, maxTokens: 512 },
    escalation: {
      policy: overrides.policy ?? 'reask-first',
      clueUnderstoodThreshold: overrides.clueUnderstoodThreshold ?? 0.4,
      maxTier2CallsPerPuzzle: overrides.maxTier2CallsPerPuzzle ?? 15,
      escalationsPerSlot: overrides.escalationsPerSlot ?? 1,
    },
    search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
    repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
    budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
    rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
    promptVersion: '1',
  };
}

function makeCtx(overrides: Partial<EscalationContext> & { profile: Profile }): EscalationContext {
  return {
    slotId: '1A',
    point: 'after-candidates',
    clueUnderstood: null,
    domainSize: 5,
    parseFailures: 0,
    reasksUsed: 0,
    escalationsUsed: 0,
    tier2CallsUsed: 0,
    patternFixedLetters: 0,
    lastPatternQueried: null,
    currentPattern: '?????',
    budget: {
      usd: 0.5,
      tokens: 2_000_000,
      wallMs: 900_000,
      tier2Calls: overrides.profile.escalation.maxTier2CallsPerPuzzle,
      backtracks: 200,
      repairCalls: 30,
    },
    spent: { usd: 0, tokens: 0, wallMs: 0, tier2Calls: 0, backtracks: 0, repairCalls: 0 },
    ...overrides,
  };
}

/**
 * A pattern with two letters already fixed by crossings. T62 makes a
 * constrained re-ask "available" only when the pattern carries at least one
 * fixed letter, so every row below that expects a `reask` has to say so: an
 * all-`?` pattern (the `makeCtx` default) is the case where there is nothing
 * for a second cheap ask to use.
 */
const CONSTRAINED = { patternFixedLetters: 2, currentPattern: 'A?I?N' } as const;

/**
 * Acceptance 1: a table-driven test, one row per trigger (five rows) x three
 * policies (15 cases), asserting `action` and `trigger`.
 *
 * `reasksPerSlot` is varied per row where needed to make a trigger reachable
 * under a given policy: real `eager` profiles set `reasksPerSlot: 0`, which
 * (per the deviation documented in src/policy/escalation.ts) makes trigger 4
 * unreachable in production for that policy, since trigger 4 is approximated
 * from `reasksUsed` reaching `reasksPerSlot`. The `eager` / trigger-4 row
 * below uses `reasksPerSlot: 1` purely to exercise that code path in
 * isolation; it does not claim that is a realistic eager profile.
 */
const table: Array<{
  policy: 'reask-first' | 'eager' | 'patient';
  trigger: 1 | 2 | 3 | 4 | 5;
  ctx: EscalationContext;
  action: 'none' | 'reask' | 'escalate' | 'give-up';
}> = [
  // reask-first: prefers reask while reasksPerSlot remains.
  {
    policy: 'reask-first',
    trigger: 1,
    ctx: makeCtx({
      profile: makeProfile({ policy: 'reask-first' }),
      domainSize: 0,
      reasksUsed: 0,
      ...CONSTRAINED,
    }),
    action: 'reask',
  },
  {
    policy: 'reask-first',
    trigger: 2,
    ctx: makeCtx({
      profile: makeProfile({ policy: 'reask-first' }),
      domainSize: 0,
      reasksUsed: 1,
      ...CONSTRAINED,
    }),
    action: 'reask',
  },
  {
    policy: 'reask-first',
    trigger: 3,
    ctx: makeCtx({
      profile: makeProfile({ policy: 'reask-first' }),
      domainSize: 5,
      clueUnderstood: 0.1,
      reasksUsed: 0,
      escalationsUsed: 0,
      ...CONSTRAINED,
    }),
    action: 'reask',
  },
  {
    policy: 'reask-first',
    trigger: 4,
    ctx: makeCtx({
      profile: makeProfile({ policy: 'reask-first', reasksPerSlot: 2 }),
      domainSize: 5,
      reasksUsed: 2,
    }),
    action: 'escalate',
  },
  {
    policy: 'reask-first',
    trigger: 5,
    ctx: makeCtx({
      profile: makeProfile({ policy: 'reask-first' }),
      point: 'at-termination',
      domainSize: 0,
    }),
    action: 'escalate',
  },

  // eager: always prefers escalate, never reask.
  {
    policy: 'eager',
    trigger: 1,
    ctx: makeCtx({
      profile: makeProfile({ policy: 'eager', reasksPerSlot: 0 }),
      domainSize: 0,
      reasksUsed: 0,
    }),
    action: 'escalate',
  },
  {
    policy: 'eager',
    trigger: 2,
    ctx: makeCtx({
      profile: makeProfile({ policy: 'eager', reasksPerSlot: 0 }),
      domainSize: 0,
      reasksUsed: 1,
    }),
    action: 'escalate',
  },
  {
    policy: 'eager',
    trigger: 3,
    ctx: makeCtx({
      profile: makeProfile({ policy: 'eager', reasksPerSlot: 0 }),
      domainSize: 5,
      clueUnderstood: 0.1,
      reasksUsed: 0,
      escalationsUsed: 0,
    }),
    action: 'escalate',
  },
  {
    policy: 'eager',
    trigger: 4,
    ctx: makeCtx({
      // See the table doc comment: reasksPerSlot: 1 here only, to reach
      // trigger 4's detection path at all.
      profile: makeProfile({ policy: 'eager', reasksPerSlot: 1 }),
      domainSize: 5,
      reasksUsed: 1,
    }),
    action: 'escalate',
  },
  {
    policy: 'eager',
    trigger: 5,
    ctx: makeCtx({
      profile: makeProfile({ policy: 'eager', reasksPerSlot: 0 }),
      point: 'at-termination',
      domainSize: 0,
    }),
    action: 'escalate',
  },

  // patient: prefers reask while re-asks remain, escalates only on trigger 5.
  {
    policy: 'patient',
    trigger: 1,
    ctx: makeCtx({
      profile: makeProfile({ policy: 'patient' }),
      domainSize: 0,
      reasksUsed: 0,
      ...CONSTRAINED,
    }),
    action: 'reask',
  },
  {
    policy: 'patient',
    trigger: 2,
    ctx: makeCtx({
      profile: makeProfile({ policy: 'patient' }),
      domainSize: 0,
      reasksUsed: 1,
      ...CONSTRAINED,
    }),
    action: 'reask',
  },
  {
    policy: 'patient',
    trigger: 3,
    ctx: makeCtx({
      profile: makeProfile({ policy: 'patient' }),
      domainSize: 5,
      clueUnderstood: 0.1,
      reasksUsed: 0,
      escalationsUsed: 0,
      ...CONSTRAINED,
    }),
    action: 'reask',
  },
  {
    policy: 'patient',
    trigger: 4,
    ctx: makeCtx({
      profile: makeProfile({ policy: 'patient', reasksPerSlot: 2 }),
      domainSize: 5,
      reasksUsed: 2,
    }),
    action: 'none',
  },
  {
    policy: 'patient',
    trigger: 5,
    ctx: makeCtx({
      profile: makeProfile({ policy: 'patient' }),
      point: 'at-termination',
      domainSize: 0,
    }),
    action: 'escalate',
  },
];

describe('decide (table-driven, B13)', () => {
  for (const { policy, trigger, ctx, action } of table) {
    it(`${policy} / trigger ${String(trigger)} -> ${action}`, () => {
      const result = decide(ctx);
      expect(result.trigger).toBe(trigger);
      expect(result.action).toBe(action);
    });
  }
});

describe('decide precedence and caps', () => {
  it('trigger 1 wins over trigger 3 when both hold', () => {
    // Zero candidates (trigger 1) and a low clue_understood (trigger 3) at
    // once: trigger 1 must win and trigger 3 must not even be evaluated.
    const ctx = makeCtx({
      profile: makeProfile({ policy: 'reask-first' }),
      domainSize: 0,
      reasksUsed: 0,
      clueUnderstood: 0.1,
      escalationsUsed: 0,
    });
    expect(decide(ctx).trigger).toBe(1);
  });

  it('downgrades escalate to reask when maxTier2CallsPerPuzzle is exhausted, naming the cap', () => {
    const profile = makeProfile({ policy: 'eager', maxTier2CallsPerPuzzle: 3, reasksPerSlot: 3 });
    const ctx = makeCtx({
      profile,
      domainSize: 0,
      reasksUsed: 1,
      tier2CallsUsed: 3,
      ...CONSTRAINED,
    });
    const result = decide(ctx);
    expect(result.trigger).toBe(2);
    expect(result.action).toBe('reask');
    expect(result.reason).toContain('maxTier2CallsPerPuzzle');
  });

  it('downgrades to none when both tier-2 calls and re-asks are exhausted, naming both caps', () => {
    const profile = makeProfile({ policy: 'eager', maxTier2CallsPerPuzzle: 3, reasksPerSlot: 3 });
    const ctx = makeCtx({
      profile,
      domainSize: 0,
      reasksUsed: 3,
      tier2CallsUsed: 3,
      ...CONSTRAINED,
    });
    const result = decide(ctx);
    expect(result.trigger).toBe(2);
    expect(result.action).toBe('none');
    expect(result.reason).toContain('maxTier2CallsPerPuzzle');
    expect(result.reason).toContain('reasksPerSlot');
  });

  it('eager (reasksPerSlot: 0) never returns reask for any of the five triggers, even with caps exhausted', () => {
    const spentProfile = makeProfile({ policy: 'eager', reasksPerSlot: 0, maxTier2CallsPerPuzzle: 0, escalationsPerSlot: 0 });
    const cases: EscalationContext[] = [
      makeCtx({ profile: spentProfile, domainSize: 0, reasksUsed: 0 }), // trigger 1
      makeCtx({ profile: spentProfile, domainSize: 0, reasksUsed: 1 }), // trigger 2 (bespoke, see table doc)
      makeCtx({ profile: spentProfile, domainSize: 5, clueUnderstood: 0.1, reasksUsed: 0, escalationsUsed: 0 }), // trigger 3
      makeCtx({ profile: makeProfile({ policy: 'eager', reasksPerSlot: 1, maxTier2CallsPerPuzzle: 0, escalationsPerSlot: 0 }), domainSize: 5, reasksUsed: 1 }), // trigger 4
      makeCtx({ profile: spentProfile, point: 'at-termination', domainSize: 0 }), // trigger 5
    ];
    for (const ctx of cases) {
      expect(decide(ctx).action).not.toBe('reask');
    }
  });

  it('at search termination with an empty slot and all caps spent, gives up with trigger 5', () => {
    const profile = makeProfile({
      policy: 'reask-first',
      reasksPerSlot: 2,
      maxTier2CallsPerPuzzle: 5,
      escalationsPerSlot: 1,
    });
    const ctx = makeCtx({
      profile,
      point: 'at-termination',
      domainSize: 0,
      reasksUsed: 2,
      tier2CallsUsed: 5,
      escalationsUsed: 1,
    });
    const result = decide(ctx);
    expect(result.trigger).toBe(5);
    expect(result.action).toBe('give-up');
  });

  it('is referentially transparent and does not mutate a frozen context', () => {
    const profile = makeProfile({ policy: 'reask-first' });
    const ctx = Object.freeze(
      makeCtx({ profile, domainSize: 0, reasksUsed: 1, ...CONSTRAINED }),
    );
    const first = decide(ctx);
    const second = decide(ctx);
    expect(second).toEqual(first);
    expect(ctx.domainSize).toBe(0);
    expect(ctx.reasksUsed).toBe(1);
  });
});

/**
 * T62. The one signal that makes a constrained re-ask worth its call is a
 * fixed letter in the pattern. Without one, `reask-first` used to choose a
 * `reask` that the search hooks were bound to refuse, and the slot idled
 * until trigger 5 escalated it at termination with an all-`?` pattern.
 */
describe('decide: a re-ask needs a fixed letter (T62)', () => {
  it('escalates immediately on an empty domain with no fixed letter under reask-first', () => {
    const profile = makeProfile({ policy: 'reask-first', reasksPerSlot: 2 });
    const result = decide(
      makeCtx({ profile, domainSize: 0, reasksUsed: 0, patternFixedLetters: 0 }),
    );
    expect(result.trigger).toBe(1);
    expect(result.action).toBe('escalate');
  });

  it('re-asks on an empty domain with fixed letters and re-asks remaining', () => {
    const profile = makeProfile({ policy: 'reask-first', reasksPerSlot: 2 });
    const result = decide(makeCtx({ profile, domainSize: 0, reasksUsed: 0, ...CONSTRAINED }));
    expect(result.trigger).toBe(1);
    expect(result.action).toBe('reask');
  });

  it('downgrades to none, naming both blockers, when the tier-2 cap is spent and nothing is fixed', () => {
    const profile = makeProfile({
      policy: 'reask-first',
      reasksPerSlot: 2,
      maxTier2CallsPerPuzzle: 3,
    });
    const result = decide(
      makeCtx({ profile, domainSize: 0, reasksUsed: 0, tier2CallsUsed: 3, patternFixedLetters: 0 }),
    );
    expect(result.trigger).toBe(1);
    expect(result.action).toBe('none');
    expect(result.reason).toContain('maxTier2CallsPerPuzzle');
    expect(result.reason).toContain('no fixed letter');
  });

  it('still downgrades an escalation to a re-ask when the pattern is constrained', () => {
    // `eager` is the policy that reaches for tier 2 first, so it is the one
    // whose downgrade path the fixed-letter condition has to leave intact.
    const profile = makeProfile({
      policy: 'eager',
      reasksPerSlot: 2,
      maxTier2CallsPerPuzzle: 3,
    });
    const result = decide(
      makeCtx({ profile, domainSize: 0, reasksUsed: 0, tier2CallsUsed: 3, ...CONSTRAINED }),
    );
    expect(result.action).toBe('reask');
    expect(result.reason).toContain('maxTier2CallsPerPuzzle');
  });

  it('gives up at termination when the slot is empty, unconstrained and the tier-2 cap is spent', () => {
    const profile = makeProfile({
      policy: 'patient',
      reasksPerSlot: 3,
      maxTier2CallsPerPuzzle: 2,
    });
    const result = decide(
      makeCtx({
        profile,
        point: 'at-termination',
        domainSize: 0,
        tier2CallsUsed: 2,
        patternFixedLetters: 0,
      }),
    );
    expect(result.trigger).toBe(5);
    expect(result.action).toBe('give-up');
  });

  it('leaves patient with nothing to do when a wipeout has no fixed letter to re-ask on', () => {
    // `patient` never escalates before trigger 5, so an unconstrained wipeout
    // has no action available to it at all - which is the policy working as
    // specified, not a cap refusing anything.
    const profile = makeProfile({ policy: 'patient', reasksPerSlot: 3 });
    const result = decide(
      makeCtx({ profile, domainSize: 0, reasksUsed: 0, patternFixedLetters: 0 }),
    );
    expect(result.trigger).toBe(1);
    expect(result.action).toBe('none');
    expect(result.reason).toContain('action: none');
  });
});
