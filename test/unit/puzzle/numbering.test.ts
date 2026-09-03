import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  assertNumberingMatches,
  buildSlots,
  computeNumbering,
  type SourceClue,
} from '../../../src/puzzle/numbering.js';
import type { Cell, NormalisedPuzzleFile, Slot } from '../../../src/puzzle/types.js';

function readFixture(name: string): NormalisedPuzzleFile {
  return JSON.parse(
    readFileSync(new URL(`../../fixtures/puzzles/${name}.json`, import.meta.url), 'utf8'),
  ) as NormalisedPuzzleFile;
}

/** `Cell[][]` -> the `boolean[][]` block matrix `computeNumbering` expects. */
function blocksOf(cells: Cell[][]): boolean[][] {
  return cells.map((row) => row.map((cell) => cell.block));
}

/** `Cell[][]` -> the `(number | null)[][]` matrix the fixture itself supplies. */
function suppliedNumbersOf(cells: Cell[][]): (number | null)[][] {
  return cells.map((row) => row.map((cell) => cell.number ?? null));
}

/** The fixture's own `Slot[]` reduced to the `SourceClue[]` shape `buildSlots` takes. */
function sourceCluesOf(slots: Slot[]): SourceClue[] {
  return slots.map((slot) => ({ number: slot.number, direction: slot.direction, text: slot.clue }));
}

describe('computeNumbering', () => {
  it('reproduces synthetic-5x5 numbering exactly', () => {
    const fixture = readFixture('synthetic-5x5');
    const { numbers } = computeNumbering(blocksOf(fixture.cells), { minRun: 2 });
    expect(numbers).toEqual(suppliedNumbersOf(fixture.cells));
  });

  it('reproduces synthetic-7x7 numbering exactly, and 9A carries enumeration "(3,4)"', () => {
    const fixture = readFixture('synthetic-7x7');
    const { numbers, runs } = computeNumbering(blocksOf(fixture.cells), { minRun: 2 });
    expect(numbers).toEqual(suppliedNumbersOf(fixture.cells));

    const slots = buildSlots({ numbers, runs }, sourceCluesOf(fixture.slots), { minRun: 2 });
    const nineAcross = slots.find((slot) => slot.id === '9A');
    expect(nineAcross?.enumeration).toBe('(3,4)');
  });

  it('numbers a 3x3 all-white grid per the B19 rule, as an explicit expected matrix', () => {
    // 3x3, no blocks. Standard American numbering (verified against the
    // synthetic fixtures above, which is the binding reference): every cell
    // that begins an across or down run of at least `minRun` gets the next
    // number, scanning left to right, top to bottom. Row 0 begins a down run
    // at every column (1, 2, 3); row 0 col 0 also begins the first across
    // run, so it takes the single number 1 rather than a second one. Rows 1
    // and 2 each begin a new across run at column 0 (4, then 5) - their
    // column-0 down run already started at row 0, so it is not renumbered.
    const blocks: boolean[][] = [
      [false, false, false],
      [false, false, false],
      [false, false, false],
    ];

    const { numbers } = computeNumbering(blocks, { minRun: 2 });

    expect(numbers).toEqual([
      [1, 2, 3],
      [4, null, null],
      [5, null, null],
    ]);
  });

  it('never numbers a run of length 1 at minRun 2, but does number a run of length 2', () => {
    const isolated = computeNumbering([[true, false, true]], { minRun: 2 });
    expect(isolated.numbers).toEqual([[null, null, null]]);
    expect(isolated.runs).toEqual([]);

    const pair = computeNumbering([[true, false, false, true]], { minRun: 2 });
    expect(pair.numbers).toEqual([[null, 1, null, null]]);
    expect(pair.runs).toHaveLength(1);
    expect(pair.runs[0]).toMatchObject({ number: 1, direction: 'across', length: 2 });
  });

  it('gives each qualifying run its cells in reading order', () => {
    const { runs } = computeNumbering(
      [
        [false, false],
        [false, false],
      ],
      { minRun: 2 },
    );
    const across = runs.find((r) => r.direction === 'across' && r.row === 0);
    const down = runs.find((r) => r.direction === 'down' && r.col === 0);
    expect(across?.cells).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect(down?.cells).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });
});

describe('buildSlots', () => {
  it('drops a run with no matching clue in the source list', () => {
    const numbering = computeNumbering(
      [
        [false, false],
        [false, false],
      ],
      { minRun: 2 },
    );
    // Only supply a clue for 1A; 1D and 2D have qualifying runs but no clue.
    const clues: SourceClue[] = [{ number: 1, direction: 'across', text: 'Only clue (2)' }];

    const slots = buildSlots(numbering, clues, { minRun: 2 });

    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ id: '1A', clue: 'Only clue (2)', enumeration: '(2)' });
  });

  it('reproduces every slot in synthetic-5x5, in fixture order, from clues alone', () => {
    const fixture = readFixture('synthetic-5x5');
    const numbering = computeNumbering(blocksOf(fixture.cells), { minRun: 2 });
    const slots = buildSlots(numbering, sourceCluesOf(fixture.slots), { minRun: 2 });

    const actual = slots.map(({ id, number, direction, row, col, length, clue }) => ({
      id,
      number,
      direction,
      row,
      col,
      length,
      clue,
    }));
    const expected = fixture.slots.map(({ id, number, direction, row, col, length, clue }) => ({
      id,
      number,
      direction,
      row,
      col,
      length,
      clue,
    }));
    expect(actual).toEqual(expected);
  });
});

describe('assertNumberingMatches', () => {
  it('does not throw when the computed and supplied numbering agree', () => {
    const fixture = readFixture('synthetic-5x5');
    const { numbers } = computeNumbering(blocksOf(fixture.cells), { minRun: 2 });
    expect(() => assertNumberingMatches({ numbers, runs: [] }, suppliedNumbersOf(fixture.cells))).not.toThrow();
  });

  it('throws naming the first divergent cell when a supplied number is shifted', () => {
    const fixture = readFixture('synthetic-5x5');
    const { numbers } = computeNumbering(blocksOf(fixture.cells), { minRun: 2 });
    const supplied = suppliedNumbersOf(fixture.cells);
    // Fixture cell r0c1 is numbered 2; corrupt it so it disagrees.
    const shiftedRow = supplied[0];
    if (shiftedRow === undefined) throw new Error('fixture row 0 missing');
    shiftedRow[1] = 99;

    expect(() => assertNumberingMatches({ numbers, runs: [] }, supplied)).toThrow(/r0c1/);
  });
});
