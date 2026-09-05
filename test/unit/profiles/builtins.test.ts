import { describe, expect, it } from 'vitest';

import { ExitCode, isCliError } from '../../../src/cli/exit.js';
import { PAIRED_PROMPT_VERSION, PROMPT_VERSION } from '../../../src/llm/prompts.js';
import {
  baseline,
  baselinePv3,
  batch1,
  batch2,
  batch3,
  batch5,
  batch8,
  builtinNames,
  eagerEscalation,
  getBuiltin,
  getBuiltins,
  maxAccuracy,
  noRepair,
  patient,
  strongOnly,
  strongOnlyUncapped,
  tier1Only,
  votes3,
} from '../../../src/profiles/builtins.js';
import { ProfileSchema, constrainedSamplesOf, reasoningOf } from '../../../src/profiles/schema.js';
import type { Profile } from '../../../src/profiles/schema.js';

/** T71's two additions, which most of the pre-T71 assertions below exclude. */
const T71_NAMES = ['max-accuracy', 'strong-only-uncapped'];

const EXPECTED_NAMES = [
  'baseline',
  'baseline-pv3',
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
  ...T71_NAMES,
];

/** Every built-in field that a spec test below asserts differs from `baseline`. */
const EXPECTED_DIFFERENCE_FROM_BASELINE: Record<string, (p: Profile) => unknown> = {
  'baseline-pv3': (p) => p.promptVersion,
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

/**
 * T71's proof that the pre-existing built-ins did not move: every one of the
 * thirteen literals as it stood before this task, copied verbatim from
 * `src/profiles/builtins.ts` at the parent commit, so a deep-equal against
 * the live module catches any field that changed, was added or was dropped.
 *
 * The two new optional fields (`constrainedSamples` and `reasoning`) are
 * absent here because they are absent from those profiles: an absent field
 * means the documented default (`src/profiles/schema.ts`), which is what
 * keeps the frozen run-record schema and the frozen contract suite valid.
 */
const PRE_T71_LITERALS: Record<string, Profile> = {
  'baseline': {
    name: 'baseline',
    tier1: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    tier2: 'deepseek-ai/DeepSeek-V4-Pro',
    candidatesPerAsk: 10,
    calibration: 'rank',
    samples: 1,
    batchSize: 1,
    reasksPerSlot: 2,
    sampling: { temperature: 0.2, maxTokens: 512 },
    escalation: {
      policy: 'reask-first',
      clueUnderstoodThreshold: 0.4,
      maxTier2CallsPerPuzzle: 25,
      escalationsPerSlot: 1,
    },
    search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
    repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
    budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
    rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
    promptVersion: PAIRED_PROMPT_VERSION,
  },
  'baseline-pv3': {
    name: 'baseline-pv3',
    tier1: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    tier2: 'deepseek-ai/DeepSeek-V4-Pro',
    candidatesPerAsk: 10,
    calibration: 'rank',
    samples: 1,
    batchSize: 1,
    reasksPerSlot: 2,
    sampling: { temperature: 0.2, maxTokens: 512 },
    escalation: {
      policy: 'reask-first',
      clueUnderstoodThreshold: 0.4,
      maxTier2CallsPerPuzzle: 25,
      escalationsPerSlot: 1,
    },
    search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
    repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
    budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
    rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
    promptVersion: PROMPT_VERSION,
  },
  'eager-escalation': {
    name: 'eager-escalation',
    tier1: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    tier2: 'deepseek-ai/DeepSeek-V4-Pro',
    candidatesPerAsk: 10,
    calibration: 'rank',
    samples: 1,
    batchSize: 1,
    reasksPerSlot: 0,
    sampling: { temperature: 0.2, maxTokens: 512 },
    escalation: {
      policy: 'eager',
      clueUnderstoodThreshold: 0.4,
      maxTier2CallsPerPuzzle: 25,
      escalationsPerSlot: 1,
    },
    search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
    repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
    budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
    rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
    promptVersion: PAIRED_PROMPT_VERSION,
  },
  'patient': {
    name: 'patient',
    tier1: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    tier2: 'deepseek-ai/DeepSeek-V4-Pro',
    candidatesPerAsk: 10,
    calibration: 'rank',
    samples: 1,
    batchSize: 1,
    reasksPerSlot: 3,
    sampling: { temperature: 0.2, maxTokens: 512 },
    escalation: {
      policy: 'patient',
      clueUnderstoodThreshold: 0.4,
      maxTier2CallsPerPuzzle: 25,
      escalationsPerSlot: 1,
    },
    search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 500 },
    repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
    budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
    rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
    promptVersion: PAIRED_PROMPT_VERSION,
  },
  'no-repair': {
    name: 'no-repair',
    tier1: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    tier2: 'deepseek-ai/DeepSeek-V4-Pro',
    candidatesPerAsk: 10,
    calibration: 'rank',
    samples: 1,
    batchSize: 1,
    reasksPerSlot: 2,
    sampling: { temperature: 0.2, maxTokens: 512 },
    escalation: {
      policy: 'reask-first',
      clueUnderstoodThreshold: 0.4,
      maxTier2CallsPerPuzzle: 25,
      escalationsPerSlot: 1,
    },
    search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
    repair: { enabled: false, maxCalls: 30, maxEditDistance: 2 },
    budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
    rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
    promptVersion: PAIRED_PROMPT_VERSION,
  },
  'tier1-only': {
    name: 'tier1-only',
    tier1: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    tier2: 'deepseek-ai/DeepSeek-V4-Pro',
    candidatesPerAsk: 10,
    calibration: 'rank',
    samples: 1,
    batchSize: 1,
    reasksPerSlot: 2,
    sampling: { temperature: 0.2, maxTokens: 512 },
    escalation: {
      policy: 'reask-first',
      clueUnderstoodThreshold: 0.4,
      maxTier2CallsPerPuzzle: 0,
      escalationsPerSlot: 0,
    },
    search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
    repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
    budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
    rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
    promptVersion: PAIRED_PROMPT_VERSION,
  },
  'strong-only': {
    name: 'strong-only',
    tier1: 'deepseek-ai/DeepSeek-V4-Pro',
    tier2: 'deepseek-ai/DeepSeek-V4-Pro',
    candidatesPerAsk: 10,
    calibration: 'rank',
    samples: 1,
    batchSize: 1,
    reasksPerSlot: 2,
    sampling: { temperature: 0.2, maxTokens: 512 },
    escalation: {
      policy: 'reask-first',
      clueUnderstoodThreshold: 0.4,
      maxTier2CallsPerPuzzle: 25,
      escalationsPerSlot: 1,
    },
    search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
    repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
    budget: { usd: 2.0, tokens: 2_000_000, wallMs: 900_000 },
    rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 16, maxConcurrencyTier2: 16 },
    promptVersion: PAIRED_PROMPT_VERSION,
  },
  'votes3': {
    name: 'votes3',
    tier1: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    tier2: 'deepseek-ai/DeepSeek-V4-Pro',
    candidatesPerAsk: 10,
    calibration: 'votes',
    samples: 3,
    batchSize: 1,
    reasksPerSlot: 2,
    sampling: { temperature: 0.7, maxTokens: 512 },
    escalation: {
      policy: 'reask-first',
      clueUnderstoodThreshold: 0.4,
      maxTier2CallsPerPuzzle: 25,
      escalationsPerSlot: 1,
    },
    search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
    repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
    budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
    rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
    promptVersion: PAIRED_PROMPT_VERSION,
  },
  'batch1': {
    name: 'batch1',
    tier1: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    tier2: 'deepseek-ai/DeepSeek-V4-Pro',
    candidatesPerAsk: 10,
    calibration: 'rank',
    samples: 1,
    batchSize: 1,
    reasksPerSlot: 2,
    sampling: { temperature: 0.2, maxTokens: 512 },
    escalation: {
      policy: 'reask-first',
      clueUnderstoodThreshold: 0.4,
      maxTier2CallsPerPuzzle: 25,
      escalationsPerSlot: 1,
    },
    search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
    repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
    budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
    rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
    promptVersion: PAIRED_PROMPT_VERSION,
  },
  'batch2': {
    name: 'batch2',
    tier1: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    tier2: 'deepseek-ai/DeepSeek-V4-Pro',
    candidatesPerAsk: 10,
    calibration: 'rank',
    samples: 1,
    batchSize: 2,
    reasksPerSlot: 2,
    sampling: { temperature: 0.2, maxTokens: 512 },
    escalation: {
      policy: 'reask-first',
      clueUnderstoodThreshold: 0.4,
      maxTier2CallsPerPuzzle: 25,
      escalationsPerSlot: 1,
    },
    search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
    repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
    budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
    rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
    promptVersion: PAIRED_PROMPT_VERSION,
  },
  'batch3': {
    name: 'batch3',
    tier1: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    tier2: 'deepseek-ai/DeepSeek-V4-Pro',
    candidatesPerAsk: 10,
    calibration: 'rank',
    samples: 1,
    batchSize: 3,
    reasksPerSlot: 2,
    sampling: { temperature: 0.2, maxTokens: 512 },
    escalation: {
      policy: 'reask-first',
      clueUnderstoodThreshold: 0.4,
      maxTier2CallsPerPuzzle: 25,
      escalationsPerSlot: 1,
    },
    search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
    repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
    budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
    rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
    promptVersion: PAIRED_PROMPT_VERSION,
  },
  'batch5': {
    name: 'batch5',
    tier1: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    tier2: 'deepseek-ai/DeepSeek-V4-Pro',
    candidatesPerAsk: 10,
    calibration: 'rank',
    samples: 1,
    batchSize: 5,
    reasksPerSlot: 2,
    sampling: { temperature: 0.2, maxTokens: 512 },
    escalation: {
      policy: 'reask-first',
      clueUnderstoodThreshold: 0.4,
      maxTier2CallsPerPuzzle: 25,
      escalationsPerSlot: 1,
    },
    search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
    repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
    budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
    rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
    promptVersion: PAIRED_PROMPT_VERSION,
  },
  'batch8': {
    name: 'batch8',
    tier1: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    tier2: 'deepseek-ai/DeepSeek-V4-Pro',
    candidatesPerAsk: 10,
    calibration: 'rank',
    samples: 1,
    batchSize: 8,
    reasksPerSlot: 2,
    sampling: { temperature: 0.2, maxTokens: 512 },
    escalation: {
      policy: 'reask-first',
      clueUnderstoodThreshold: 0.4,
      maxTier2CallsPerPuzzle: 25,
      escalationsPerSlot: 1,
    },
    search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
    repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
    budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
    rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
    promptVersion: PAIRED_PROMPT_VERSION,
  },
};

