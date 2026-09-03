import { notImplemented } from '../util/errors.js';
import type { Candidate } from '../candidates/types.js';
import type { DomainStore } from '../grid/types.js';
import type { Grid } from '../grid/model.js';
import type { Slot } from '../puzzle/types.js';

export interface OrderingOptions {
  ordering: 'margin' | 'mrv';
  /** Seeded PRNG, for the final tie-break. */
  rng: () => number;
}

/**
 * T20. `margin` (default) maximises `bestScore - secondBestScore`, ties broken
 * by fewest surviving candidates, then most unassigned crossings, then a
 * seeded draw. `mrv` swaps the primary key for domain size, for ablation.
 */
export function chooseSlot(
  _unassigned: ReadonlyArray<Slot>,
  _domains: DomainStore,
  _grid: Grid,
  _opts: OrderingOptions,
): Slot | undefined {
  return notImplemented('src/solver/ordering.ts');
}

/** A single-candidate domain has margin `bestScore`; an empty one `-Infinity`. */
export function marginOf(_domain: ReadonlyArray<Candidate>): number {
  return notImplemented('src/solver/ordering.ts');
}

/** Descending score, with a stable tie-break on rank. */
export function orderValues(_domain: ReadonlyArray<Candidate>): Candidate[] {
  return notImplemented('src/solver/ordering.ts');
}
