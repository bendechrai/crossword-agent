import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/llm/pricing.js', () => ({ capabilitiesOf: vi.fn() }));
vi.mock('../../../src/llm/rateLimiter.js', () => ({ getLimiter: vi.fn() }));

// Imported after the mocks so the module under test picks up the mocked
// bindings; per-test return values are set with `caps()`/`vi.mocked(...)`.
import type { CandidateRequest } from '../../../src/candidates/types.js';
import { capabilitiesOf } from '../../../src/llm/pricing.js';
import { getLimiter } from '../../../src/llm/rateLimiter.js';
import { REASONING_OFF_PARAM, REASONING_OFF_VALUE, route } from '../../../src/llm/tierRouter.js';
import type { ModelCapabilities } from '../../../src/llm/types.js';
import { ProfileObject, type Profile } from '../../../src/profiles/schema.js';

const SOURCE_PATH = fileURLToPath(new URL('../../../src/llm/tierRouter.ts', import.meta.url));
const SCHEMA_PATH = fileURLToPath(
  new URL('../../../schemas/candidate-response.schema.json', import.meta.url),
);
const candidateResponseSchema: unknown = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

function caps(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return {
    supportsStructuredOutputs: false,
    supportsReasoning: false,
    supportsSeed: false,
    supportedSamplingParameters: ['temperature', 'top_p'],
    ...overrides,
  };
}

function baseProfile(overrides: Partial<Profile> = {}): Profile {
  return ProfileObject.parse({ name: 'test-profile', ...overrides });
}

function baseRequest(overrides: Partial<CandidateRequest> = {}): CandidateRequest {
  return {
    slotId: '1A',
    clue: 'Feline pet',
    length: 3,
    pattern: '???',
    style: 'american',
    rejected: [],
    tier: 1,
    purpose: 'seed',
    n: 5,
    samples: 1,
    sampleIndex: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(capabilitiesOf).mockReset();
  vi.mocked(getLimiter).mockReset();
});

describe('route: transport mode by capability (B9)', () => {
  it('routes tier 1 to in-prompt schema mode with no response_format (acceptance 1)', () => {
    vi.mocked(capabilitiesOf).mockReturnValue(caps({ supportsStructuredOutputs: false }));
    const profile = baseProfile({ tier1: 'catalogue/tier1-model' });

    const result = route(baseRequest({ tier: 1 }), profile);

    expect(result.model).toBe('catalogue/tier1-model');
    expect(result.inlineSchema).toBe(true);
    expect(result.request.responseFormat).toBeUndefined();
  });

  it('routes tier 2 to response_format.type json_schema embedding the schema verbatim (acceptance 2)', () => {
    vi.mocked(capabilitiesOf).mockReturnValue(caps({ supportsStructuredOutputs: true }));
    const profile = baseProfile({ tier2: 'catalogue/tier2-model' });

    const result = route(baseRequest({ tier: 2 }), profile);

    expect(result.inlineSchema).toBe(false);
    // T49 (docs/spikes/tier1-reliability.md section 2): Nebius's own request
    // validator rejects the schema document sent directly as `json_schema`
    // ("Field required": name) and accepts it wrapped this way.
    expect(result.request.responseFormat).toEqual({
      type: 'json_schema',
      json_schema: { name: 'candidate_response', schema: candidateResponseSchema, strict: true },
    });
  });

  it('drives json_schema mode purely by capability, even when the model plays the tier-1 role (acceptance 3)', () => {
    // A hypothetical fixture-shaped entry: structured_outputs present, but
    // assigned to profile.tier1 - proving the branch reads capabilities, not
    // "this is the tier-2 slot".
    vi.mocked(capabilitiesOf).mockReturnValue(caps({ supportsStructuredOutputs: true }));
    const profile = baseProfile({ tier1: 'catalogue/hypothetical-structured-tier1' });

    const result = route(baseRequest({ tier: 1 }), profile);

    expect(result.inlineSchema).toBe(false);
    expect(result.request.responseFormat).toEqual(
      expect.objectContaining({ type: 'json_schema' }),
    );
  });
});

