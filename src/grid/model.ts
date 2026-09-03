import { CliError, ExitCode } from '../cli/exit.js';
import type { Puzzle, Slot } from '../puzzle/types.js';
import { regexFromPattern } from './pattern.js';
import type { Crossing, GridSnapshot } from './types.js';

function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

interface AssignRecord {
  slotId: string;
  /** Every cell this specific assign() call wrote, with the value it overwrote. */
  writes: Array<{ row: number; col: number; previous: string | null }>;
}

/**
 * T3: the grid state machine. Holds letters and assignments, and nothing about
 * domains, scores, tiers or the LLM.
 *
 * Cells are [row, col] with row 0 at the top and col 0 at the left, rendered
 * `r{row}c{col}` in errors and event payloads (B18).
 */
export class Grid {
  readonly slots: ReadonlyMap<string, Slot>;

  private readonly width: number;
  private readonly height: number;
  /** `height` rows of `width` entries; null for an unfilled or block cell. */
  private readonly letters: (string | null)[][];
  private readonly blocks: boolean[][];
  /** slotId -> the word currently assigned to it (only slots assign() was called on). */
  private readonly assigned: Map<string, string>;
  /** cell key -> every slotId whose cells include that cell (0, 1 or 2 entries). */
  private readonly cellSlots: Map<string, string[]>;
  /** Every assign() call still in effect, in call order, so unassign() is an exact undo. */
  private readonly trail: AssignRecord[];

  constructor(puzzle: Puzzle) {
    const slots = new Map<string, Slot>();
    for (const slot of puzzle.slots) slots.set(slot.id, slot);
    this.slots = slots;

    this.width = puzzle.width;
    this.height = puzzle.height;
    this.letters = puzzle.cells.map((row) => row.map(() => null));
    this.blocks = puzzle.cells.map((row) => row.map((cell) => cell.block));
    this.assigned = new Map();
    this.trail = [];

    const cellSlots = new Map<string, string[]>();
    for (const slot of puzzle.slots) {
      for (const [row, col] of slot.cells) {
        const key = cellKey(row, col);
        const existing = cellSlots.get(key);
        if (existing === undefined) cellSlots.set(key, [slot.id]);
        else existing.push(slot.id);
      }
    }
    this.cellSlots = cellSlots;
  }

  private requireSlot(slotId: string): Slot {
    const slot = this.slots.get(slotId);
    if (slot === undefined) {
      throw new CliError(ExitCode.UNEXPECTED, `unknown slot "${slotId}"`);
    }
    return slot;
  }

  private requireRow(row: number): (string | null)[] {
    const rowArr = this.letters[row];
    if (rowArr === undefined) {
      throw new CliError(ExitCode.UNEXPECTED, `row ${row} is outside the grid`);
    }
    return rowArr;
  }

  /** Throws when a letter conflicts with one already fixed by a crossing. */
  assign(slotId: string, answer: string): void {
    const slot = this.requireSlot(slotId);
    const letters = [...answer.toUpperCase()];
    if (letters.length !== slot.length) {
      throw new CliError(
        ExitCode.UNEXPECTED,
        `cannot assign "${answer}" to ${slotId}: expected length ${slot.length}, got ${letters.length}`,
      );
    }

    // Validate every cell before writing any of them, so a conflict leaves
    // the grid byte-identical to before this call.
    slot.cells.forEach(([row, col], i) => {
      const current = this.requireRow(row)[col] ?? null;
      const next = letters[i] ?? '';
      if (current !== null && current !== next) {
        throw new CliError(
          ExitCode.UNEXPECTED,
          `cannot assign "${letters.join('')}" to ${slotId}: r${row}c${col} is already "${current}"`,
        );
      }
    });

    const writes: AssignRecord['writes'] = [];
    slot.cells.forEach(([row, col], i) => {
      const rowArr = this.requireRow(row);
      const previous = rowArr[col] ?? null;
      writes.push({ row, col, previous });
      rowArr[col] = letters[i] ?? '';
    });

    this.trail.push({ slotId, writes });
    this.assigned.set(slotId, letters.join(''));
  }

  /** Trail-based, exact undo: letters fixed by a crossing assignment survive. */
  unassign(slotId: string): void {
    const slot = this.requireSlot(slotId);
    const index = this.trail.findLastIndex((record) => record.slotId === slotId);
    if (index === -1) {
      throw new CliError(ExitCode.UNEXPECTED, `cannot unassign ${slotId}: it is not assigned`);
    }
    const [record] = this.trail.splice(index, 1);
    if (record === undefined) {
      throw new CliError(ExitCode.UNEXPECTED, `cannot unassign ${slotId}: it is not assigned`);
    }

    for (const { row, col, previous } of record.writes) {
      this.requireRow(row)[col] = previous;
    }

    // A slot assigned more than once (without an intervening unassign) keeps
    // whatever earlier assign() call is still on the trail.
    if (this.trail.some((r) => r.slotId === slotId)) {
      const word = slot.cells.map(([row, col]) => this.requireRow(row)[col] ?? '?').join('');
      this.assigned.set(slotId, word);
    } else {
      this.assigned.delete(slotId);
    }
  }

  /** For example "A?I?N"; `?` means unknown. */
  patternFor(slotId: string): string {
    const slot = this.requireSlot(slotId);
    return slot.cells.map(([row, col]) => this.requireRow(row)[col] ?? '?').join('');
  }

  /** For example `/^A[A-Z]I[A-Z]N$/`; delegates to `grid/pattern.ts`. */
  regexFor(slotId: string): RegExp {
    return regexFromPattern(this.patternFor(slotId));
  }

  /** 0..n records; an unchecked cell contributes no crossing (B7). */
  crossings(slotId: string): Crossing[] {
    const slot = this.requireSlot(slotId);
    const result: Crossing[] = [];
    slot.cells.forEach(([row, col], offsetInThis) => {
      const ids = this.cellSlots.get(cellKey(row, col)) ?? [];
      for (const otherSlotId of ids) {
        if (otherSlotId === slotId) continue;
        const other = this.slots.get(otherSlotId);
        if (other === undefined) continue;
        const offsetInOther = other.cells.findIndex(([r, c]) => r === row && c === col);
        if (offsetInOther === -1) continue;
        result.push({ otherSlotId, offsetInThis, offsetInOther });
      }
    });
    return result;
  }

  /** False for a cell that belongs to only one slot. */
  isChecked(row: number, col: number): boolean {
    const ids = this.cellSlots.get(cellKey(row, col));
    return ids !== undefined && ids.length > 1;
  }

  letterAt(row: number, col: number): string | null {
    return this.letters[row]?.[col] ?? null;
  }

  assignmentOf(slotId: string): string | undefined {
    this.requireSlot(slotId);
    return this.assigned.get(slotId);
  }

  isComplete(): boolean {
    for (let row = 0; row < this.height; row += 1) {
      for (let col = 0; col < this.width; col += 1) {
        if (this.blocks[row]?.[col] === true) continue;
        if ((this.letters[row]?.[col] ?? null) === null) return false;
      }
    }
    return true;
  }

  snapshot(): GridSnapshot {
    return {
      letters: this.letters.map((row) => row.slice()),
      assigned: Object.fromEntries(this.assigned),
    };
  }
}
