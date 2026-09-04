import { describe, expect, it } from 'vitest';

import { ExitCode, isCliError } from '../../../src/cli/exit.js';
import {
  baseline,
  batch1,
  batch2,
  batch3,
  batch5,
  batch8,
  builtinNames,
  eagerEscalation,
  getBuiltin,
  getBuiltins,
  noRepair,
  patient,
  strongOnly,
  tier1Only,
  votes3,
} from '../../../src/profiles/builtins.js';
import { ProfileSchema } from '../../../src/profiles/schema.js';
import type { Profile } from '../../../src/profiles/schema.js';

const EXPECTED_NAMES = [
  'baseline',
  'eager-escalation',
  'patient',
  'no-repair',
  'tier1-only',
  'strong-only',
  'votes3',
  'batch1',
  'batch2',
  'batch3',
  'batch5',
  'batch8',
];

/** Every built-in field that a spec test below asserts differs from `baseline`. */
const EXPECTED_DIFFERENCE_FROM_BASELINE: Record<string, (p: Profile) => unknown> = {
  'eager-escalation': (p) => p.escalation.policy,
  patient: (p) => p.reasksPerSlot,
  'no-repair': (p) => p.repair.enabled,
  'tier1-only': (p) => p.escalation.maxTier2CallsPerPuzzle,
  'strong-only': (p) => p.tier1,
  votes3: (p) => p.calibration,
  batch2: (p) => p.batchSize,
  batch3: (p) => p.batchSize,
  batch5: (p) => p.batchSize,
  batch8: (p) => p.batchSize,
};

/**
 * Names that are members of `Object.prototype` rather than built-in profiles.
 * A plain-object map would answer for every one of them - `BUILTINS['__proto__']`
 * with `Object.prototype` (which `structuredClone` turns into `{}`, typed
 * `Profile`, with no error at all) and the rest with functions (which
 * `structuredClone` rejects with a `DataCloneError`: not a `CliError`, so exit
 * 1 with a stack trace rather than the promised usage error).
 */
const PROTOTYPE_MEMBER_NAMES = [
  '__proto__',
  'constructor',
  'toString',
  'hasOwnProperty',
  'valueOf',
  'isPrototypeOf',
];

