import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { diff, score } from '../../../src/eval/scorer.js';
import type { GridSnapshot } from '../../../src/grid/types.js';
import type { Slot } from '../../../src/puzzle/types.js';

/**
 * Fixtures at `test/fixtures/puzzles/*.json` carry both the puzzle (cells,
 * slots) and a `solution` field the scorer takes as an argument rather than
 * loading (T16's decision). This file reads the raw JSON directly rather
 * than casting through `Puzzle`, since only `slots` and `solution` are
 * needed here.
 */
interface Fixture {
  cells: Array<Array<{ row: number; col: number; block: boolean }>>;
  slots: Slot[];
  solution: string[][];
}

function loadFixture(name: string): Fixture {
  const url = new URL(`../../fixtures/puzzles/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Fixture;
}

/** Every non-block [row, col] in the fixture, per `cells[].block`. */
function nonBlockCells(fixture: Fixture): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  for (const row of fixture.cells) {
    for (const cell of row) {
      if (!cell.block) cells.push([cell.row, cell.col]);
    }
  }
  return cells;
}

/** An all-empty snapshot the size of the fixture's grid. */
function emptySnapshot(fixture: Fixture): GridSnapshot {
  return {
    letters: fixture.solution.map((row) => row.map(() => null)),
    assigned: {},
  };
}

/** A snapshot equal to the solution: a perfect fill, block cells left null. */
function perfectSnapshot(fixture: Fixture): GridSnapshot {
  return {
    letters: fixture.solution.map((row) => row.map((letter) => (letter === '' ? null : letter))),
    assigned: {},
  };
}

/** Deep-clones a snapshot's letters so mutating the clone is safe. */
function cloneSnapshot(snapshot: GridSnapshot): GridSnapshot {
  return {
    letters: snapshot.letters.map((row) => row.slice()),
    assigned: { ...snapshot.assigned },
  };
}

function setLetter(snapshot: GridSnapshot, row: number, col: number, letter: string | null): void {
  const targetRow = snapshot.letters[row];
  if (targetRow === undefined) throw new Error(`snapshot missing row ${row}`);
  targetRow[col] = letter;
}

describe('score (synthetic-5x5)', () => {
  const fixture = loadFixture('synthetic-5x5');
  const nonBlockCount = nonBlockCells(fixture).length; // 22

  it('a perfect fill gives letters:1, words:1, perfect:true, emptyCells:0', () => {
    const snapshot = perfectSnapshot(fixture);
    const result = score(snapshot, fixture.solution, fixture.slots);
    expect(result).toEqual({ letters: 1, words: 1, perfect: true, emptyCells: 0 });
  });

  it('one wrong letter (a cell shared by two slots) reduces both fractions and clears perfect', () => {
    // r0c0 is the shared start cell of 1A and 1D (see the fixture's slot
    // list), so flipping it wrong takes exactly those two slots down.
    const snapshot = perfectSnapshot(fixture);
    const truth = fixture.solution[0]?.[0];
    if (truth === undefined) throw new Error('fixture missing r0c0');
    const wrongLetter = truth === 'Z' ? 'Y' : 'Z';
    setLetter(snapshot, 0, 0, wrongLetter);

    const result = score(snapshot, fixture.solution, fixture.slots);

    expect(nonBlockCount).toBe(22);
    expect(result.perfect).toBe(false);
    expect(result.letters).toBe(21 / 22);
    expect(result.emptyCells).toBe(0);
    expect(result.words).toBe(9 / 11); // 11 slots total, 1A and 1D both broken
  });

  it('an empty grid gives letters:0, words:0, and emptyCells equal to the non-block cell count', () => {
    const snapshot = emptySnapshot(fixture);
    const result = score(snapshot, fixture.solution, fixture.slots);
    expect(result).toEqual({ letters: 0, words: 0, perfect: false, emptyCells: nonBlockCount });
  });

  it('one complete correct slot among an otherwise empty grid gives the exact words fraction', () => {
    const snapshot = emptySnapshot(fixture);
    const slot = fixture.slots.find((s) => s.id === '1A');
    if (slot === undefined) throw new Error('fixture has no slot 1A');
    for (const [row, col] of slot.cells) {
      const truth = fixture.solution[row]?.[col];
      if (truth === undefined || truth === '') throw new Error(`solution missing r${row}c${col}`);
      setLetter(snapshot, row, col, truth);
    }

    const result = score(snapshot, fixture.solution, fixture.slots);

    expect(result.words).toBe(1 / 11);
    expect(result.letters).toBe(2 / 22); // 1A is 2 cells long
    expect(result.perfect).toBe(false);
    expect(result.emptyCells).toBe(nonBlockCount - 2);
  });

  it('a partially filled slot counts as incorrect even with every filled letter right', () => {
    const snapshot = emptySnapshot(fixture);
    const slot = fixture.slots.find((s) => s.id === '5A'); // length 5
    if (slot === undefined) throw new Error('fixture has no slot 5A');
    const [firstCell] = slot.cells;
    if (firstCell === undefined) throw new Error('slot 5A has no cells');
    const [row, col] = firstCell;
    const truth = fixture.solution[row]?.[col];
    if (truth === undefined || truth === '') throw new Error(`solution missing r${row}c${col}`);
    setLetter(snapshot, row, col, truth); // only the first of 5 cells filled, correctly

    const result = score(snapshot, fixture.solution, fixture.slots);
    expect(result.words).toBe(0);
  });

  it('a puzzle with zero slots is treated as word-accuracy 1 (decision: vacuous, unreachable in practice)', () => {
    const snapshot = perfectSnapshot(fixture);
    const result = score(snapshot, fixture.solution, []);
    expect(result.words).toBe(1);
  });
});

describe('diff (synthetic-5x5)', () => {
  const fixture = loadFixture('synthetic-5x5');

  it('marks exactly the wrong cells and exactly the empty cells', () => {
    // 1A ("OH") filled correctly, 3A filled wrong, everything else empty.
    const snapshot = emptySnapshot(fixture);
    const oneA = fixture.slots.find((s) => s.id === '1A');
    const threeA = fixture.slots.find((s) => s.id === '3A');
    if (oneA === undefined || threeA === undefined) throw new Error('fixture missing 1A or 3A');

    for (const [row, col] of oneA.cells) {
      const truth = fixture.solution[row]?.[col];
      if (truth === undefined || truth === '') throw new Error(`solution missing r${row}c${col}`);
      setLetter(snapshot, row, col, truth);
    }
    for (const [row, col] of threeA.cells) {
      setLetter(snapshot, row, col, 'Q'); // wrong regardless of the true letter
    }

    const matrix = diff(snapshot, fixture.solution);

    const wrongCells: Array<[number, number]> = [];
    const emptyCellsFound: Array<[number, number]> = [];
    matrix.forEach((rowVerdicts, row) => {
      rowVerdicts.forEach((verdict, col) => {
        if (verdict === 'wrong') wrongCells.push([row, col]);
        if (verdict === 'empty') emptyCellsFound.push([row, col]);
      });
    });

    expect(wrongCells).toEqual(
      threeA.cells.map(([row, col]) => [row, col]),
    );

    const expectedEmpty = nonBlockCells(fixture).filter(
      ([row, col]) =>
        !oneA.cells.some(([r, c]) => r === row && c === col) &&
        !threeA.cells.some(([r, c]) => r === row && c === col),
    );
    expect(emptyCellsFound).toEqual(expectedEmpty);
  });

  it('marks every block cell as "block" and never as wrong or empty', () => {
    const snapshot = emptySnapshot(fixture);
    const matrix = diff(snapshot, fixture.solution);
    const blockCoords = new Set(
      fixture.cells.flatMap((row) => row.filter((c) => c.block).map((c) => `${c.row},${c.col}`)),
    );
    matrix.forEach((rowVerdicts, row) => {
      rowVerdicts.forEach((verdict, col) => {
        const isKnownBlock = blockCoords.has(`${row},${col}`);
        expect(verdict === 'block').toBe(isKnownBlock);
      });
    });
  });

  it('marks a correct filled cell as "right" and an incorrect filled cell as "wrong"', () => {
    const snapshot = perfectSnapshot(fixture);
    const truth = fixture.solution[1]?.[0];
    if (truth === undefined || truth === '') throw new Error('fixture missing r1c0');
    setLetter(snapshot, 1, 0, truth === 'Q' ? 'X' : 'Q');

    const matrix = diff(snapshot, fixture.solution);

    expect(matrix[0]?.[0]).toBe('right');
    expect(matrix[1]?.[0]).toBe('wrong');
  });
});

describe('score / diff (synthetic-7x7, cross-check with a second fixture)', () => {
  const fixture = loadFixture('synthetic-7x7');
  const nonBlockCount = nonBlockCells(fixture).length;

  it('a perfect fill gives letters:1, words:1, perfect:true, emptyCells:0', () => {
    const snapshot = perfectSnapshot(fixture);
    const result = score(snapshot, fixture.solution, fixture.slots);
    expect(result).toEqual({ letters: 1, words: 1, perfect: true, emptyCells: 0 });
  });

  it('an empty grid gives emptyCells equal to the non-block cell count', () => {
    const snapshot = emptySnapshot(fixture);
    const result = score(snapshot, fixture.solution, fixture.slots);
    expect(result.emptyCells).toBe(nonBlockCount);
    expect(result.letters).toBe(0);
    expect(result.words).toBe(0);
  });

  it('does not mutate the snapshot it is given', () => {
    const snapshot = perfectSnapshot(fixture);
    const before = cloneSnapshot(snapshot);
    score(snapshot, fixture.solution, fixture.slots);
    diff(snapshot, fixture.solution);
    expect(snapshot).toEqual(before);
  });
});
