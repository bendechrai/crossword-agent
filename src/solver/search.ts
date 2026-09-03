import type { Candidate } from '../candidates/types.js';
import type { Emit } from '../events/types.js';
import type { Grid } from '../grid/model.js';
import type { DomainStore } from '../grid/types.js';
import type { Slot } from '../puzzle/types.js';
import { chooseSlot, marginOf, orderValues } from './ordering.js';
import type { SearchHooks, SearchOptions, SearchResult } from './types.js';

/**
 * T37: depth-first assignment with forward checking over the trailed
 * DomainStore, margin ordering and LDS restarts. It calls `hooks` at the
 * declared points and never touches the candidate service directly.
 *
 * Shape of the loop. The search is iterative rather than recursive, so a 15x15
 * puzzle cannot blow the stack: an explicit `Frame[]` holds one entry per
 * assigned slot and a single `Pending` node holds the slot currently being
 * tried. Because the backtrack target is the lowest-margin crossing
 * assignment rather than the chronologically last one (B7), backtracking is a
 * backjump: it unwinds every frame above the target, then resumes the target
 * at its next value. Chronological backtracking is the special case where the
 * target happens to be the top frame.
 *
 * Undo has two halves, which is exactly why B39 splits the two stores. The
 * grid is undone by `unassign` per frame (safe in any order), and the trailed
 * forward-check reductions are undone by one `undoTo` back to the target's
 * depth. A re-ask merged by `hooks.onEmptyDomain` goes into the base domain
 * and therefore survives both.
 */

/** B37: at most one `progress` between phase transitions per this many ms. */
const PROGRESS_INTERVAL_MS = 250;

/**
 * `SearchOptions` (T0) plus the injected clock the coalescing rule needs.
 * `now` is optional and defaults to `Date.now`, so this stays assignable to
 * the `SearchFn` contract `SolveDeps.search` is typed against.
 */
export interface SearchCoreOptions extends SearchOptions {
  /** Injected so a test can drive the 250 ms rule without waiting (B37). */
  now?: () => number;
}

/** One assigned slot, and everything needed to undo or resume it. */
interface Frame {
  slot: Slot;
  /** Ordered, pattern-filtered values as of the moment this node was opened. */
  values: Candidate[];
  /** Index into `values` of the value currently assigned. */
  index: number;
  /** `marginOf(values)` at the moment of the choice; the backtrack key (B7). */
  margin: number;
  /** Discrepancies used from the root down to and including this choice. */
  discrepancies: number;
  /** `domains.depth()` before this frame's `push()`; the undo target. */
  depthBefore: number;
}

/** The node being tried: chosen but not yet assigned, or resumed after a backjump. */
interface Pending {
  slot: Slot;
  values: Candidate[];
  nextIndex: number;
  /** Discrepancies used by the ancestors of this node. */
  parentDiscrepancies: number;
}

type PassOutcome = 'complete' | 'exhausted' | 'budget';

/** Whichever tier produced the candidate; the word list never gets here (B32). */
function producedByOf(candidate: Candidate): string {
  return `tier${candidate.tier}`;
}

