import type { Candidate } from '../candidates/types.js';
import type { DomainStore } from '../grid/types.js';
import type { Grid } from '../grid/model.js';
import type { Slot } from '../puzzle/types.js';

export interface OrderingOptions {
  ordering: 'margin' | 'mrv';
  /** Seeded PRNG, for the final tie-break. */
  rng: () => number;
}

interface SlotKey {
  margin: number;
  size: number;
  /** Crossing slots not yet assigned in `grid`. */
  unassignedCrossings: number;
}

/**
 * Orders two keys best-first for the given primary strategy. Negative means
 * `a` ranks ahead of `b`.
 *
 * `margin`: bestScore - secondBestScore desc, then domain size asc (fewest
 * survivors), then unassigned crossings desc (most constraining), then a
 * PRNG draw among the fully-tied group (handled by the caller).
 *
 * `mrv` swaps the primary key for domain size, ablation-only (spec's
 * "Solver pipeline" step 4). The rest of the cascade is unchanged, so what
 * was the primary key under `margin` becomes the next differentiator.
 */
function compareKeys(a: SlotKey, b: SlotKey, ordering: 'margin' | 'mrv'): number {
  if (ordering === 'mrv') {
    if (a.size !== b.size) return a.size - b.size;
    if (a.margin !== b.margin) return b.margin - a.margin;
  } else {
    if (a.margin !== b.margin) return b.margin - a.margin;
    if (a.size !== b.size) return a.size - b.size;
  }
  if (a.unassignedCrossings !== b.unassignedCrossings) return b.unassignedCrossings - a.unassignedCrossings;
  return 0;
}

function unassignedCrossingsOf(grid: Grid, slotId: string): number {
  let count = 0;
  for (const crossing of grid.crossings(slotId)) {
    if (grid.assignmentOf(crossing.otherSlotId) === undefined) count += 1;
  }
  return count;
}

/**
 * T20. `margin` (default) maximises `bestScore - secondBestScore`, ties broken
 * by fewest surviving candidates, then most unassigned crossings, then a
 * seeded draw. `mrv` swaps the primary key for domain size, for ablation.
 *
 * Pure: no events, no re-asks, no escalation. `undefined` only when
 * `unassigned` is empty (the search loop is expected to have stopped before
 * calling this).
 */
export function chooseSlot(
  unassigned: ReadonlyArray<Slot>,
  domains: DomainStore,
  grid: Grid,
  opts: OrderingOptions,
): Slot | undefined {
  if (unassigned.length === 0) return undefined;

  const keyed = unassigned.map((slot) => {
    const domain = domains.get(slot.id);
    const key: SlotKey = {
      margin: marginOf(domain),
      size: domain.length,
      unassignedCrossings: unassignedCrossingsOf(grid, slot.id),
    };
    return { slot, key };
  });

  const first = keyed[0];
  if (first === undefined) return undefined;

  let best = first.key;
  for (const { key } of keyed) {
    if (compareKeys(key, best, opts.ordering) < 0) best = key;
  }

  const tied = keyed.filter(({ key }) => compareKeys(key, best, opts.ordering) === 0);
  // The PRNG is consumed only when a genuine tie survives every other key,
  // so a run's call count to `rng` stays proportional to actual ambiguity.
  const idx = tied.length === 1 ? 0 : Math.min(tied.length - 1, Math.floor(opts.rng() * tied.length));
  return tied[idx]?.slot;
}

/**
 * A single-candidate domain has margin `bestScore` (there is no second
 * candidate to subtract); an empty domain has margin `-Infinity` so it is
 * always branched on last by `margin` ordering and its emptiness surfaces
 * immediately in search.
 */
export function marginOf(domain: ReadonlyArray<Candidate>): number {
  if (domain.length === 0) return -Infinity;
  if (domain.length === 1) return domain[0]?.score ?? -Infinity;

  let best = -Infinity;
  let second = -Infinity;
  for (const candidate of domain) {
    if (candidate.score >= best) {
      second = best;
      best = candidate.score;
    } else if (candidate.score > second) {
      second = candidate.score;
    }
  }
  return best - second;
}

/** Descending score, with a stable tie-break on rank. */
export function orderValues(domain: ReadonlyArray<Candidate>): Candidate[] {
  return [...domain].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.rank - b.rank;
  });
}
