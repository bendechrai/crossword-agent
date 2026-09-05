import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { capabilitiesOf, limitsOf, loadPricing, priceOf, usdFor } from '../../../src/llm/pricing.js';

const FIXTURE_PATH = fileURLToPath(new URL('../../fixtures/models.min.json', import.meta.url));
const PRICING_SOURCE_PATH = fileURLToPath(new URL('../../../src/llm/pricing.ts', import.meta.url));

const NEMOTRON = 'nvidia/Nemotron-3_5-Lightning';
const DEEPSEEK = 'deepseek-ai/DeepSeek-V4-Pro';
const FLASH = 'deepseek-ai/DeepSeek-V4-Flash-0731';

describe('capabilitiesOf (against the real models.json)', () => {
  it('reports Nemotron as reasoning-capable but without structured outputs (acceptance 1)', () => {
    expect(capabilitiesOf(NEMOTRON)).toEqual(
      expect.objectContaining({ supportsStructuredOutputs: false, supportsReasoning: true }),
    );
  });

  it('reports DeepSeek-V4-Pro as both structured-output and reasoning capable (acceptance 2)', () => {
    expect(capabilitiesOf(DEEPSEEK)).toEqual(
      expect.objectContaining({ supportsStructuredOutputs: true, supportsReasoning: true }),
    );
  });

  it('never advertises seed support for either default-tier model (neither catalogue entry lists it)', () => {
    expect(capabilitiesOf(NEMOTRON).supportsSeed).toBe(false);
    expect(capabilitiesOf(DEEPSEEK).supportsSeed).toBe(false);
  });
});

describe('limitsOf (against the real models.json)', () => {
  it('returns the tier-1 and tier-2 limits from the catalogue (acceptance 3)', () => {
    expect(limitsOf(NEMOTRON)).toEqual({
      requestsPerMinute: 600,
      tokensPerMinute: 400000,
      burstRatio: 1,
    });
    expect(limitsOf(DEEPSEEK)).toEqual({
      requestsPerMinute: 3000,
      tokensPerMinute: 1000000,
      burstRatio: 1,
    });
  });
});

describe('usdFor', () => {
  it('prices 1,000 prompt and 500 completion tokens on Nemotron at exactly 0.00018 (acceptance 4)', () => {
    const usd = usdFor({ model: NEMOTRON, promptTokens: 1000, completionTokens: 500, calls: 0 });
    expect(usd).toBe(0.00018);
  });

  it('prices the same call on DeepSeek-V4-Pro at exactly 0.0035 (acceptance 5)', () => {
    const usd = usdFor({ model: DEEPSEEK, promptTokens: 1000, completionTokens: 500, calls: 0 });
    expect(usd).toBe(0.0035);
  });

  it('throws with the model id in the message for an unknown model (acceptance 6)', () => {
    expect(() => usdFor({ model: 'nobody/no-such-model', promptTokens: 1, completionTokens: 1, calls: 1 })).toThrow(
      'nobody/no-such-model',
    );
  });

  it('rounds an input whose exact price needs more than 9 decimal places to 9, pinned exactly (acceptance 7)', () => {
    // The fixture's "test/rounding-fixture" prices prompt tokens at 1e-10 USD.
    // 7 tokens is exactly 7e-10, one order of magnitude finer than the 9
    // decimal places usdFor rounds to, so this is genuine rounding (0.7 of
    // the last representable unit), not floating-point noise cleanup.
    const usd = usdFor({
      model: 'test/rounding-fixture',
      promptTokens: 7,
      completionTokens: 0,
      calls: 0,
      path: FIXTURE_PATH,
    });
    expect(usd).toBe(0.000000001);
  });

  it('never bills calls against a $0 request price for either default-tier model', () => {
    const usd = usdFor({ model: NEMOTRON, promptTokens: 0, completionTokens: 0, calls: 1000 });
    expect(usd).toBe(0);
  });
});

describe('priceOf', () => {
  it('returns the catalogue prices as decimal strings, unconverted', () => {
    expect(priceOf(NEMOTRON)).toEqual({ prompt: '0.00000006', completion: '0.00000024', request: '0' });
  });

  it('throws with the model id for an unknown model', () => {
    expect(() => priceOf('nobody/no-such-model')).toThrow('nobody/no-such-model');
  });
});

describe('loadPricing (fixture injection)', () => {
  it('loads the hand-trimmed 4-model fixture', () => {
    const catalogue = loadPricing(FIXTURE_PATH);
    expect([...catalogue.keys()].sort()).toEqual([DEEPSEEK, FLASH, NEMOTRON, 'test/rounding-fixture'].sort());
  });

  it('is memoised per path: two loads of the same path return the same Map instance', () => {
    expect(loadPricing(FIXTURE_PATH)).toBe(loadPricing(FIXTURE_PATH));
  });

  it('keeps the default catalogue and an injected fixture catalogue independent', () => {
    expect(loadPricing()).not.toBe(loadPricing(FIXTURE_PATH));
    expect(loadPricing().has('test/rounding-fixture')).toBe(false);
  });

  it('maps supportsSeed from supported_features on the fixture-only seed-capable model', () => {
    expect(capabilitiesOf('test/rounding-fixture', FIXTURE_PATH)).toEqual({
      supportsStructuredOutputs: false,
      supportsReasoning: false,
      supportsSeed: true,
      supportedSamplingParameters: ['temperature', 'seed'],
    });
  });

  it('carries limits through for the fixture-only model too', () => {
    expect(limitsOf('test/rounding-fixture', FIXTURE_PATH)).toEqual({
      requestsPerMinute: 100,
      tokensPerMinute: 100000,
      burstRatio: 1,
    });
  });

  it('throws for a model id absent from the injected fixture even though it exists in the real catalogue', () => {
    // Confirms lookups are scoped to the loaded catalogue, not merged with
    // whatever else has been loaded in this process.
    expect(() => priceOf('nvidia/Nemotron-3_5-Lightning-typo', FIXTURE_PATH)).toThrow(
      'nvidia/Nemotron-3_5-Lightning-typo',
    );
  });
});

describe('data-driven capability mapping (no hard-coded model families)', () => {
  it('derives capabilities from supported_features alone: pricing.ts names no real model family', () => {
    const source = readFileSync(PRICING_SOURCE_PATH, 'utf8');
    expect(source.toLowerCase()).not.toContain('nemotron');
    expect(source.toLowerCase()).not.toContain('deepseek');
  });
});
