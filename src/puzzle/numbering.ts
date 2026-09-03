import { notImplemented } from '../util/errors.js';
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
 * T7 (B19): a white cell starts a number when it begins an across run of at
 * least `minRun` or a down run of at least `minRun`; numbers run left to
 * right, top to bottom, from 1.
 */
export function computeNumbering(_blocks: boolean[][], _opts: NumberingOptions): Numbering {
  return notImplemented('src/puzzle/numbering.ts');
}

/** Attaches clue text; a run with no clue in the source list is not a slot (B20). */
export function buildSlots(
  _numbering: Numbering,
  _clues: ReadonlyArray<SourceClue>,
  _opts: NumberingOptions,
): Slot[] {
  return notImplemented('src/puzzle/numbering.ts');
}

/**
 * Throws a load error (exit 3) naming the first divergent cell as
 * `r{row}c{col}` when the source's own numbering disagrees (B19).
 */
export function assertNumberingMatches(
  _computed: Numbering,
  _supplied: (number | null)[][],
): void {
  return notImplemented('src/puzzle/numbering.ts');
}
