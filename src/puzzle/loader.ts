import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { notFoundError } from '../cli/exit.js';
import { adapterFor, type PuzzleAdapterContext } from './adapters/index.js';
import type { Puzzle, PuzzleExt, PuzzleWithSolution } from './types.js';

const EXTENSIONS: ReadonlyArray<PuzzleExt> = ['puz', 'ipuz', 'jpz', 'xd', 'json'];

export function isPuzzleExt(value: string): value is PuzzleExt {
  return (EXTENSIONS as ReadonlyArray<string>).includes(value);
}

export function extFromPath(path: string): PuzzleExt {
  const ext = extname(path).replace(/^\./, '').toLowerCase();
  if (!isPuzzleExt(ext)) {
    throw notFoundError(
      `unsupported puzzle format ".${ext}" for ${path}`,
      `accepted extensions: ${EXTENSIONS.join(', ')}`,
    );
  }
  return ext;
}

/** Structurally drop the answers, which is what the solver is handed (B11). */
export function stripSolution(puzzle: PuzzleWithSolution): Puzzle {
  const { solution: _solution, ...rest } = puzzle;
  return rest;
}

export async function loadPuzzleWithSolution(
  path: string,
  ctx?: Partial<PuzzleAdapterContext>,
): Promise<PuzzleWithSolution> {
  const ext = extFromPath(path);
  const adapter = adapterFor(ext);
  if (adapter === undefined) {
    throw notFoundError(`no loader registered for ".${ext}"`);
  }
  const bytes = await readFile(path);
  return adapter.parse(bytes, {
    id: ctx?.id ?? basename(path, extname(path)),
    source: ctx?.source ?? 'file',
    origin: ctx?.origin ?? path,
    ...(ctx?.date !== undefined ? { date: ctx.date } : {}),
    ...(ctx?.title !== undefined ? { title: ctx.title } : {}),
  });
}

export async function loadPuzzle(
  path: string,
  ctx?: Partial<PuzzleAdapterContext>,
): Promise<Puzzle> {
  return stripSolution(await loadPuzzleWithSolution(path, ctx));
}