export async function search(
  grid: Grid,
  domains: DomainStore,
  hooks: SearchHooks,
  emit: Emit,
  opts: SearchCoreOptions,
): Promise<SearchResult> {
  const clock = opts.now ?? Date.now;
  const startedAt = clock();
  const slots = [...grid.slots.values()];
  const total = slots.length;
  const baseDepth = domains.depth();
  const orderingOpts = { ordering: opts.ordering, rng: opts.rng };

  const stack: Frame[] = [];
  let pending: Pending | null = null;

  let backtracks = 0;
  let discrepancies = 0;
  let passDiscrepancies = 0;
  let wipeouts = 0;
  let ldsRestarts = 0;
  let budgetExceeded = false;
  let lastProgressAt = startedAt;
  let bestCount = 0;
  /** The deepest consistent fill seen in any pass, with what to re-emit for it. */
  let bestFill = new Map<string, { value: Candidate; margin: number }>();

  function countAssigned(): number {
    let count = 0;
    for (const slot of slots) {
      if (grid.assignmentOf(slot.id) !== undefined) count += 1;
    }
    return count;
  }

  function emitProgress(at: number, force: boolean): void {
    if (!force && at - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = at;
    emit({
      type: 'progress',
      phase: 'search',
      assigned: countAssigned(),
      total,
      elapsedMs: at - startedAt,
      // The search spends no money; T44 owns the run's cost accounting.
      usd: 0,
    });
  }

  /**
   * The slot's live domain in calibrated score order, re-filtered by the
   * current pattern. B39 keeps the pattern filter out of the trail, so it is
   * re-applied at every node rather than undone.
   */
  function valuesFor(slot: Slot): Candidate[] {
    const regex = grid.regexFor(slot.id);
    return orderValues(domains.get(slot.id)).filter((c) => regex.test(c.answer));
  }

  function recordBest(): void {
    if (stack.length <= bestCount) return;
    const fill = new Map<string, { value: Candidate; margin: number }>();
    for (const frame of stack) {
      const value = frame.values[frame.index];
      if (value === undefined) return;
      fill.set(frame.slot.id, { value, margin: frame.margin });
    }
    bestCount = stack.length;
    bestFill = fill;
  }

  function assignValue(slotId: string, value: Candidate, margin: number): void {
    grid.assign(slotId, value.answer);
    emit({
      type: 'search:assign',
      slotId,
      answer: value.answer,
      score: value.score,
      margin,
      tier: value.tier,
      producedBy: producedByOf(value),
    });
  }

  /**
   * Step 5's seam. The hooks may merge a re-ask or escalation result into the
   * base domain, which the store makes live at the current node; the pattern
   * filter is then re-applied, since nothing guarantees a merged answer fits
   * the letters already on the board. True means the slot is worth retrying.
   */
  async function tryRefill(slotId: string, depth: number): Promise<boolean> {
    const decision = await hooks.onEmptyDomain(slotId, {
      pattern: grid.patternFor(slotId),
      depth,
    });
    if (decision.action === 'give-up') return false;
    const regex = grid.regexFor(slotId);
    domains.reduce(slotId, (c) => regex.test(c.answer), 'pattern');
    return domains.sizeOf(slotId) > 0;
  }

  /**
   * Forward-checks every unassigned crossing of the slot just assigned,
   * intersecting each domain with its new pattern as a trailed reduction at
   * the current depth. Returns the slots whose domains emptied.
   */
  function forwardCheck(slotId: string): string[] {
    const emptied: string[] = [];
    for (const crossing of grid.crossings(slotId)) {
      const otherId = crossing.otherSlotId;
      if (grid.assignmentOf(otherId) !== undefined) continue;
      const before = domains.sizeOf(otherId);
      const regex = grid.regexFor(otherId);
      domains.reduce(otherId, (c) => regex.test(c.answer), 'forwardcheck');
      const after = domains.sizeOf(otherId);
      emit({ type: 'search:forwardcheck', slotId, crossingSlotId: otherId, before, after });
      if (after === 0) emptied.push(otherId);
    }
    return emptied;
  }

  /**
   * B7's backtrack target: the lowest-margin assignment among the slots
   * crossing the failed slot, falling back to the lowest-margin assignment
   * anywhere when the failed slot has no crossings (or none of them is
   * assigned yet). Exact margin ties are broken by the injected seeded PRNG
   * (B38), never by `Math.random`.
   *
   * Returns false when nothing is assigned, which is what ends a pass.
   */
  function backtrack(failedSlotId: string, reason: string): boolean {
    if (stack.length === 0) return false;

    const crossingIds = new Set(grid.crossings(failedSlotId).map((c) => c.otherSlotId));
    let indices: number[] = [];
    for (let i = 0; i < stack.length; i += 1) {
      const frame = stack[i];
      if (frame !== undefined && crossingIds.has(frame.slot.id)) indices.push(i);
    }
    if (indices.length === 0) indices = stack.map((_frame, i) => i);

    let lowest = Infinity;
    for (const i of indices) lowest = Math.min(lowest, stack[i]?.margin ?? Infinity);
    const tied = indices.filter((i) => stack[i]?.margin === lowest);
    const pick =
      tied.length === 1 ? 0 : Math.min(tied.length - 1, Math.floor(opts.rng() * tied.length));
    const targetIndex = tied[pick] ?? tied[0] ?? stack.length - 1;
    const target = stack[targetIndex];
    if (target === undefined) return false;

    emit({
      type: 'search:backtrack',
      slotId: target.slot.id,
      margin: target.margin,
      reason,
    });
    backtracks += 1;
    const charge = hooks.chargeBudget('backtracks', 1);
    if (charge.exceeded !== null) budgetExceeded = true;

    for (let i = stack.length - 1; i >= targetIndex; i -= 1) {
      const frame = stack[i];
      if (frame === undefined) continue;
      grid.unassign(frame.slot.id);
      emit({
        type: 'search:unassign',
        slotId: frame.slot.id,
        answer: frame.values[frame.index]?.answer ?? '',
      });
    }
    domains.undoTo(target.depthBefore);
    stack.length = targetIndex;

    pending = {
      slot: target.slot,
      values: target.values,
      nextIndex: target.index + 1,
      parentDiscrepancies: target.discrepancies - (target.index > 0 ? 1 : 0),
    };
    return true;
  }

  function unwindAll(): void {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const frame = stack[i];
      if (frame === undefined) continue;
      grid.unassign(frame.slot.id);
      emit({
        type: 'search:unassign',
        slotId: frame.slot.id,
        answer: frame.values[frame.index]?.answer ?? '',
      });
    }
    stack.length = 0;
    pending = null;
    domains.undoTo(baseDepth);
  }

  async function runPass(ldsLimit: number): Promise<PassOutcome> {
    for (;;) {
      emitProgress(clock(), false);
      if (budgetExceeded || backtracks >= opts.maxBacktracks) return 'budget';

      if (pending === null) {
        const unassigned = slots.filter((slot) => grid.assignmentOf(slot.id) === undefined);
        if (unassigned.length === 0) return 'complete';
        // T20 needs a non-empty list and a real Grid; completeness is checked
        // above, so `undefined` here can only mean "nothing to branch on".
        const slot = chooseSlot(unassigned, domains, grid, orderingOpts);
        if (slot === undefined) return 'complete';

        const values = valuesFor(slot);
        if (values.length === 0) {
          wipeouts += 1;
          emit({ type: 'search:wipeout', slotId: slot.id });
          if (await tryRefill(slot.id, domains.depth())) continue;
          if (!backtrack(slot.id, 'empty-domain')) return 'exhausted';
          continue;
        }
        pending = {
          slot,
          values,
          nextIndex: 0,
          parentDiscrepancies: stack[stack.length - 1]?.discrepancies ?? 0,
        };
      }

      const node: Pending = pending;
      const value = node.values[node.nextIndex];
      // Every remaining value costs at least as much as this one, so an
      // over-limit node is abandoned outright rather than scanned further.
      const cost = node.nextIndex > 0 ? 1 : 0;
      const overLimit = node.parentDiscrepancies + cost > ldsLimit;
      if (value === undefined || overLimit) {
        pending = null;
        if (!backtrack(node.slot.id, value === undefined ? 'values-exhausted' : 'lds-limit')) {
          return 'exhausted';
        }
        continue;
      }

      const margin = marginOf(node.values);
      const depthBefore = domains.depth();
      domains.push();
      assignValue(node.slot.id, value, margin);
      stack.push({
        slot: node.slot,
        values: node.values,
        index: node.nextIndex,
        margin,
        discrepancies: node.parentDiscrepancies + cost,
        depthBefore,
      });
      if (cost > 0) {
        discrepancies += 1;
        passDiscrepancies += 1;
      }
      pending = null;
      recordBest();

      const emptied = forwardCheck(node.slot.id);
      let failed: string | null = null;
      for (const emptiedId of emptied) {
        wipeouts += 1;
        emit({ type: 'search:wipeout', slotId: emptiedId });
        if (failed !== null) continue;
        if (!(await tryRefill(emptiedId, domains.depth()))) failed = emptiedId;
      }
      if (failed !== null && !backtrack(failed, 'wipeout')) return 'exhausted';
    }
  }

  emitProgress(startedAt, true);

  let ldsLimit = opts.ldsLimitStart;
  let complete = false;
  for (;;) {
    passDiscrepancies = 0;
    const outcome = await runPass(ldsLimit);
    if (outcome === 'complete') {
      complete = true;
      break;
    }
    if (outcome === 'budget' || ldsLimit >= opts.ldsLimitMax) break;
    unwindAll();
    ldsLimit += 1;
    ldsRestarts += 1;
    emit({ type: 'lds:restart', ldsLimit, discrepanciesUsed: passDiscrepancies });
  }

  // Hitting a cap or exhausting the LDS ladder ends the search gracefully with
  // the best partial fill it ever held, never by throwing. The restored
  // assignments are re-emitted so a renderer replaying the stream ends on the
  // same grid the caller is handed.
  if (!complete && stack.length < bestCount) {
    unwindAll();
    for (const [slotId, { value, margin }] of bestFill) assignValue(slotId, value, margin);
  } else {
    domains.undoTo(baseDepth);
  }

  const emptySlotIds = slots
    .filter((slot) => grid.assignmentOf(slot.id) === undefined)
    .map((slot) => slot.id);
  await hooks.onSearchTermination(emptySlotIds);

  emitProgress(clock(), true);

  return {
    complete,
    assigned: total - emptySlotIds.length,
    backtracks,
    discrepancies,
    wipeouts,
    ldsRestarts,
    emptySlotIds,
  };
}
