import type { PuzzleExt, PuzzleWithSolution } from '../types.js';
import { guardianAdapter } from './guardian.js';
import { xdAdapter } from './xd.js';
import { xwordlyAdapter } from './xwordly.js';

export interface PuzzleAdapterContext {
  /** Puzzle id to stamp onto the result. */
  id: string;
  source: string;
  /** Path or URL the bytes came from, for error messages. */
  origin?: string;
  date?: string;
  title?: string;
}

export interface PuzzleAdapter {
  /** Stable name, used in error messages. */
  name: string;
  extensions: ReadonlyArray<PuzzleExt>;
  parse(bytes: Buffer, ctx: PuzzleAdapterContext): Promise<PuzzleWithSolution>;
}

/**
 * Extension -> adapter. A normalised `puzzles/<source>/<id>.json` is not read
 * through here: that is `puzzle/library.ts`, per B16. The `json` entry is for
 * a raw Guardian payload handed to `xw solve <path>`.
 */
const ADAPTERS: ReadonlyArray<PuzzleAdapter> = [xwordlyAdapter, xdAdapter, guardianAdapter];

export function adapterFor(ext: PuzzleExt): PuzzleAdapter | undefined {
  return ADAPTERS.find((a) => a.extensions.includes(ext));
}

export function allAdapters(): ReadonlyArray<PuzzleAdapter> {
  return ADAPTERS;
}