describe('route: reasoning-off parameter (B41 as amended by T58)', () => {
  /**
   * The three prompt kinds the cache key records (spec: "Candidate service"
   * step 1 - re-ask and repair both render `constrained`), paired with the
   * `Purpose` values that reach them, so "seed, constrained and escalate" is
   * covered by actual `CandidateRequest.purpose` values.
   */
  const TIER1_PURPOSES: ReadonlyArray<{ promptKind: string; purpose: CandidateRequest['purpose'] }> = [
    { promptKind: 'seed', purpose: 'seed' },
    { promptKind: 'constrained', purpose: 'reask' },
    { promptKind: 'constrained', purpose: 'repair' },
    { promptKind: 'escalate', purpose: 'escalate' },
    { promptKind: 'seed', purpose: 'smoke' },
    { promptKind: 'seed', purpose: 'calibrate' },
  ];

  for (const { promptKind, purpose } of TIER1_PURPOSES) {
    it(`emits REASONING_OFF_PARAM for tier-1 purpose ${purpose} (${promptKind}) on a reasoning-capable model`, () => {
      vi.mocked(capabilitiesOf).mockReturnValue(caps({ supportsReasoning: true }));
      const profile = baseProfile({ tier1: 'catalogue/reasoning-model' });

      const result = route(baseRequest({ tier: 1, purpose }), profile);

      // T49 (docs/spikes/tier1-reliability.md section 1): "none" is the value
      // measured to actually drive reasoningTokens to 0 against the live API.
      // T58: sent for every tier-1 purpose, not just seed - with reasoning on,
      // a non-seed tier-1 call spends its whole token budget on
      // chain-of-thought and emits no JSON at all (see `reasoningOffApplies`).
      expect(result.request.extra).toEqual(
        expect.objectContaining({ [REASONING_OFF_PARAM]: REASONING_OFF_VALUE }),
      );
    });

    it(`never emits it for tier-1 purpose ${purpose} on a model that does not advertise reasoning`, () => {
      vi.mocked(capabilitiesOf).mockReturnValue(caps({ supportsReasoning: false }));
      const profile = baseProfile({ tier1: 'catalogue/non-reasoning-model' });

      const result = route(baseRequest({ tier: 1, purpose }), profile);

      expect(result.request.extra).toBeUndefined();
    });
  }

  it('emits it for a tier-2 seed call on a reasoning-capable model (B41 unchanged there)', () => {
    vi.mocked(capabilitiesOf).mockReturnValue(caps({ supportsReasoning: true }));
    const profile = baseProfile({ tier2: 'catalogue/reasoning-model' });

    const result = route(baseRequest({ tier: 2, purpose: 'seed' }), profile);

    expect(result.request.extra).toEqual(
      expect.objectContaining({ [REASONING_OFF_PARAM]: REASONING_OFF_VALUE }),
    );
  });

  it('does not emit it for a tier-2 escalate call: T58 is scoped to tier 1', () => {
    vi.mocked(capabilitiesOf).mockReturnValue(caps({ supportsReasoning: true }));
    const profile = baseProfile({ tier2: 'catalogue/reasoning-model' });

    const result = route(baseRequest({ tier: 2, purpose: 'escalate' }), profile);

    expect(result.request.extra?.[REASONING_OFF_PARAM]).toBeUndefined();
  });

  it('does not emit it for a tier-2 constrained (repair) call either', () => {
    vi.mocked(capabilitiesOf).mockReturnValue(caps({ supportsReasoning: true }));
    const profile = baseProfile({ tier2: 'catalogue/reasoning-model' });

    const result = route(baseRequest({ tier: 2, purpose: 'repair' }), profile);

    expect(result.request.extra?.[REASONING_OFF_PARAM]).toBeUndefined();
  });
});

