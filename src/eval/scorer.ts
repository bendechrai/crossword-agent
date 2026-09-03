import type { GridSnapshot } from '../grid/types.js';
import type { Slot } from '../puzzle/types.js';
import type { Accuracy } from './types.js';

export type CellVerdict = 'right' | 'wrong' | 'empty' | 'block';

/**
 * A block cell is any cell where `solution` holds `""` (B11: the solution
 * grid is `height` rows of `width` entries, `""` for a block). The scorer
 * never sees `Puzzle.cells[].block` directly - the solution array is the
 * only ground truth it is handed, per the "takes it as an argument" decision
 * baked into this task, so block-ness is read from it.
 */
function isBlock(truth: string | undefined): boolean {
  return truth === undefined || truth === '';
}

function filledAt(snapshot: GridSnapshot, row: number, col: number): string | null {
  return snapshot.letters[row]?.[col] ?? null;
}

/**
 * T16: letters correct over non-block cells, words correct over slots,
 * `perfect` only when every non-block cell is correct and none is empty.
 *
 * The solution is the only source of block-ness the scorer uses (see
 * `isBlock`): a cell is non-block exactly when `solution[row][col]` is a
 * non-empty string.
 */
export function score(
  snapshot: GridSnapshot,
  solution: string[][],
  slots: ReadonlyArray<Slot>,
): Accuracy {
  let nonBlockCells = 0;
  let correctLetters = 0;
  let emptyCells = 0;

  for (let row = 0; row < solution.length; row += 1) {
    const solutionRow = solution[row];
    if (solutionRow === undefined) continue;
    for (let col = 0; col < solutionRow.length; col += 1) {
      const truth = solutionRow[col];
      if (isBlock(truth)) continue;
      nonBlockCells += 1;
      const filled = filledAt(snapshot, row, col);
      // An empty cell counts as incorrect for `letters`, not as excluded.
      if (filled === null) {
        emptyCells += 1;
      } else if (filled === truth) {
        correctLetters += 1;
      }
    }
  }

  let correctWords = 0;
  for (const slot of slots) {
    // A partially filled slot is incorrect: every one of its cells must be
    // correct (which also implies non-block and non-empty).
    const complete = slot.cells.every(([row, col]) => {
      const solutionRow = solution[row];
      const truth = solutionRow?.[col];
      return !isBlock(truth) && filledAt(snapshot, row, col) === truth;
    });
    if (complete) correctWords += 1;
  }

  return {
    // Zero non-block cells never happens for a real puzzle; guarded the same
    // way as the zero-slots case below rather than dividing by zero.
    letters: nonBlockCells === 0 ? 1 : correctLetters / nonBlockCells,
    // A puzzle with zero slots returns 1: vacuously every (nonexistent) slot
    // is correct. Unreachable in practice - every puzzle has at least one slot.
    words: slots.length === 0 ? 1 : correctWords / slots.length,
    perfect: emptyCells === 0 && correctLetters === nonBlockCells,
    emptyCells,
  };
}

/** The per-cell matrix the renderers print. */
export function diff(snapshot: GridSnapshot, solution: string[][]): CellVerdict[][] {
  return solution.map((solutionRow, row) =>
    solutionRow.map((truth, col) => {
      if (isBlock(truth)) return 'block';
      const filled = filledAt(snapshot, row, col);
      if (filled === null) return 'empty';
      return filled === truth ? 'right' : 'wrong';
    }),
  );
}
