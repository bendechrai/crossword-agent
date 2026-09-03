/**
 * Puzzle data model.
 *
 * Cells are addressed as [row, col] with row 0 at the top and col 0 at the
 * left, and rendered as `r{row}c{col}` in events and error messages (B18).
 */

export type Direction = 'across' | 'down';

export type PuzzleStyle = 'american' | 'cryptic' | 'quick' | 'unknown';

/** Which measurement stratum a puzzle belongs to in a bench set (A1). */
export type Stratum = 'american' | 'cryptic';

/**
 * Which parser produced a puzzle (B17). `'xd-hand'` is a T25 addition: the
 * `.xd` adapter uses a hand-written line parser instead of
 * `xd-crossword-tools` (see the comment at the top of
 * `src/puzzle/adapters/xd.ts` for why), pre-authorised as a one-line,
 * one-file contract change for that task.
 */
export type ParsedBy = '@xwordly/xword-parser' | 'xd-crossword-tools' | 'guardian-json' | 'xd-hand';

/** File formats the loader dispatches on. `json` is our own normalised form. */
export type PuzzleExt = 'puz' | 'ipuz' | 'jpz' | 'xd' | 'json';

export interface Cell {
  row: number;
  col: number;
  block: boolean;
  /** Clue number, always recomputed from the grid (B19). */
  number?: number;
}

export interface Slot {
  /** `${number}${'A'|'D'}`, for example "12A". */
  id: string;
  number: number;
  direction: Direction;
  /** Start cell. */
  row: number;
  col: number;
  length: number;
  /** Verbatim from the source, enumeration group included. */
  clue: string;
  /** For example "(3,4)". Prompt only, never used for validation (B21). */
  enumeration?: string;
  cells: ReadonlyArray<readonly [number, number]>;
}

/**
 * What the solver is handed. There is deliberately no optional `solution`
 * field: the solver's input is structurally incapable of carrying answers.
 */
export interface Puzzle {
  id: string;
  source: string;
  date?: string;
  title?: string;
  author?: string;
  style: PuzzleStyle;
  width: number;
  height: number;
  cells: Cell[][];
  slots: Slot[];
  parsedBy: ParsedBy;
}

/** Returned only by the scorer's loader path (B11). */
export interface PuzzleWithSolution extends Puzzle {
  /** Solution letters, `height` rows of `width` entries; "" for a block. */
  solution: string[][];
}

/** The on-disk normalised puzzle at `puzzles/<source>/<id>.json` (B16). */
export interface NormalisedPuzzleFile extends PuzzleWithSolution {
  schemaVersion: 1;
  /** ISO 8601. */
  fetchedAt: string;
}

/** A row of `puzzles/index.json` (B34). */
export interface PuzzleIndexRow {
  id: string;
  source: string;
  date: string | null;
  title: string | null;
  style: PuzzleStyle;
  width: number;
  height: number;
  slotCount: number;
  /** Repo-relative, POSIX-separated. */
  files: { original: string; normalised: string };
  schemaVersion: 1;
  parsedBy: ParsedBy;
  /** ISO 8601. */
  addedAt: string;
  bestLetterAccuracy: number | null;
  lastRunAt: string | null;
}