describe('route: sampling parameters filtered against the catalogue (B22)', () => {
  it('drops topP when top_p is absent from supported_sampling_parameters (acceptance 5)', () => {
    vi.mocked(capabilitiesOf).mockReturnValue(caps({ supportedSamplingParameters: ['temperature'] }));
    const profile = baseProfile({
      tier1: 'catalogue/no-top-p-model',
      sampling: { temperature: 0.2, topP: 0.9, maxTokens: 512 },
    });

    const result = route(baseRequest({ tier: 1 }), profile);

    expect(result.request.topP).toBeUndefined();
  });

  it('keeps topP when top_p is advertised', () => {
    vi.mocked(capabilitiesOf).mockReturnValue(
      caps({ supportedSamplingParameters: ['temperature', 'top_p'] }),
    );
    const profile = baseProfile({
      tier1: 'catalogue/top-p-model',
      sampling: { temperature: 0.2, topP: 0.9, maxTokens: 512 },
    });

    const result = route(baseRequest({ tier: 1 }), profile);

    expect(result.request.topP).toBe(0.9);
  });

  it('always sends temperature and maxTokens (required LlmRequest fields, never gated)', () => {
    vi.mocked(capabilitiesOf).mockReturnValue(caps({ supportedSamplingParameters: [] }));
    const profile = baseProfile({
      tier1: 'catalogue/bare-model',
      sampling: { temperature: 0.3, maxTokens: 256 },
    });

    const result = route(baseRequest({ tier: 1 }), profile);

    expect(result.request.temperature).toBe(0.3);
    expect(result.request.maxTokens).toBe(256);
  });
});

describe('route: --seed passthrough (B38)', () => {
  it('includes seed in extra only when the catalogue advertises the seed capability (acceptance 7)', () => {
    vi.mocked(capabilitiesOf).mockReturnValue(caps({ supportsSeed: true }));
    const profile = baseProfile({ tier1: 'catalogue/seed-model' });

    const result = route(baseRequest({ tier: 1 }), profile, { seed: 42 });

    expect(result.request.extra).toEqual(expect.objectContaining({ seed: 42 }));
  });

  it('omits seed when the catalogue does not advertise it, even if --seed was given', () => {
    vi.mocked(capabilitiesOf).mockReturnValue(caps({ supportsSeed: false }));
    const profile = baseProfile({ tier1: 'catalogue/no-seed-model' });

    const result = route(baseRequest({ tier: 1 }), profile, { seed: 42 });

    expect(result.request.extra?.['seed']).toBeUndefined();
  });

  it('omits seed when the catalogue advertises it but no --seed was given', () => {
    vi.mocked(capabilitiesOf).mockReturnValue(caps({ supportsSeed: true }));
    const profile = baseProfile({ tier1: 'catalogue/seed-model' });

    const result = route(baseRequest({ tier: 1 }), profile);

    expect(result.request.extra).toBeUndefined();
  });
});

describe('route: rate limiter creation on first touch', () => {
  it('creates the tier-1 model limiter with maxConcurrencyTier1 and rpsFraction', () => {
    vi.mocked(capabilitiesOf).mockReturnValue(caps());
    const profile = baseProfile({
      tier1: 'catalogue/tier1-limiter-model',
      rateLimit: { rpsFraction: 0.75, maxConcurrencyTier1: 4, maxConcurrencyTier2: 20 },
    });

    route(baseRequest({ tier: 1 }), profile);

    expect(getLimiter).toHaveBeenCalledWith('catalogue/tier1-limiter-model', {
      rpsFraction: 0.75,
      maxConcurrency: 4,
    });
  });

  it('creates the tier-2 model limiter with maxConcurrencyTier2', () => {
    vi.mocked(capabilitiesOf).mockReturnValue(caps());
    const profile = baseProfile({
      tier2: 'catalogue/tier2-limiter-model',
      rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
    });

    route(baseRequest({ tier: 2 }), profile);

    expect(getLimiter).toHaveBeenCalledWith('catalogue/tier2-limiter-model', {
      rpsFraction: 0.9,
      maxConcurrency: 16,
    });
  });

  it('touches the limiter on every route() call for the model (getLimiter itself is idempotent)', () => {
    vi.mocked(capabilitiesOf).mockReturnValue(caps());
    const profile = baseProfile({ tier1: 'catalogue/repeat-model' });

    route(baseRequest({ tier: 1 }), profile);
    route(baseRequest({ tier: 1 }), profile);

    expect(getLimiter).toHaveBeenCalledTimes(2);
  });
});

describe('route: never a model-name substring match (B9, acceptance 6)', () => {
  it('src/llm/tierRouter.ts contains no case-insensitive occurrence of "deepseek" or "nemotron"', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8').toLowerCase();
    expect(source).not.toContain('deepseek');
    expect(source).not.toContain('nemotron');
  });
});
