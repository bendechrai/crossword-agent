import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { Grid } from '../../../src/grid/model.js';
import type { Puzzle } from '../../../src/puzzle/types.js';

/**
 * Fixtures at `test/fixtures/puzzles/*.json` carry a `solution` field for the
 * scorer's use (B11's `PuzzleWithSolution`). The `Puzzle` the solver sees
 * structurally has no such field, so this file reads the fixture twice: once
 * cast to `Puzzle` for the `Grid` under test, and once for the raw solution
 * grid used only to build conflict-free test answers.
 */
function loadFixtureJson(name: string): Record<string, unknown> {
  const url = new URL(`../../fixtures/puzzles/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Record<string, unknown>;
}

function loadPuzzle(name: string): Puzzle {
  return loadFixtureJson(name) as unknown as Puzzle;
}

/** The fixture's `solution` field: `height` rows of `width` letters, "" for a block. */
function loadSolution(name: string): string[][] {
  const raw = loadFixtureJson(name);
  return raw['solution'] as string[][];
}

function answerFor(puzzle: Puzzle, solution: string[][], slotId: string): string {
  const slot = puzzle.slots.find((s) => s.id === slotId);
  if (slot === undefined) throw new Error(`fixture has no slot ${slotId}`);
  return slot.cells
    .map(([row, col]) => {
      const rowLetters = solution[row];
      if (rowLetters === undefined) throw new Error(`solution missing row ${row}`);
      const letter = rowLetters[col];
      if (letter === undefined || letter === '') {
        throw new Error(`solution missing letter at r${row}c${col}`);
      }
      return letter;
    })
    .join('');
}

/** Every non-block [row, col] in the puzzle. */
function nonBlockCells(puzzle: Puzzle): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  for (const row of puzzle.cells) {
    for (const cell of row) {
      if (!cell.block) cells.push([cell.row, cell.col]);
    }
  }
  return cells;
}

// Deterministic PRNG (mulberry32), so the randomised tests are reproducible
// and never touch the network or Math.random.
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

function pick<T>(items: readonly T[], rand: () => number): T {
  const item = items[Math.floor(rand() * items.length)];
  if (item === undefined) throw new Error('pick() from an empty array');
  return item;
}

describe('Grid (synthetic-5x5)', () => {
  const puzzle = loadPuzzle('synthetic-5x5');
  const solution = loadSolution('synthetic-5x5');

  it('indexes all 11 slots from the fixture', () => {
    const grid = new Grid(puzzle);
    expect(grid.slots.size).toBe(11);
    expect([...grid.slots.keys()].sort()).toEqual(
      ['1A', '1D', '2D', '3A', '3D', '4D', '5A', '6D', '7A', '8A', '9A'].sort(),
    );
  });

  it('crossings("1A") returns 1D at the shared first cell and 2D at the shared second cell', () => {
    const grid = new Grid(puzzle);
    expect(grid.crossings('1A')).toEqual([
      { otherSlotId: '1D', offsetInThis: 0, offsetInOther: 0 },
      { otherSlotId: '2D', offsetInThis: 1, offsetInOther: 0 },
    ]);
  });

  it('crossings("2D") is one shorter than its length: r4c1 is unchecked', () => {
    const grid = new Grid(puzzle);
    const slot = grid.slots.get('2D');
    expect(slot?.length).toBe(5);
    const crossings = grid.crossings('2D');
    expect(crossings).toHaveLength(4);
    expect(crossings).toEqual([
      { otherSlotId: '1A', offsetInThis: 0, offsetInOther: 1 },
      { otherSlotId: '5A', offsetInThis: 1, offsetInOther: 1 },
      { otherSlotId: '7A', offsetInThis: 2, offsetInOther: 1 },
      { otherSlotId: '8A', offsetInThis: 3, offsetInOther: 1 },
    ]);
    // offset 4 (r4c1, the unchecked cell) contributes nothing.
    expect(crossings.some((c) => c.offsetInThis === 4)).toBe(false);
  });

  it('isChecked is false for exactly r4c1 among every non-block cell', () => {
    const grid = new Grid(puzzle);
    const unchecked = nonBlockCells(puzzle).filter(([row, col]) => !grid.isChecked(row, col));
    expect(unchecked).toEqual([[4, 1]]);
  });

  it('patternFor is all "?" before any assignment', () => {
    const grid = new Grid(puzzle);
    expect(grid.patternFor('2D')).toBe('?????');
  });

  it('patternFor has exactly one fixed letter at the right offset after a crossing assign', () => {
    const grid = new Grid(puzzle);
    grid.assign('1A', answerFor(puzzle, solution, '1A')); // "OH"
    expect(grid.patternFor('2D')).toBe('H????');
  });

  it('unassign is an exact undo: a letter fixed by a crossing assignment survives', () => {
    const grid = new Grid(puzzle);
    const answerA = answerFor(puzzle, solution, '1D'); // "ORAL", fixes r0c0 = 'O'
    const answerB = answerFor(puzzle, solution, '1A'); // "OH", crosses 1D at r0c0

    grid.assign('1D', answerA);
    const beforeB = grid.snapshot();
    const patternABeforeB = grid.patternFor('1D');

    grid.assign('1A', answerB);
    expect(grid.letterAt(0, 1)).toBe('H'); // written by B alone

    grid.unassign('1A');

    expect(grid.patternFor('1D')).toBe(patternABeforeB);
    expect(grid.snapshot()).toEqual(beforeB);
    expect(grid.letterAt(0, 0)).toBe('O'); // survives: 1D fixed it, not 1A
    expect(grid.letterAt(0, 1)).toBeNull(); // reverts: 1A alone had written it
    expect(grid.assignmentOf('1A')).toBeUndefined();
    expect(grid.assignmentOf('1D')).toBe('ORAL');
  });

  it('randomised assign/unassign 1000 times returns to the empty snapshot (seeded)', () => {
    // Each step randomly assigns a random not-yet-assigned slot, or unassigns
    // a random member of the currently-assigned set (not necessarily the
    // most recent one), 1,000 times, then drains whatever remains in a
    // shuffled order. This exercises non-LIFO unassign order, unlike a stack
    // walk which would only ever undo the most recently assigned slot.
    const grid = new Grid(puzzle);
    const emptySnapshot = grid.snapshot();
    const slotIds = [...grid.slots.keys()];
    const rand = mulberry32(20260903);
    const assignedSet = new Set<string>();

    for (let i = 0; i < 1000; i += 1) {
      const canAssign = slotIds.filter((id) => !assignedSet.has(id));
      const currentlyAssigned = [...assignedSet];
      const doAssign = currentlyAssigned.length === 0 || (canAssign.length > 0 && rand() < 0.5);

      if (doAssign) {
        const slotId = pick(canAssign, rand);
        grid.assign(slotId, answerFor(puzzle, solution, slotId));
        assignedSet.add(slotId);
      } else {
        const slotId = pick(currentlyAssigned, rand);
        grid.unassign(slotId);
        assignedSet.delete(slotId);
      }
    }

    // Drain whatever the random walk left assigned, in a shuffled order.
    const remaining = [...assignedSet];
    while (remaining.length > 0) {
      const index = Math.floor(rand() * remaining.length);
      const [slotId] = remaining.splice(index, 1);
      if (slotId === undefined) throw new Error('remaining was unexpectedly empty');
      grid.unassign(slotId);
    }

    expect(grid.snapshot()).toEqual(emptySnapshot);
  });

  it('unassign in non-LIFO order: unassigning the earlier of two crossing assignments leaves the later one intact', () => {
    // assign A, assign B crossing A, unassign A (the earlier one, not the
    // last): patternFor(B) must be unchanged, and the grid must equal the
    // state reached by assigning B alone from empty.
    const answerA = answerFor(puzzle, solution, '1D'); // "ORAL", fixes r0c0 = 'O'
    const answerB = answerFor(puzzle, solution, '1A'); // "OH", crosses 1D at r0c0

    const grid = new Grid(puzzle);
    grid.assign('1D', answerA);
    grid.assign('1A', answerB);
    const patternBBeforeUnassign = grid.patternFor('1A');

    grid.unassign('1D'); // non-LIFO: unassign the earlier assignment first

    expect(grid.patternFor('1A')).toBe(patternBBeforeUnassign);

    const bAlone = new Grid(puzzle);
    bAlone.assign('1A', answerB);
    expect(grid.snapshot()).toEqual(bAlone.snapshot());
  });

  it('assigning a conflicting letter throws and leaves the grid unchanged', () => {
    const grid = new Grid(puzzle);
    grid.assign('1A', answerFor(puzzle, solution, '1A')); // "OH" -> r0c0 = 'O'
    const before = grid.snapshot();

    expect(() => grid.assign('1D', 'XRAL')).toThrow(); // r0c0 would become 'X'
    expect(grid.snapshot()).toEqual(before);
    expect(grid.assignmentOf('1D')).toBeUndefined();
  });

  it('assign throws on a length mismatch', () => {
    const grid = new Grid(puzzle);
    expect(() => grid.assign('1A', 'TOOLONG')).toThrow();
  });

  it('unassign throws for a slot that is not currently assigned', () => {
    const grid = new Grid(puzzle);
    expect(() => grid.unassign('1A')).toThrow();
  });

  it('methods throw for an unknown slot id', () => {
    const grid = new Grid(puzzle);
    expect(() => grid.patternFor('99Z')).toThrow();
    expect(() => grid.crossings('99Z')).toThrow();
    expect(() => grid.assignmentOf('99Z')).toThrow();
    expect(() => grid.assign('99Z', 'X')).toThrow();
  });

  it('isComplete is true only once every non-block cell has a letter', () => {
    const grid = new Grid(puzzle);
    expect(grid.isComplete()).toBe(false);

    // The 6 across slots alone cover every non-block cell except r4c1,
    // which only 2D touches (it is the fixture's unchecked cell).
    for (const slotId of ['1A', '3A', '5A', '7A', '8A', '9A']) {
      grid.assign(slotId, answerFor(puzzle, solution, slotId));
    }
    expect(grid.isComplete()).toBe(false);
    expect(grid.letterAt(4, 1)).toBeNull();

    grid.assign('2D', answerFor(puzzle, solution, '2D'));
    expect(grid.isComplete()).toBe(true);

    grid.unassign('2D');
    expect(grid.isComplete()).toBe(false);
  });

  it('letterAt is null everywhere before assignment and for block cells throughout', () => {
    const grid = new Grid(puzzle);
    expect(grid.letterAt(0, 2)).toBeNull(); // a block cell
    grid.assign('1A', answerFor(puzzle, solution, '1A'));
    expect(grid.letterAt(0, 2)).toBeNull(); // still a block, untouched by any slot
  });

  it('snapshot returns an independent copy each call', () => {
    const grid = new Grid(puzzle);
    const snap = grid.snapshot();
    grid.assign('1A', answerFor(puzzle, solution, '1A'));
    expect(snap.letters[0]?.[0]).toBeNull(); // the earlier snapshot did not change
    expect(grid.letterAt(0, 0)).toBe('O');
  });
});

describe('Grid (synthetic-7x7)', () => {
  const puzzle = loadPuzzle('synthetic-7x7');

  it('indexes all 23 slots from the fixture', () => {
    const grid = new Grid(puzzle);
    expect(grid.slots.size).toBe(23);
  });

  it('isChecked is false for exactly r3c3 among every non-block cell', () => {
    const grid = new Grid(puzzle);
    const unchecked = nonBlockCells(puzzle).filter(([row, col]) => !grid.isChecked(row, col));
    expect(unchecked).toEqual([[3, 3]]);
  });
});
