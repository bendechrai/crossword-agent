import { notFoundError } from '../cli/exit.js';
import { extractEnumeration } from './enumeration.js';
import type { Direction, Slot } from './types.js';

export interface NumberingOptions {
  /** Minimum run length for a run to be a slot; 2 by default (B20). */
  minRun: number;
}

/** One across or down run found in the grid. */
export interface RunSpec {
  number: number;
  direction: Direction;
  row: number;
  col: number;
  length: number;
  cells: ReadonlyArray<readonly [number, number]>;
}

export interface Numbering {
  numbers: (number | null)[][];
  runs: RunSpec[];
}

/** A clue as the source supplies it, before it is attached to a run. */
export interface SourceClue {
  number: number;
  direction: Direction;
  text: string;
}

/**
 * True when `(row, col)` is inside the grid and is not a block. Out-of-bounds
 * cells read as blocks, which is what lets the run-boundary checks below
 * treat the grid edge the same as a block.
 */
function isWhite(blocks: ReadonlyArray<ReadonlyArray<boolean>>, row: number, col: number): boolean {
  const rowCells = blocks[row];
  if (rowCells === undefined) return false;
  const cell = rowCells[col];
  return cell === false;
}

/**
 * T7 (B19): a white cell starts a number when it begins an across run of at
 * least `minRun` or a down run of at least `minRun`; numbers run left to
 * right, top to bottom, from 1.
 */
export function computeNumbering(blocks: boolean[][], opts: NumberingOptions): Numbering {
  const height = blocks.length;
  const width = blocks[0]?.length ?? 0;

  const numbers: (number | null)[][] = [];
  for (let row = 0; row < height; row++) {
    numbers.push(new Array<number | null>(width).fill(null));
  }

  const runs: RunSpec[] = [];
  let nextNumber = 1;

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      if (!isWhite(blocks, row, col)) continue;

      // A run "begins" at a white cell whose predecessor (left for across,
      // above for down) is a block or off the grid - regardless of how long
      // the run turns out to be. Length only decides whether it qualifies
      // for a number, via `minRun`.
      const beginsAcross = !isWhite(blocks, row, col - 1);
      const beginsDown = !isWhite(blocks, row - 1, col);

      let acrossLength = 0;
      if (beginsAcross) {
        let end = col;
        while (isWhite(blocks, row, end + 1)) end++;
        acrossLength = end - col + 1;
      }

      let downLength = 0;
      if (beginsDown) {
        let end = row;
        while (isWhite(blocks, end + 1, col)) end++;
        downLength = end - row + 1;
      }

      const acrossQualifies = beginsAcross && acrossLength >= opts.minRun;
      const downQualifies = beginsDown && downLength >= opts.minRun;

      if (!acrossQualifies && !downQualifies) continue;

      const number = nextNumber;
      nextNumber++;
      const numberRow = numbers[row];
      if (numberRow !== undefined) numberRow[col] = number;

      if (acrossQualifies) {
        const cells: Array<[number, number]> = [];
        for (let c = col; c < col + acrossLength; c++) cells.push([row, c]);
        runs.push({ number, direction: 'across', row, col, length: acrossLength, cells });
      }
      if (downQualifies) {
        const cells: Array<[number, number]> = [];
        for (let r = row; r < row + downLength; r++) cells.push([r, col]);
        runs.push({ number, direction: 'down', row, col, length: downLength, cells });
      }
    }
  }

  return { numbers, runs };
}

/** Attaches clue text; a run with no clue in the source list is not a slot (B20). */
export function buildSlots(
  numbering: Numbering,
  clues: ReadonlyArray<SourceClue>,
  opts: NumberingOptions,
): Slot[] {
  const clueByKey = new Map<string, SourceClue>();
  for (const clue of clues) {
    clueByKey.set(`${clue.number}${clue.direction}`, clue);
  }

  const slots: Slot[] = [];
  for (const run of numbering.runs) {
    if (run.length < opts.minRun) continue;

    const clue = clueByKey.get(`${run.number}${run.direction}`);
    if (clue === undefined) continue;

    const id = `${run.number}${run.direction === 'across' ? 'A' : 'D'}`;
    const enumeration = extractEnumeration(clue.text);

    slots.push({
      id,
      number: run.number,
      direction: run.direction,
      row: run.row,
      col: run.col,
      length: run.length,
      clue: clue.text,
      cells: run.cells,
      ...(enumeration === undefined ? {} : { enumeration }),
    });
  }
  return slots;
}

/**
 * Throws a load error (exit 3) naming the first divergent cell as
 * `r{row}c{col}` when the source's own numbering disagrees (B19).
 */
export function assertNumberingMatches(computed: Numbering, supplied: (number | null)[][]): void {
  for (let row = 0; row < computed.numbers.length; row++) {
    const computedRow = computed.numbers[row] ?? [];
    const suppliedRow = supplied[row] ?? [];
    for (let col = 0; col < computedRow.length; col++) {
      const computedValue = computedRow[col] ?? null;
      const suppliedValue = suppliedRow[col] ?? null;
      if (computedValue !== suppliedValue) {
        throw notFoundError(
          `clue numbering mismatch at r${row}c${col}: computed ${String(computedValue)}, ` +
            `source supplied ${String(suppliedValue)}`,
        );
      }
    }
  }
}
