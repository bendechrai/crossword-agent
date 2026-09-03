import { notImplemented } from '../util/errors.js';
import type {
  NormalisedPuzzleFile,
  Puzzle,
  PuzzleIndexRow,
  PuzzleWithSolution,
} from './types.js';

export interface LibraryOptions {
  /** Defaults to `resolvePuzzlesDir()`. */
  puzzlesDir?: string;
}

/** Writes `puzzles/<source>/<id>.json`, ajv-validated before the write (B16). */
export function writeNormalised(
  _puzzle: PuzzleWithSolution,
  _opts?: LibraryOptions,
): Promise<NormalisedPuzzleFile> {
  return notImplemented('src/puzzle/library.ts');
}

export function readNormalised(
  _id: string,
  _opts?: LibraryOptions,
): Promise<NormalisedPuzzleFile> {
  return notImplemented('src/puzzle/library.ts');
}

/** The solver's accessor: the puzzle with the answers stripped (B11). */
export function loadPuzzleById(_id: string, _opts?: LibraryOptions): Promise<Puzzle> {
  return notImplemented('src/puzzle/library.ts');
}

/** The scorer's accessor. */
export function loadSolution(_id: string, _opts?: LibraryOptions): Promise<string[][]> {
  return notImplemented('src/puzzle/library.ts');
}

export function readIndex(_opts?: LibraryOptions): Promise<PuzzleIndexRow[]> {
  return notImplemented('src/puzzle/library.ts');
}

/**
 * All index writes go through one writer, serialised by an O_EXCL lock file at
 * `puzzles/.index.lock` with a 5 second timeout, then an atomic tmp + rename
 * (B34). `bench` at concurrency 2 or more otherwise loses rows.
 */
export function upsertIndexRow(_row: PuzzleIndexRow, _opts?: LibraryOptions): Promise<void> {
  return notImplemented('src/puzzle/library.ts');
}
