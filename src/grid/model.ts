import { notImplemented } from '../util/errors.js';
import type { Puzzle, Slot } from '../puzzle/types.js';
import type { Crossing, GridSnapshot } from './types.js';

/**
 * T3: the grid state machine. Holds letters and assignments, and nothing about
 * domains, scores, tiers or the LLM.
 *
 * Cells are [row, col] with row 0 at the top and col 0 at the left, rendered
 * `r{row}c{col}` in errors and event payloads (B18).
 */
export class Grid {
  readonly slots: ReadonlyMap<string, Slot>;

  constructor(_puzzle: Puzzle) {
    this.slots = notImplemented('src/grid/model.ts');
  }

  /** Throws when a letter conflicts with one already fixed by a crossing. */
  assign(_slotId: string, _answer: string): void {
    return notImplemented('src/grid/model.ts');
  }

  /** Trail-based, exact undo: letters fixed by a crossing assignment survive. */
  unassign(_slotId: string): void {
    return notImplemented('src/grid/model.ts');
  }

  /** For example "A?I?N"; `?` means unknown. */
  patternFor(_slotId: string): string {
    return notImplemented('src/grid/model.ts');
  }

  /** For example `/^A[A-Z]I[A-Z]N$/`; delegates to `grid/pattern.ts`. */
  regexFor(_slotId: string): RegExp {
    return notImplemented('src/grid/model.ts');
  }

  /** 0..n records; an unchecked cell contributes no crossing (B7). */
  crossings(_slotId: string): Crossing[] {
    return notImplemented('src/grid/model.ts');
  }

  /** False for a cell that belongs to only one slot. */
  isChecked(_row: number, _col: number): boolean {
    return notImplemented('src/grid/model.ts');
  }

  letterAt(_row: number, _col: number): string | null {
    return notImplemented('src/grid/model.ts');
  }

  assignmentOf(_slotId: string): string | undefined {
    return notImplemented('src/grid/model.ts');
  }

  isComplete(): boolean {
    return notImplemented('src/grid/model.ts');
  }

  snapshot(): GridSnapshot {
    return notImplemented('src/grid/model.ts');
  }
}
