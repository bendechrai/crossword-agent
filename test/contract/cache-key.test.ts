import { describe, expect, it } from 'vitest';

import { cacheKey, type CacheKeyInput } from '../../src/util/hash.js';

/**
 * B23's invariant, stated once: every field that can change the bytes of the
 * prompt or the sampling parameters is in the key, and nothing else is.
 *
 * The second half of that sentence has nothing to assert here, and
 * deliberately so: policy fields (escalation policy, ordering, LDS limits,
 * budgets) are not members of `CacheKeyInput` at all, so there is no way to
 * pass one in and no way for one to reach the hash. If a policy field ever
 * appears in this type, that is the bug, and it will be a compile-time change
 * to this file rather than a silent behaviour change.
 */
const base: CacheKeyInput = {
  model: 'nvidia/Nemotron-3_5-Lightning',
  promptVersion: '1',
  promptKind: 'seed',
  clue: 'Cry of surprise',
  enumeration: '(3,4)',
  length: 2,
  pattern: '??',
  style: 'american',
  title: 'Synthetic five',
  n: 10,
  samples: 1,
  sampleIndex: 0,
  batchSize: 1,
  rejected: [
    { answer: 'AAH', reason: 'length' },
    { answer: 'OOH', reason: 'pattern' },
  ],
  crossingContext: [
    { slotId: '1D', clue: 'Spoken rather than written', fill: null, confidence: 0.5 },
    { slotId: '2D', clue: 'Chaos and destruction', fill: 'HAVOC', confidence: 0.9 },
  ],
  temperature: 0.2,
  topP: 0.95,
  maxTokens: 512,
};

/** Every prompt-visible field, paired with a value that differs from `base`. */
const mutations: Array<[string, Partial<CacheKeyInput>]> = [
  ['model', { model: 'deepseek-ai/DeepSeek-V4-Pro' }],
  ['promptVersion', { promptVersion: '2' }],
  ['promptKind', { promptKind: 'constrained' }],
  ['clue', { clue: 'Cry of surprise!' }],
  ['enumeration', { enumeration: '(7)' }],
  ['enumeration absent', { enumeration: undefined }],
  ['length', { length: 3 }],
  ['pattern', { pattern: 'O?' }],
  ['style', { style: 'cryptic' }],
  ['title', { title: 'Synthetic seven' }],
  ['title absent', { title: undefined }],
  ['n', { n: 11 }],
  ['samples', { samples: 3 }],
  ['sampleIndex', { sampleIndex: 1 }],
  ['batchSize', { batchSize: 5 }],
  ['rejected content', { rejected: [{ answer: 'AAH', reason: 'length' }] }],
  ['rejected reason', { rejected: [{ answer: 'AAH', reason: 'charset' }, { answer: 'OOH', reason: 'pattern' }] }],
  ['crossingContext fill', {
    crossingContext: [
      { slotId: '1D', clue: 'Spoken rather than written', fill: 'ORAL', confidence: 0.5 },
      { slotId: '2D', clue: 'Chaos and destruction', fill: 'HAVOC', confidence: 0.9 },
    ],
  }],
  ['crossingContext absent', { crossingContext: null }],
  ['temperature', { temperature: 0.7 }],
  ['topP', { topP: 0.9 }],
  ['topP absent', { topP: undefined }],
  ['maxTokens', { maxTokens: 1024 }],
];

describe('cacheKey (B23)', () => {
  const baseKey = cacheKey(base);

  it('is a sha1 hex digest', () => {
    expect(baseKey).toMatch(/^[0-9a-f]{40}$/);
  });

  it('is stable across calls', () => {
    expect(cacheKey(base)).toBe(baseKey);
  });

  it('is stable across key insertion order', () => {
    const reordered: CacheKeyInput = {
      maxTokens: base.maxTokens,
      topP: base.topP,
      temperature: base.temperature,
      crossingContext: base.crossingContext,
      rejected: base.rejected,
      batchSize: base.batchSize,
      sampleIndex: base.sampleIndex,
      samples: base.samples,
      n: base.n,
      title: base.title,
      style: base.style,
      pattern: base.pattern,
      length: base.length,
      enumeration: base.enumeration,
      clue: base.clue,
      promptKind: base.promptKind,
      promptVersion: base.promptVersion,
      model: base.model,
    };
    expect(cacheKey(reordered)).toBe(baseKey);
  });

  it.each(mutations)('changes when %s changes', (_name, patch) => {
    expect(cacheKey({ ...base, ...patch })).not.toBe(baseKey);
  });

  it('does not change when the rejected list is reordered', () => {
    const reordered: CacheKeyInput = {
      ...base,
      rejected: [...base.rejected].reverse(),
    };
    expect(cacheKey(reordered)).toBe(baseKey);
  });

  it('does not change when the crossing context is reordered', () => {
    const reordered: CacheKeyInput = {
      ...base,
      crossingContext: [...(base.crossingContext ?? [])].reverse(),
    };
    expect(cacheKey(reordered)).toBe(baseKey);
  });

  it('treats an absent crossing context and an explicit null the same', () => {
    const { crossingContext: _dropped, ...withoutContext } = base;
    expect(cacheKey(withoutContext as CacheKeyInput)).toBe(
      cacheKey({ ...base, crossingContext: null }),
    );
  });
});