describe('builtins', () => {
  it('builtinNames() lists exactly the fifteen documented names', () => {
    expect(builtinNames().sort()).toEqual([...EXPECTED_NAMES].sort());
  });

  // T65 pinned the built-in count in test/unit/llm/prompts.test.ts, so that its
  // promptVersion loop could not quietly pass over an empty set. T71 added two
  // built-ins, and re-pinning a count in a T65-owned file for every profile a
  // later task adds is the wrong home for it: the pin belongs beside the name
  // list it restates, which is here. So this test carries both halves of what
  // that one asserted - the count, and the version every entry must be on.
  it('getBuiltins() returns fifteen profiles, each on a version prompts.ts renders', () => {
    const profiles = Object.values(getBuiltins());
    expect(profiles).toHaveLength(15);
    expect(profiles).toHaveLength(EXPECTED_NAMES.length);
    for (const profile of profiles) {
      expect(profile.promptVersion, `${profile.name} promptVersion`).toBe(
        profile.name === 'baseline-pv3' ? PROMPT_VERSION : PAIRED_PROMPT_VERSION,
      );
    }
    expect(ProfileSchema.parse({ name: 'x' }).promptVersion).toBe(PAIRED_PROMPT_VERSION);
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
    expect(secondBaseline?.tier1).toBe('deepseek-ai/DeepSeek-V4-Flash-0731');
    expect(secondBaseline?.sampling.temperature).toBe(0.2);
    expect(baseline.sampling.temperature).toBe(0.2);
  });

  it('getBuiltin() returns a fresh copy of one named profile', () => {
    const a = getBuiltin('baseline');
    a.tier1 = 'mutated';
    a.sampling.temperature = 1.9;
    const b = getBuiltin('baseline');
    expect(b.tier1).toBe('deepseek-ai/DeepSeek-V4-Flash-0731');
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

  // T66: the paired-measurement profile. It exists to isolate one prompt
  // instruction, so any second difference from `baseline` would confound the
  // comparison it is for.
  it('baseline-pv3 is baseline with promptVersion 3 and nothing else', () => {
    expect(baselinePv3.promptVersion).toBe('3');
    expect(baseline.promptVersion).toBe('2');
    const { name: _name, promptVersion: _version, ...rest } = baselinePv3;
    const { name: _baselineName, promptVersion: _baselineVersion, ...baselineRest } = baseline;
    expect(rest).toEqual(baselineRest);
  });

  it('every other built-in carries the default prompt version', () => {
    for (const [name, profile] of Object.entries(getBuiltins())) {
      expect(profile.promptVersion, `${name} promptVersion`).toBe(
        name === 'baseline-pv3' ? '3' : '2',
      );
    }
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
      // T71's two profiles lift the cap to 200 deliberately; every other
      // built-in still carries T62's 25, and tier1-only its 0.
      if (T71_NAMES.includes(name)) continue;
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

  // T69: the puzzle-level bench (docs/benches/model-comparison.md) found
  // deepseek-ai/DeepSeek-V4-Flash-0731 beats the prior tier-1 default on
  // letters accuracy (0.80 vs 0.58, american stratum) at about half the
  // cost, winning 24 of 24 paired repeats. `tier1-only` carries it too:
  // that built-in is "the default tier 1 with no escalation", not a fixed
  // reference model, so its tier1 tracks the default like every other
  // built-in. `strong-only` is the sole exception, since it already runs
  // the strong model for both tiers.
  it('carries the T69 tier-1 default (DeepSeek-V4-Flash-0731) everywhere except strong-only', () => {
    expect(baseline.tier1).toBe('deepseek-ai/DeepSeek-V4-Flash-0731');
    expect(tier1Only.tier1).toBe('deepseek-ai/DeepSeek-V4-Flash-0731');
    for (const [name, profile] of Object.entries(getBuiltins())) {
      // T71's two profiles run the strong model in both tiers, like
      // strong-only, which is the point of them.
      const strongTier1 = name === 'strong-only' || T71_NAMES.includes(name);
      expect(profile.tier1, `${name} tier1`).toBe(
        strongTier1 ? 'deepseek-ai/DeepSeek-V4-Pro' : 'deepseek-ai/DeepSeek-V4-Flash-0731',
      );
    }
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

describe('builtins: T71 additions', () => {
  // Acceptance 4, the strong half: not "nothing important changed" but
  // "nothing changed at all", field by field, against the literals as they
  // stood before this task.
  it.each(Object.keys(PRE_T71_LITERALS))('%s is byte-for-byte its pre-T71 literal', (name) => {
    expect(getBuiltin(name)).toEqual(PRE_T71_LITERALS[name]);
  });

  it('leaves both new fields absent on every pre-T71 built-in', () => {
    for (const [name, profile] of Object.entries(getBuiltins())) {
      if (T71_NAMES.includes(name)) continue;
      expect(profile.reasoning, `${name} reasoning`).toBeUndefined();
      expect(profile.constrainedSamples, `${name} constrainedSamples`).toBeUndefined();
      // Absent still reads as the pre-T71 behaviour: no sampling, no reasoning.
      expect(constrainedSamplesOf(profile)).toBe(1);
      expect(reasoningOf(profile).constrainedEffort).toBe('none');
    }
  });

  it.each(T71_NAMES)('%s parses through ProfileSchema', (name) => {
    expect(() => ProfileSchema.parse(getBuiltin(name))).not.toThrow();
  });

  it('max-accuracy carries the strong model in both tiers and the lifted caps', () => {
    expect(maxAccuracy.name).toBe('max-accuracy');
    expect(maxAccuracy.tier1).toBe('deepseek-ai/DeepSeek-V4-Pro');
    expect(maxAccuracy.tier2).toBe('deepseek-ai/DeepSeek-V4-Pro');
    expect(maxAccuracy.escalation.maxTier2CallsPerPuzzle).toBe(200);
    expect(maxAccuracy.escalation.escalationsPerSlot).toBe(2);
    expect(maxAccuracy.reasksPerSlot).toBe(3);
    expect(maxAccuracy.search.maxBacktracks).toBe(1000);
    expect(maxAccuracy.repair.maxCalls).toBe(200);
    expect(maxAccuracy.repair.maxEditDistance).toBe(2);
    expect(maxAccuracy.budget.usd).toBe(2.0);
    expect(maxAccuracy.budget.tokens).toBe(10_000_000);
    expect(maxAccuracy.promptVersion).toBe(baseline.promptVersion);
  });

  it('max-accuracy turns both new levers on', () => {
    expect(constrainedSamplesOf(maxAccuracy)).toBe(3);
    expect(reasoningOf(maxAccuracy)).toEqual({
      constrainedEffort: 'medium',
      constrainedMaxTokens: 2048,
    });
  });

  it('max-accuracy differs from baseline only in the documented fields', () => {
    const changed = new Set(
      Object.keys(maxAccuracy).filter(
        (key) =>
          JSON.stringify(maxAccuracy[key as keyof typeof maxAccuracy]) !==
          JSON.stringify(baseline[key as keyof typeof baseline]),
      ),
    );
    expect([...changed].sort()).toEqual(
      [
        'budget',
        'constrainedSamples',
        'escalation',
        'name',
        'reasksPerSlot',
        'reasoning',
        'repair',
        'search',
        'tier1',
      ].sort(),
    );
    // Everything not lifted is baseline's, including the seed token budget.
    expect(maxAccuracy.sampling).toEqual(baseline.sampling);
    expect(maxAccuracy.rateLimit).toEqual(baseline.rateLimit);
    expect(maxAccuracy.candidatesPerAsk).toBe(baseline.candidatesPerAsk);
    expect(maxAccuracy.calibration).toBe(baseline.calibration);
    expect(maxAccuracy.samples).toBe(baseline.samples);
    expect(maxAccuracy.batchSize).toBe(baseline.batchSize);
  });

  // The control: same models, same lifted caps, neither new lever. A bench of
  // the two attributes any difference to the reasoning and the votes alone.
  it('strong-only-uncapped is max-accuracy with both levers off', () => {
    expect(constrainedSamplesOf(strongOnlyUncapped)).toBe(1);
    expect(reasoningOf(strongOnlyUncapped).constrainedEffort).toBe('none');
    const {
      name: _name,
      reasoning: _reasoning,
      constrainedSamples: _samples,
      rateLimit: _rateLimit,
      ...uncappedRest
    } = strongOnlyUncapped;
    const {
      name: _maxName,
      reasoning: _maxReasoning,
      constrainedSamples: _maxSamples,
      rateLimit: _maxRateLimit,
      ...maxRest
    } = maxAccuracy;
    expect(uncappedRest).toEqual(maxRest);
  });

  it('strong-only-uncapped keeps strong-only rate limits and lifts its caps', () => {
    expect(strongOnlyUncapped.rateLimit).toEqual(strongOnly.rateLimit);
    expect(strongOnlyUncapped.tier1).toBe(strongOnly.tier1);
    expect(strongOnlyUncapped.tier2).toBe(strongOnly.tier2);
    expect(strongOnlyUncapped.budget.usd).toBe(2.0);
    expect(strongOnlyUncapped.budget.tokens).toBe(10_000_000);
    expect(strongOnlyUncapped.escalation.maxTier2CallsPerPuzzle).toBe(200);
    expect(strongOnlyUncapped.search.maxBacktracks).toBe(1000);
    expect(strongOnlyUncapped.repair.maxCalls).toBe(200);
  });

  it('both new profiles are deep-copied out of the module like every other', () => {
    const first = getBuiltin('max-accuracy');
    expect(first.reasoning).toBeDefined();
    if (first.reasoning !== undefined) first.reasoning.constrainedEffort = 'high';
    expect(getBuiltin('max-accuracy').reasoning?.constrainedEffort).toBe('medium');
    expect(maxAccuracy.reasoning.constrainedEffort).toBe('medium');
  });
});
