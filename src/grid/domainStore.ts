import type { Candidate } from '../candidates/types.js';
import type { DomainStore } from './types.js';

/**
 * T4 (B39): domains with a depth-indexed trail. Forward-check and AC-3
 * reductions are trailed and undone exactly on backtrack; a merged re-ask or
 * escalation result goes into the base domain and survives every `pop()`.
 *
 * Representation. Each slot keeps an ordered `base` array (seeded by
 * `setBase`, extended by `merge`) plus a set of answers currently excluded by
 * trailed reductions. The live domain is the base minus the excluded answers,
 * cached until something invalidates it. Undo therefore never has to restore a
 * saved array: it deletes exclusions, which is what makes a `merge` taken at
 * any depth outlive every later `undoTo` for free.
 *
 * A reduction taken with no frame open (depth 0, i.e. the AC-3 prepass) has
 * nowhere to be recorded and is permanent by construction. The pattern filter
 * is not trailed at all; the search re-applies it at each node.
 */

interface SlotState {
  /** Insertion-ordered, de-duplicated on `answer`. */
  base: Candidate[];
  /** Answers removed by trailed reductions still in force. */
  excluded: Set<string>;
  /** `base` minus `excluded`, frozen; null when it must be recomputed. */
  cache: readonly Candidate[] | null;
  suspect: boolean;
}

/** One trailed reduction: the answers it removed from one slot. */
interface TrailEntry {
  slotId: string;
  answers: string[];
  /** Kept for diagnostics; the trail replays by answer, not by reason. */
  reason: string | undefined;
}

const EMPTY_DOMAIN: readonly Candidate[] = Object.freeze([]);

/**
 * The validation chain's dedupe rule (T6), applied again here so the store is
 * safe whatever a caller hands it: keep the higher-scoring candidate and sum
 * the votes. Neither input object is mutated; the result is a new object.
 */
function combine(existing: Candidate, incoming: Candidate): Candidate {
  const better = incoming.score > existing.score ? incoming : existing;
  return { ...better, votes: existing.votes + incoming.votes };
}

export function createDomainStore(): DomainStore {
  const slots = new Map<string, SlotState>();
  /** One entry per open search depth; `frames.length` is the current depth. */
  const frames: TrailEntry[][] = [];

  function stateOf(slotId: string): SlotState {
    const existing = slots.get(slotId);
    if (existing !== undefined) return existing;
    const created: SlotState = { base: [], excluded: new Set(), cache: null, suspect: false };
    slots.set(slotId, created);
    return created;
  }

  function domainOf(state: SlotState): readonly Candidate[] {
    if (state.cache === null) {
      state.cache = Object.freeze(
        state.excluded.size === 0
          ? state.base.slice()
          : state.base.filter((c) => !state.excluded.has(c.answer)),
      );
    }
    return state.cache;
  }

  /** Adds `candidates` to `state.base` under the dedupe rule, in order. */
  function absorb(state: SlotState, candidates: readonly Candidate[]): void {
    for (const incoming of candidates) {
      const at = state.base.findIndex((c) => c.answer === incoming.answer);
      if (at === -1) {
        state.base.push(incoming);
      } else {
        const existing = state.base[at];
        if (existing !== undefined) state.base[at] = combine(existing, incoming);
      }
    }
    state.cache = null;
  }

  function undoFrame(frame: TrailEntry[]): void {
    for (let i = frame.length - 1; i >= 0; i -= 1) {
      const entry = frame[i];
      if (entry === undefined) continue;
      const state = slots.get(entry.slotId);
      if (state === undefined) continue;
      for (const answer of entry.answers) state.excluded.delete(answer);
      state.cache = null;
    }
  }

  return {
    get(slotId: string): readonly Candidate[] {
      const state = slots.get(slotId);
      return state === undefined ? EMPTY_DOMAIN : domainOf(state);
    },

    sizeOf(slotId: string): number {
      const state = slots.get(slotId);
      return state === undefined ? 0 : domainOf(state).length;
    },

    setBase(slotId: string, candidates: readonly Candidate[]): void {
      const state = stateOf(slotId);
      state.base = [];
      // A replacement base domain carries no reduction history: exclusions
      // recorded against the domain it replaces no longer mean anything.
      // Trail entries naming those answers stay on the trail and become
      // no-ops, since undo only ever deletes exclusions.
      state.excluded.clear();
      state.cache = null;
      absorb(state, candidates);
    },

    merge(slotId: string, candidates: readonly Candidate[]): void {
      const state = stateOf(slotId);
      absorb(state, candidates);
      // Fresh evidence outranks a trailed reduction: a re-ask fires precisely
      // because the domain emptied, so a merged answer has to be usable at the
      // current node, not only after the backtrack that would have restored it.
      for (const c of candidates) state.excluded.delete(c.answer);
    },

    reduce(slotId: string, keep: (c: Candidate) => boolean, reason?: string): number {
      const state = slots.get(slotId);
      if (state === undefined) return 0;

      const removed: string[] = [];
      for (const c of domainOf(state)) {
        if (!keep(c)) removed.push(c.answer);
      }
      if (removed.length === 0) return 0;

      for (const answer of removed) state.excluded.add(answer);
      state.cache = null;

      const frame = frames[frames.length - 1];
      if (frame !== undefined) frame.push({ slotId, answers: removed, reason });
      return removed.length;
    },

    push(): void {
      frames.push([]);
    },

    pop(): void {
      const frame = frames.pop();
      // Popping at depth 0 is a no-op, not an error: backtracking out of the
      // root must not throw.
      if (frame !== undefined) undoFrame(frame);
    },

    undoTo(depth: number): void {
      const target = Math.max(0, Math.floor(depth));
      while (frames.length > target) {
        const frame = frames.pop();
        if (frame !== undefined) undoFrame(frame);
      }
    },

    depth(): number {
      return frames.length;
    },

    isSuspect(slotId: string): boolean {
      return slots.get(slotId)?.suspect ?? false;
    },

    markSuspect(slotId: string): void {
      // Not trailed: an AC-3 wipeout is a fact about the seeded domain, so the
      // mark outlives any backtrack.
      stateOf(slotId).suspect = true;
    },
  };
}
