import { describe, expect, it } from 'vitest';

import type { Candidate } from '../../../src/candidates/types.js';
import { Grid } from '../../../src/grid/model.js';
import type { DomainStore } from '../../../src/grid/types.js';
import type { Cell, Puzzle, Slot } from '../../../src/puzzle/types.js';
import { chooseSlot, marginOf, orderValues } from '../../../src/solver/ordering.js';

// Deterministic PRNG (mulberry32), matching test/unit/grid/model.test.ts, so
// the tie-break tests never touch Math.random.
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function candidate(overrides: Partial<Candidate> & { answer: string; score: number }): Candidate {
  const {
    answer,
    score,
    raw = answer,
    rank = 0,
    selfConfidence = score,
    votes = 1,
    tier = 1,
    fromCache = false,
  } = overrides;
  return { answer, score, raw, rank, selfConfidence, votes, tier, fromCache };
}

/** A minimal in-memory DomainStore: only `get` and `sizeOf` are exercised here. */
function fakeDomainStore(domains: Record<string, Candidate[]>): DomainStore {
  return {
    get(slotId: string): readonly Candidate[] {
      return domains[slotId] ?? [];
    },
    sizeOf(slotId: string): number {
      return (domains[slotId] ?? []).length;
    },
    setBase(): void {
      throw new Error('not used by this test');
    },
    merge(): void {
      throw new Error('not used by this test');
    },
    reduce(): number {
      throw new Error('not used by this test');
    },
    push(): void {
      throw new Error('not used by this test');
    },
    pop(): void {
      throw new Error('not used by this test');
    },
    undoTo(): void {
      throw new Error('not used by this test');
    },
    depth(): number {
      return 0;
    },
    isSuspect(): boolean {
      return false;
    },
    markSuspect(): void {
      throw new Error('not used by this test');
    },
  };
}

function cellRow(row: number, width: number): Cell[] {
  return Array.from({ length: width }, (_, col) => ({ row, col, block: false }));
}

/**
 * A tiny synthetic grid used by most cases below: three unconnected
 * across-only slots ("S1", "S2", "S3"), each length 3, with no down slots -
 * every slot has zero crossings, so tests that only exercise the margin/size
 * keys are not accidentally decided by the crossing tie-break.
 */
function isolatedSlotsGrid(): { grid: Grid; slots: Record<'S1' | 'S2' | 'S3', Slot> } {
  const s1: Slot = { id: 'S1', number: 1, direction: 'across', row: 0, col: 0, length: 3, clue: 'a', cells: [[0, 0], [0, 1], [0, 2]] };
  const s2: Slot = { id: 'S2', number: 2, direction: 'across', row: 1, col: 0, length: 3, clue: 'b', cells: [[1, 0], [1, 1], [1, 2]] };
  const s3: Slot = { id: 'S3', number: 3, direction: 'across', row: 2, col: 0, length: 3, clue: 'c', cells: [[2, 0], [2, 1], [2, 2]] };

  const puzzle: Puzzle = {
    id: 'ordering-fixture',
    source: 'synthetic',
    style: 'american',
    width: 3,
    height: 3,
    cells: [cellRow(0, 3), cellRow(1, 3), cellRow(2, 3)],
    slots: [s1, s2, s3],
    parsedBy: 'xd-crossword-tools',
  };

  return { grid: new Grid(puzzle), slots: { S1: s1, S2: s2, S3: s3 } };
}

/**
 * A grid with two across slots of unequal crossing degree: "1A" is crossed
 * by two unassigned down slots, "5A" by none. Used for the "most unassigned
 * crossings" tie-break case.
 */
function crossingDegreeGrid(): { grid: Grid; slots: Record<'oneA' | 'fiveA', Slot> } {
  const oneA: Slot = { id: '1A', number: 1, direction: 'across', row: 0, col: 0, length: 3, clue: 'a', cells: [[0, 0], [0, 1], [0, 2]] };
  const oneD: Slot = { id: '1D', number: 1, direction: 'down', row: 0, col: 0, length: 2, clue: 'd', cells: [[0, 0], [1, 0]] };
  const twoD: Slot = { id: '2D', number: 2, direction: 'down', row: 0, col: 1, length: 2, clue: 'e', cells: [[0, 1], [1, 1]] };
  const fiveA: Slot = { id: '5A', number: 5, direction: 'across', row: 2, col: 0, length: 3, clue: 'f', cells: [[2, 0], [2, 1], [2, 2]] };

  const puzzle: Puzzle = {
    id: 'ordering-crossing-fixture',
    source: 'synthetic',
    style: 'american',
    width: 3,
    height: 3,
    cells: [cellRow(0, 3), cellRow(1, 3), cellRow(2, 3)],
    slots: [oneA, oneD, twoD, fiveA],
    parsedBy: 'xd-crossword-tools',
  };

  return { grid: new Grid(puzzle), slots: { oneA, fiveA } };
}

describe('marginOf', () => {
  it('returns -Infinity for an empty domain', () => {
    expect(marginOf([])).toBe(-Infinity);
  });

  it('returns bestScore for a single-candidate domain', () => {
    const domain = [candidate({ answer: 'CAT', score: 0.42 })];
    expect(marginOf(domain)).toBe(0.42);
  });

  it('returns bestScore - secondBestScore for a multi-candidate domain', () => {
    const domain = [
      candidate({ answer: 'CAT', score: 0.9 }),
      candidate({ answer: 'DOG', score: 0.3 }),
      candidate({ answer: 'BAT', score: 0.6 }),
    ];
    expect(marginOf(domain)).toBeCloseTo(0.3, 10);
  });
});

