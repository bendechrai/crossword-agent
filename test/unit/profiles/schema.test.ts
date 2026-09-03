import { describe, expect, it } from 'vitest';

import { ProfileSchema } from '../../../src/profiles/schema.js';

describe('ProfileSchema', () => {
  it('fills in every default from the name alone', () => {
    const profile = ProfileSchema.parse({ name: 'baseline' });
    expect(profile).toEqual({
      name: 'baseline',
      tier1: 'nvidia/Nemotron-3_5-Lightning',
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
        maxTier2CallsPerPuzzle: 15,
        escalationsPerSlot: 1,
      },
      search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
      repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
      budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
      rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
      promptVersion: '1',
    });
  });

  it('defaults promptVersion to "1" and not to "v1"', () => {
    expect(ProfileSchema.parse({ name: 'x' }).promptVersion).toBe('1');
  });

  it('rejects votes calibration without three samples at temperature 0.7', () => {
    expect(() => ProfileSchema.parse({ name: 'v', calibration: 'votes' })).toThrow();
    expect(() =>
      ProfileSchema.parse({ name: 'v', calibration: 'votes', samples: 3 }),
    ).toThrow();
    expect(() =>
      ProfileSchema.parse({
        name: 'v',
        calibration: 'votes',
        samples: 2,
        sampling: { temperature: 0.7 },
      }),
    ).toThrow();
  });

  it('accepts votes calibration at samples 3 and temperature 0.7', () => {
    const profile = ProfileSchema.parse({
      name: 'votes3',
      calibration: 'votes',
      samples: 3,
      sampling: { temperature: 0.7 },
    });
    expect(profile.samples).toBe(3);
    expect(profile.sampling.temperature).toBe(0.7);
  });

  it('enforces the documented ranges', () => {
    expect(() => ProfileSchema.parse({ name: 'x', batchSize: 9 })).toThrow();
    expect(() => ProfileSchema.parse({ name: 'x', candidatesPerAsk: 0 })).toThrow();
    expect(() => ProfileSchema.parse({ name: 'x', samples: 6 })).toThrow();
    expect(() =>
      ProfileSchema.parse({ name: 'x', repair: { maxEditDistance: 3 } }),
    ).toThrow();
    expect(() => ProfileSchema.parse({ name: 'x', sampling: { maxTokens: 8 } })).toThrow();
  });

  it('rejects an unknown calibration mode', () => {
    expect(() => ProfileSchema.parse({ name: 'x', calibration: 'vibes' })).toThrow();
  });
});
