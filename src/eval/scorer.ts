import { notImplemented } from '../util/errors.js';
import type { GridSnapshot } from '../grid/types.js';
import type { Slot } from '../puzzle/types.js';
import type { Accuracy } from './types.js';

export type CellVerdict = 'right' | 'wrong' | 'empty' | 'block';

/**
 * T16: letters correct over non-block cells, words correct over slots,
 * `perfect` only when every non-block cell is correct and none is empty.
 */
export function score(
  _snapshot: GridSnapshot,
  _solution: string[][],
  _slots: ReadonlyArray<Slot>,
): Accuracy {
  return notImplemented('src/eval/scorer.ts');
}

/** The per-cell matrix the renderers print. */
export function diff(_snapshot: GridSnapshot, _solution: string[][]): CellVerdict[][] {
  return notImplemented('src/eval/scorer.ts');
}