describe('orderValues', () => {
  it('sorts by descending score', () => {
    const domain = [
      candidate({ answer: 'LOW', score: 0.1, rank: 0 }),
      candidate({ answer: 'HIGH', score: 0.9, rank: 1 }),
      candidate({ answer: 'MID', score: 0.5, rank: 2 }),
    ];
    expect(orderValues(domain).map((c) => c.answer)).toEqual(['HIGH', 'MID', 'LOW']);
  });

  it('preserves rank order among equal scores (stable tie-break)', () => {
    const domain = [
      candidate({ answer: 'THIRD', score: 0.5, rank: 2 }),
      candidate({ answer: 'FIRST', score: 0.5, rank: 0 }),
      candidate({ answer: 'SECOND', score: 0.5, rank: 1 }),
    ];
    expect(orderValues(domain).map((c) => c.answer)).toEqual(['FIRST', 'SECOND', 'THIRD']);
  });
});

describe('chooseSlot: margin ordering (default)', () => {
  it('picks the slot with the largest margin', () => {
    const { grid, slots } = isolatedSlotsGrid();
    const domains = fakeDomainStore({
      S1: [candidate({ answer: 'AAA', score: 0.5 }), candidate({ answer: 'AAB', score: 0.2 })], // margin 0.3
      S2: [candidate({ answer: 'BBB', score: 0.5 }), candidate({ answer: 'BBC', score: 0.4 })], // margin 0.1
      S3: [candidate({ answer: 'CCC', score: 0.55 }), candidate({ answer: 'CCD', score: 0.3 })], // margin 0.25
    });

    const chosen = chooseSlot([slots.S1, slots.S2, slots.S3], domains, grid, {
      ordering: 'margin',
      rng: mulberry32(1),
    });

    expect(chosen?.id).toBe('S1');
  });

  it('breaks an equal-margin tie by fewest surviving candidates', () => {
    const { grid, slots } = isolatedSlotsGrid();
    const domains = fakeDomainStore({
      // Both margins are 0.3; S1 has 5 candidates, S2 has 2.
      S1: [
        candidate({ answer: 'AAA', score: 0.5 }),
        candidate({ answer: 'AAB', score: 0.2 }),
        candidate({ answer: 'AAC', score: 0.1 }),
        candidate({ answer: 'AAD', score: 0.05 }),
        candidate({ answer: 'AAE', score: 0.01 }),
      ],
      S2: [candidate({ answer: 'BBB', score: 0.5 }), candidate({ answer: 'BBC', score: 0.2 })],
    });

    const chosen = chooseSlot([slots.S1, slots.S2], domains, grid, {
      ordering: 'margin',
      rng: mulberry32(1),
    });

    expect(chosen?.id).toBe('S2');
  });

  it('breaks an equal-margin, equal-size tie by most unassigned crossings', () => {
    const { grid, slots } = crossingDegreeGrid();
    const domains = fakeDomainStore({
      '1A': [candidate({ answer: 'AAA', score: 0.5 }), candidate({ answer: 'AAB', score: 0.2 })],
      '5A': [candidate({ answer: 'BBB', score: 0.5 }), candidate({ answer: 'BBC', score: 0.2 })],
    });

    const chosen = chooseSlot([slots.oneA, slots.fiveA], domains, grid, {
      ordering: 'margin',
      rng: mulberry32(1),
    });

    expect(chosen?.id).toBe('1A');
  });

  it('is deterministic per seed when every key is tied, and never touches Math.random', () => {
    const { grid, slots } = isolatedSlotsGrid();
    const domains = fakeDomainStore({
      S1: [candidate({ answer: 'AAA', score: 0.5 }), candidate({ answer: 'AAB', score: 0.2 })],
      S2: [candidate({ answer: 'BBB', score: 0.5 }), candidate({ answer: 'BBC', score: 0.2 })],
      S3: [candidate({ answer: 'CCC', score: 0.5 }), candidate({ answer: 'CCD', score: 0.2 })],
    });
    const unassigned = [slots.S1, slots.S2, slots.S3];

    const first = chooseSlot(unassigned, domains, grid, { ordering: 'margin', rng: mulberry32(7) });
    const second = chooseSlot(unassigned, domains, grid, { ordering: 'margin', rng: mulberry32(7) });
    expect(second?.id).toBe(first?.id);

    // A different seed is free to land on a different slot; assert
    // determinism per seed, not which slot wins.
    const otherSeed = chooseSlot(unassigned, domains, grid, { ordering: 'margin', rng: mulberry32(99) });
    const otherSeedAgain = chooseSlot(unassigned, domains, grid, { ordering: 'margin', rng: mulberry32(99) });
    expect(otherSeedAgain?.id).toBe(otherSeed?.id);
  });
});

describe('chooseSlot: mrv ordering', () => {
  it('swaps the primary key for domain size', () => {
    const { grid, slots } = isolatedSlotsGrid();
    const domains = fakeDomainStore({
      // S1 has the bigger margin (0.3) but the larger domain (5).
      S1: [
        candidate({ answer: 'AAA', score: 0.5 }),
        candidate({ answer: 'AAB', score: 0.2 }),
        candidate({ answer: 'AAC', score: 0.1 }),
        candidate({ answer: 'AAD', score: 0.05 }),
        candidate({ answer: 'AAE', score: 0.01 }),
      ],
      // S2 has the smaller margin (0.1) but the smaller domain (2).
      S2: [candidate({ answer: 'BBB', score: 0.5 }), candidate({ answer: 'BBC', score: 0.4 })],
    });

    const chosen = chooseSlot([slots.S1, slots.S2], domains, grid, {
      ordering: 'mrv',
      rng: mulberry32(1),
    });

    expect(chosen?.id).toBe('S2');
  });
});