describe('builtins', () => {
  it('builtinNames() lists exactly the twelve documented names', () => {
    expect(builtinNames().sort()).toEqual([...EXPECTED_NAMES].sort());
  });

  it('getBuiltins() returns the same set, keyed by name', () => {
    const all = getBuiltins();
    expect(Object.keys(all).sort()).toEqual([...EXPECTED_NAMES].sort());
    for (const [key, profile] of Object.entries(all)) {
      expect(profile.name).toBe(key);
      // Table-driven B8 acceptance: every entry in the map parses cleanly.
      expect(() => ProfileSchema.parse(profile)).not.toThrow();
    }
  });

  it('getBuiltins() returns a fresh, independently mutable copy each call', () => {
    const first = getBuiltins();
    const firstBaseline = first['baseline'];
    expect(firstBaseline).toBeDefined();
    if (firstBaseline === undefined) return;
    firstBaseline.tier1 = 'mutated';
    // A nested group is not a shallow-copied reference either: mutating it
    // must never reach the shared module-level literal.
    firstBaseline.sampling.temperature = 1.9;

    const second = getBuiltins();
    const secondBaseline = second['baseline'];
    expect(secondBaseline?.tier1).toBe('nvidia/Nemotron-3_5-Lightning');
    expect(secondBaseline?.sampling.temperature).toBe(0.2);
    expect(baseline.sampling.temperature).toBe(0.2);
  });

  it('getBuiltin() returns a fresh copy of one named profile', () => {
    const a = getBuiltin('baseline');
    a.tier1 = 'mutated';
    a.sampling.temperature = 1.9;
    const b = getBuiltin('baseline');
    expect(b.tier1).toBe('nvidia/Nemotron-3_5-Lightning');
    expect(b.sampling.temperature).toBe(0.2);
    expect(baseline.sampling.temperature).toBe(0.2);
  });

  it('getBuiltin() throws a usage CliError naming the unknown profile', () => {
    let error: unknown;
    try {
      getBuiltin('does-not-exist');
    } catch (e) {
      error = e;
    }
    expect(isCliError(error)).toBe(true);
    if (isCliError(error)) {
      expect(error.code).toBe(ExitCode.USAGE);
      expect(error.message).toContain('does-not-exist');
    }
  });


  it('builtinNames() carries no Object.prototype member as a profile name', () => {
    // Declaration order, not just set membership: it is what the error hints
    // and T47's `--profiles` listing show.
    expect(builtinNames()).toEqual(EXPECTED_NAMES);
    for (const name of PROTOTYPE_MEMBER_NAMES) {
      expect(builtinNames()).not.toContain(name);
    }
  });

  it('getBuiltins() carries no Object.prototype member as an own key', () => {
    const all = getBuiltins();
    for (const name of PROTOTYPE_MEMBER_NAMES) {
      expect(Object.hasOwn(all, name)).toBe(false);
    }
  });

  it.each(PROTOTYPE_MEMBER_NAMES)(
    'getBuiltin("%s") throws a usage CliError instead of resolving a prototype member',
    (name) => {
      let error: unknown;
      try {
        getBuiltin(name);
      } catch (e) {
        error = e;
      }
      expect(isCliError(error)).toBe(true);
      if (isCliError(error)) {
        expect(error.code).toBe(ExitCode.USAGE);
        expect(error.message).toContain(name);
      }
    },
  );

  it.each(EXPECTED_NAMES)('%s parses through ProfileSchema without error', (name) => {
    const profile = getBuiltin(name);
    expect(() => ProfileSchema.parse(profile)).not.toThrow();
  });

  it.each(Object.entries(EXPECTED_DIFFERENCE_FROM_BASELINE))(
    '%s differs from baseline in its intended field',
    (name, extractField) => {
      const profile = getBuiltin(name);
      expect(extractField(profile)).not.toEqual(extractField(baseline));
    },
  );

  it('eager-escalation has escalation.policy "eager" and reasksPerSlot 0', () => {
    expect(eagerEscalation.escalation.policy).toBe('eager');
    expect(eagerEscalation.reasksPerSlot).toBe(0);
  });

  it('patient has reasksPerSlot 3 and search.maxBacktracks 500', () => {
    expect(patient.reasksPerSlot).toBe(3);
    expect(patient.search.maxBacktracks).toBe(500);
  });

  it('no-repair disables repair and nothing else', () => {
    expect(noRepair.repair.enabled).toBe(false);
    const { repair: _repair, name: _name, ...rest } = noRepair;
    const { repair: _baselineRepair, name: _baselineName, ...baselineRest } = baseline;
    expect(rest).toEqual(baselineRest);
    expect(noRepair.repair).toEqual({ ...baseline.repair, enabled: false });
  });

  it('tier1-only has maxTier2CallsPerPuzzle 0', () => {
    expect(tier1Only.escalation.maxTier2CallsPerPuzzle).toBe(0);
  });

  it('carries the T62 tier-2 allowance of 25 everywhere except tier1-only', () => {
    // T62 raised it from 15: the canonical bench spent the 15 on all-`?`
    // escalations at termination, and the constrained re-ask firing first
    // means the cap now has to cover the slots that reach tier 2 with letters
    // on the board.
    expect(baseline.escalation.maxTier2CallsPerPuzzle).toBe(25);
    expect(eagerEscalation.escalation.maxTier2CallsPerPuzzle).toBe(25);
    expect(patient.escalation.maxTier2CallsPerPuzzle).toBe(25);
    for (const [name, profile] of Object.entries(getBuiltins())) {
      expect(
        profile.escalation.maxTier2CallsPerPuzzle,
        `${name} tier-2 allowance`,
      ).toBe(name === 'tier1-only' ? 0 : 25);
    }
  });

  it('strong-only raises tier1 to the strong model and the budget', () => {
    expect(strongOnly.tier1).toBe('deepseek-ai/DeepSeek-V4-Pro');
    expect(strongOnly.budget.usd).toBe(2.0);
  });

  it('votes3 has calibration "votes", samples 3, and sampling.temperature 0.7 (B22 refine)', () => {
    expect(votes3.calibration).toBe('votes');
    expect(votes3.samples).toBe(3);
    expect(votes3.sampling.temperature).toBe(0.7);
  });

  it('batch1 is baseline under another name', () => {
    const { name: _n1, ...batch1Rest } = batch1;
    const { name: _n2, ...baselineRest } = baseline;
    expect(batch1Rest).toEqual(baselineRest);
    expect(batch1.batchSize).toBe(1);
  });

  it('batch5 has batchSize 5 and every other field equal to baseline', () => {
    expect(batch5.batchSize).toBe(5);
    const { batchSize: _batchSize, name: _name, ...rest } = batch5;
    const { batchSize: _baselineBatchSize, name: _baselineName, ...baselineRest } = baseline;
    expect(rest).toEqual(baselineRest);
  });

  it.each([
    ['batch1', batch1, 1],
    ['batch2', batch2, 2],
    ['batch3', batch3, 3],
    ['batch5', batch5, 5],
    ['batch8', batch8, 8],
  ] as const)('%s has batchSize %i and is otherwise baseline', (_label, profile, size) => {
    expect(profile.batchSize).toBe(size);
    const { batchSize: _batchSize, name: _name, ...rest } = profile;
    const { batchSize: _baselineBatchSize, name: _baselineName, ...baselineRest } = baseline;
    expect(rest).toEqual(baselineRest);
  });
});
