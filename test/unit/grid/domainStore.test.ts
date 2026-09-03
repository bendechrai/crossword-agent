import { describe, expect, it } from 'vitest';

import type { Candidate } from '../../../src/candidates/types.js';
import { createDomainStore } from '../../../src/grid/domainStore.js';

/** Builds a Candidate with sensible defaults so a test only states what it cares about. */
function cand(answer: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    answer,
    raw: answer.toLowerCase(),
    rank: 0,
    selfConfidence: 0.5,
    votes: 1,
    score: 0.5,
    tier: 1,
    fromCache: false,
    ...overrides,
  };
}

function answersOf(candidates: readonly Candidate[]): string[] {
  return candidates.map((c) => c.answer);
}

/** Deterministic PRNG (mulberry32) so the randomised test is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED_5 = [
  cand('ALIEN', { rank: 0, score: 0.9 }),
  cand('ALARM', { rank: 1, score: 0.8 }),
  cand('ACORN', { rank: 2, score: 0.7 }),
  cand('AMEND', { rank: 3, score: 0.6 }),
  cand('ATOLL', { rank: 4, score: 0.5 }),
];

describe('createDomainStore: base domains', () => {
  it('reports an unseeded slot as an empty domain rather than throwing', () => {
    const store = createDomainStore();
    expect(store.get('1A')).toEqual([]);
    expect(store.sizeOf('1A')).toBe(0);
    expect(store.isSuspect('1A')).toBe(false);
  });

  it('setBase seeds the domain and a second setBase replaces it', () => {
    const store = createDomainStore();
    store.setBase('1A', SEED_5);
    expect(answersOf(store.get('1A'))).toEqual(['ALIEN', 'ALARM', 'ACORN', 'AMEND', 'ATOLL']);
    expect(store.sizeOf('1A')).toBe(5);

    store.setBase('1A', [cand('OTHER')]);
    expect(answersOf(store.get('1A'))).toEqual(['OTHER']);
  });

  it('setBase de-duplicates on the answer, keeping the higher score and summing votes', () => {
    const store = createDomainStore();
    store.setBase('1A', [
      cand('ALIEN', { score: 0.4, votes: 1 }),
      cand('ALIEN', { score: 0.9, votes: 2 }),
    ]);
    const domain = store.get('1A');
    expect(domain).toHaveLength(1);
    expect(domain[0]?.score).toBe(0.9);
    expect(domain[0]?.votes).toBe(3);
  });

  it('starts at depth 0', () => {
    expect(createDomainStore().depth()).toBe(0);
  });
});

describe('createDomainStore: trailed reductions', () => {
  // Acceptance 1.
  it('undoTo(3) restores the domain as it stood at depth 3 and keeps the depth-3 reduction', () => {
    const store = createDomainStore();
    store.setBase('1A', SEED_5);

    store.push();
    store.push();
    store.push();
    expect(store.depth()).toBe(3);
    const removedAt3 = store.reduce('1A', (c) => c.answer !== 'ATOLL', 'ac3');
    expect(removedAt3).toBe(1);
    const atDepth3 = answersOf(store.get('1A'));
    expect(atDepth3).toEqual(['ALIEN', 'ALARM', 'ACORN', 'AMEND']);

    store.push();
    expect(store.depth()).toBe(4);
    const removedAt4 = store.reduce('1A', (c) => c.answer.startsWith('AL'), 'forward-check');
    expect(removedAt4).toBe(2);
    expect(answersOf(store.get('1A'))).toEqual(['ALIEN', 'ALARM']);

    store.undoTo(3);
    expect(store.depth()).toBe(3);
    expect(answersOf(store.get('1A'))).toEqual(atDepth3);
  });

  it('pop undoes exactly one frame', () => {
    const store = createDomainStore();
    store.setBase('1A', SEED_5);
    store.push();
    store.reduce('1A', (c) => c.answer !== 'ALIEN');
    store.push();
    store.reduce('1A', (c) => c.answer !== 'ALARM');
    expect(answersOf(store.get('1A'))).toEqual(['ACORN', 'AMEND', 'ATOLL']);

    store.pop();
    expect(store.depth()).toBe(1);
    expect(answersOf(store.get('1A'))).toEqual(['ALARM', 'ACORN', 'AMEND', 'ATOLL']);

    store.pop();
    expect(store.depth()).toBe(0);
    expect(answersOf(store.get('1A'))).toEqual(answersOf(SEED_5));
  });

  it('reduce returns the number removed and is a no-op when nothing matches', () => {
    const store = createDomainStore();
    store.setBase('1A', SEED_5);
    store.push();
    expect(store.reduce('1A', () => true)).toBe(0);
    expect(store.reduce('unseeded', () => false)).toBe(0);
    expect(store.sizeOf('1A')).toBe(5);
  });

  it('a reduction taken at depth 0 has no frame to record it and is permanent', () => {
    const store = createDomainStore();
    store.setBase('1A', SEED_5);
    expect(store.reduce('1A', (c) => c.answer !== 'ATOLL', 'prepass')).toBe(1);
    store.undoTo(0);
    expect(answersOf(store.get('1A'))).toEqual(['ALIEN', 'ALARM', 'ACORN', 'AMEND']);
  });

  it('trails reductions across several slots in one frame', () => {
    const store = createDomainStore();
    store.setBase('1A', SEED_5);
    store.setBase('2D', [cand('BASIL'), cand('BRAVO')]);
    store.push();
    store.reduce('1A', (c) => c.answer === 'ALIEN');
    store.reduce('2D', (c) => c.answer === 'BRAVO');
    expect(store.sizeOf('1A')).toBe(1);
    expect(store.sizeOf('2D')).toBe(1);

    store.pop();
    expect(store.sizeOf('1A')).toBe(5);
    expect(store.sizeOf('2D')).toBe(2);
  });

  // Acceptance 6.
  it('allows a wipeout: reducing to zero candidates is legal and sizeOf reports 0', () => {
    const store = createDomainStore();
    store.setBase('1A', SEED_5);
    store.push();
    expect(store.reduce('1A', () => false, 'wipeout')).toBe(5);
    expect(store.sizeOf('1A')).toBe(0);
    expect(store.get('1A')).toEqual([]);

    store.pop();
    expect(store.sizeOf('1A')).toBe(5);
  });

  it('never mutates a Candidate object and never hands back a mutable domain array', () => {
    const frozen = SEED_5.map((c) => Object.freeze({ ...c }));
    const store = createDomainStore();
    store.setBase('1A', frozen);
    store.push();
    store.reduce('1A', (c) => c.score > 0.6);
    store.merge('1A', [cand('ALIEN', { score: 0.95, votes: 4 })]);
    store.pop();

    expect(frozen.map((c) => c.votes)).toEqual([1, 1, 1, 1, 1]);
    expect(frozen.map((c) => c.score)).toEqual([0.9, 0.8, 0.7, 0.6, 0.5]);
    expect(Object.isFrozen(store.get('1A'))).toBe(true);
  });
});

describe('createDomainStore: undoTo edge cases', () => {
  // Acceptance 5.
  it('undoTo is a no-op at a depth with no recorded frames', () => {
    const store = createDomainStore();
    store.setBase('1A', SEED_5);
    store.undoTo(0);
    expect(store.depth()).toBe(0);
    expect(store.sizeOf('1A')).toBe(5);

    store.push();
    store.reduce('1A', (c) => c.answer !== 'ATOLL');
    store.undoTo(7);
    expect(store.depth()).toBe(1);
    expect(store.sizeOf('1A')).toBe(4);
  });

  it('undoTo is idempotent', () => {
    const store = createDomainStore();
    store.setBase('1A', SEED_5);
    store.push();
    store.reduce('1A', (c) => c.answer === 'ALIEN');
    store.undoTo(0);
    const first = answersOf(store.get('1A'));
    store.undoTo(0);
    store.undoTo(0);
    expect(answersOf(store.get('1A'))).toEqual(first);
    expect(store.depth()).toBe(0);
  });

  it('clamps a negative target depth to 0 and tolerates pop at depth 0', () => {
    const store = createDomainStore();
    store.setBase('1A', SEED_5);
    store.push();
    store.reduce('1A', () => false);
    store.undoTo(-3);
    expect(store.depth()).toBe(0);
    expect(store.sizeOf('1A')).toBe(5);

    store.pop();
    expect(store.depth()).toBe(0);
    expect(store.sizeOf('1A')).toBe(5);
  });
});

describe('createDomainStore: merge into the base domain', () => {
  // Acceptance 2.
  it('a merge at depth 5 survives undoTo(0)', () => {
    const store = createDomainStore();
    store.setBase('1A', SEED_5);
    for (let i = 0; i < 5; i += 1) store.push();
    expect(store.depth()).toBe(5);

    store.reduce('1A', (c) => c.answer === 'ALIEN');
    store.merge('1A', [cand('AGILE', { score: 0.42 })]);
    expect(answersOf(store.get('1A'))).toContain('AGILE');

    store.undoTo(0);
    expect(store.depth()).toBe(0);
    expect(answersOf(store.get('1A'))).toEqual([...answersOf(SEED_5), 'AGILE']);
  });

  // Acceptance 3.
  it('merging an answer already present sums votes, keeps the higher score and does not grow the domain', () => {
    const store = createDomainStore();
    store.setBase('1A', [cand('ALIEN', { score: 0.6, votes: 2, rank: 0 })]);
    store.merge('1A', [cand('ALIEN', { score: 0.85, votes: 3, rank: 4, raw: 'alien!' })]);

    const domain = store.get('1A');
    expect(domain).toHaveLength(1);
    expect(domain[0]?.answer).toBe('ALIEN');
    expect(domain[0]?.votes).toBe(5);
    expect(domain[0]?.score).toBe(0.85);
    expect(domain[0]?.raw).toBe('alien!');
  });

  it('keeps the incumbent when the merged score is lower, still summing votes', () => {
    const store = createDomainStore();
    store.setBase('1A', [cand('ALIEN', { score: 0.85, votes: 2, raw: 'ALIEN' })]);
    store.merge('1A', [cand('ALIEN', { score: 0.1, votes: 1, raw: 'alien?' })]);

    const domain = store.get('1A');
    expect(domain).toHaveLength(1);
    expect(domain[0]?.score).toBe(0.85);
    expect(domain[0]?.votes).toBe(3);
    expect(domain[0]?.raw).toBe('ALIEN');
  });

  it('merges into a slot that was never seeded', () => {
    const store = createDomainStore();
    store.merge('9D', [cand('NEWLY')]);
    expect(answersOf(store.get('9D'))).toEqual(['NEWLY']);
  });

  it('restores a candidate that a trailed reduction had removed, so a re-ask result is usable now', () => {
    const store = createDomainStore();
    store.setBase('1A', SEED_5);
    store.push();
    store.reduce('1A', () => false);
    expect(store.sizeOf('1A')).toBe(0);

    store.merge('1A', [cand('ACORN', { score: 0.99, votes: 2 })]);
    const domain = store.get('1A');
    expect(answersOf(domain)).toEqual(['ACORN']);
    expect(domain[0]?.score).toBe(0.99);

    store.pop();
    expect(answersOf(store.get('1A'))).toEqual(answersOf(SEED_5));
  });

  it('de-duplicates within a single merge call', () => {
    const store = createDomainStore();
    store.merge('1A', [
      cand('ALIEN', { score: 0.3, votes: 1 }),
      cand('ALIEN', { score: 0.7, votes: 2 }),
    ]);
    const domain = store.get('1A');
    expect(domain).toHaveLength(1);
    expect(domain[0]?.score).toBe(0.7);
    expect(domain[0]?.votes).toBe(3);
  });

  it('setBase clears the trailed reductions recorded against the slot it replaces', () => {
    const store = createDomainStore();
    store.setBase('1A', SEED_5);
    store.push();
    store.reduce('1A', (c) => c.answer === 'ALIEN');
    store.setBase('1A', [cand('FRESH'), cand('START')]);
    expect(answersOf(store.get('1A'))).toEqual(['FRESH', 'START']);

    store.pop();
    expect(answersOf(store.get('1A'))).toEqual(['FRESH', 'START']);
  });
});

describe('createDomainStore: suspect marks', () => {
  it('marks a slot suspect and leaves the mark untouched by undo', () => {
    const store = createDomainStore();
    store.setBase('1A', SEED_5);
    store.push();
    store.markSuspect('1A');
    expect(store.isSuspect('1A')).toBe(true);
    expect(store.isSuspect('2D')).toBe(false);

    store.undoTo(0);
    expect(store.isSuspect('1A')).toBe(true);
  });

  it('marks a slot that has no domain yet', () => {
    const store = createDomainStore();
    store.markSuspect('4D');
    expect(store.isSuspect('4D')).toBe(true);
    expect(store.sizeOf('4D')).toBe(0);
  });
});

// Acceptance 4.
describe('createDomainStore: randomised reduce/undo', () => {
  it('returns every slot to its base domain after 500 seeded operations', () => {
    const rng = mulberry32(20260903);
    const store = createDomainStore();
    const slotIds = ['1A', '2D', '3A', '4D'];
    const bases = new Map<string, Candidate[]>();

    for (const [i, slotId] of slotIds.entries()) {
      const base = Array.from({ length: 8 }, (_, k) =>
        cand(`S${i}W${k}`, { rank: k, score: 1 - k / 10 }),
      );
      bases.set(slotId, base);
      store.setBase(slotId, base);
    }

    for (let op = 0; op < 500; op += 1) {
      const roll = rng();
      if (roll < 0.45 || store.depth() === 0) {
        // Reduce, always inside a frame so the reduction is trailed.
        if (store.depth() === 0) store.push();
        const slotId = slotIds[Math.floor(rng() * slotIds.length)] ?? '1A';
        const threshold = rng();
        store.reduce(slotId, () => rng() > threshold, 'random');
      } else if (roll < 0.75) {
        store.push();
      } else if (roll < 0.9) {
        store.pop();
      } else {
        store.undoTo(Math.floor(rng() * (store.depth() + 2)));
      }
    }

    store.undoTo(0);
    expect(store.depth()).toBe(0);
    for (const slotId of slotIds) {
      expect(store.get(slotId)).toEqual(bases.get(slotId));
    }
  });
});
