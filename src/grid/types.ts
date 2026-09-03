import type { Candidate } from '../candidates/types.js';

/**
 * A crossing between two slots, seen from the perspective of one of them
 * (B18: the other slot is `otherSlotId`).
 */
export interface Crossing {
  otherSlotId: string;
  /** Index into this slot's cells of the shared cell. */
  offsetInThis: number;
  /** Index into the other slot's cells of the same shared cell. */
  offsetInOther: number;
}

export interface GridSnapshot {
  /** `height` rows of `width` entries; null for an unfilled or block cell. */
  letters: (string | null)[][];
  /** slotId -> answer, for every currently assigned slot. */
  assigned: Record<string, string>;
}

/**
 * Domains live outside the Grid, with their own depth-indexed trail (B39).
 *
 * The grid holds letters, the store holds beliefs, and they have different
 * undo semantics: a trailed AC-3 or forward-check reduction must vanish on
 * backtrack, while a merged re-ask result must not.
 */
export interface DomainStore {
  get(slotId: string): readonly Candidate[];
  sizeOf(slotId: string): number;
  /** Seed result: replaces the base domain. */
  setBase(slotId: string, candidates: readonly Candidate[]): void;
  /**
   * Re-ask or escalation result: joins the base domain and therefore survives
   * every subsequent backtrack.
   */
  merge(slotId: string, candidates: readonly Candidate[]): void;
  /** Trailed reduction; returns the number of candidates removed. */
  reduce(slotId: string, keep: (c: Candidate) => boolean, reason?: string): number;
  /** Open a trail frame for the next search depth. */
  push(): void;
  /** Undo every trailed reduction back to the previous frame. */
  pop(): void;
  /** Pop frames until `depth()` equals `depth`. */
  undoTo(depth: number): void;
  depth(): number;
  isSuspect(slotId: string): boolean;
  markSuspect(slotId: string): void;
}
