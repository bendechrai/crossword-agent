import type { CandidateRequest, CandidateService } from '../candidates/types.js';
import type { Emit } from '../events/types.js';
import type { Grid } from '../grid/model.js';
import { patternMatches } from '../grid/pattern.js';
import type { BudgetCap } from '../policy/types.js';
import type { PuzzleStyle, Slot } from '../puzzle/types.js';
import { log } from '../util/log.js';
import type { WordList } from '../validate/types.js';
import type { RepairOptions, RepairResult } from './types.js';

/**
 * T42: the repair pass (spec "Solver pipeline" step 7, the BCS local search).
 *
 * From the possibly partial fill the search left behind, enumerate 1-2 letter
 * edits, gate each proposal on B7's plausibility rule, score the survivors by
 * re-asking tier 1 with the new pattern (`purpose: 'repair'`), and accept
 * improving edits until none remain or `repair.maxCalls` is spent. Still-empty
 * slots are then filled with the best word-list entry matching their pattern.
 *
 * Nothing here trusts the domain store: the search leaves it at the depth it
 * was handed, so its trailed forward-check reductions are gone, and the best
 * partial fill it restored can contain an assignment that emptied a crossing
 * domain. Every pattern and every letter this module reasons about is
 * re-derived from the `Grid` it is given, and every piece of candidate
 * evidence comes from `CandidateService.peek` (B43), the run's ledger of every
 * candidate ever returned for a slot.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * How many word-list neighbours are pulled per masked pattern when enumerating
 * distance-2 proposals. Distance-2 proposals are the one place where the full
 * cross-product of the alphabet is quadratic (625 letter pairs per offset pair
 * per slot), so the word-list arm of that enumeration goes through
 * `WordList.match`, which is indexed by length, instead.
 */
const WORDLIST_MATCH_LIMIT = 50;

/** What the caller can inject beyond the frozen `RepairOptions` (T0). */
export interface RepairPassOptions extends RepairOptions {
  /**
   * The run's budget, charged one `repairCalls` unit per scoring call. The
   * frozen `RepairFn` signature carries no `SearchHooks`, so T44 passes
   * `hooks.chargeBudget` through here. A reported cap ends this phase - the
   * repair loop owns `repairCalls`, exactly as the search loop owns
   * `backtracks` (T38's note: the hooks report the cap, the phase ends itself).
   */
  chargeBudget?: (cap: BudgetCap, amount: number) => { exceeded: BudgetCap | null };
  /** Every `CandidateRequest` carries it and `Grid` deliberately does not. */
  style?: PuzzleStyle;
  /** The puzzle title, prompt-only context (T31). */
  title?: string;
  /** `CandidateRequest.n`; the profile's `candidatesPerAsk`. */
  candidatesPerAsk?: number;
  /** `CandidateRequest.samples`; the profile's `samples`. */
  samples?: number;
  /** `CandidateRequest.sampleIndex`; the run's repeat index. */
  sampleIndex?: number;
}

/** A single letter change, located both in the grid and in the anchor slot. */
interface CellEdit {
  row: number;
  col: number;
  /** Index of the cell within the anchor slot. */
  offset: number;
  letter: string;
}

/**
 * One proposal: a replacement word for the anchor slot, at Hamming distance 1
 * or 2 from what the grid currently holds there. Every changed cell lies in
 * the anchor, which is what makes B7's "some candidate returned for any
 * crossing slot" well defined - the crossings are the anchor's.
 */
interface Proposal {
  anchorId: string;
  before: string;
  after: string;
  edits: CellEdit[];
}

/** A slot whose word a proposal changes, and what it changes it to. */
interface AffectedSlot {
  slotId: string;
  before: string;
  after: string;
  editDistance: number;
}

type GateName = 'peek' | 'wordlist' | 'none';

function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

function hammingDistance(a: string, b: string): number {
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) distance += 1;
  }
  return distance;
}

function substitute(word: string, offset: number, letter: string): string {
  return `${word.slice(0, offset)}${letter}${word.slice(offset + 1)}`;
}

/**
 * The repair pass. Assignable to the frozen `RepairFn`: every option beyond
 * `RepairOptions` is optional, so a caller holding only the contract type can
 * still call it.
 */
export async function repair(
  grid: Grid,
  service: CandidateService,
  wordList: WordList,
  emit: Emit,
  opts: RepairPassOptions,
): Promise<RepairResult> {
  if (!opts.enabled) return { proposals: 0, accepted: 0, callsUsed: 0 };

  const slots: Slot[] = [...grid.slots.values()];
  const style: PuzzleStyle = opts.style ?? 'unknown';
  const maxDistance = opts.maxEditDistance;

  // ---------------------------------------------------------------------
  // Static indexes. The grid's shape never changes, only its letters.
  // ---------------------------------------------------------------------

  /** cell -> every slot covering it, in `grid.slots` order (across then down). */
  const slotsAtCell = new Map<string, string[]>();
  /** slotId -> cell -> that cell's offset within the slot. */
  const offsetInSlot = new Map<string, Map<string, number>>();
  for (const slot of slots) {
    const offsets = new Map<string, number>();
    slot.cells.forEach(([row, col], offset) => {
      const key = cellKey(row, col);
      offsets.set(key, offset);
      const covering = slotsAtCell.get(key);
      if (covering === undefined) slotsAtCell.set(key, [slot.id]);
      else covering.push(slot.id);
    });
    offsetInSlot.set(slot.id, offsets);
  }

  /** Every cell that belongs to a slot, in row-major order (the proposal order). */
  const cellsRowMajor: Array<{ row: number; col: number }> = [...slotsAtCell.keys()]
    .map((key) => {
      const [row = 0, col = 0] = key.split(',').map(Number);
      return { row, col };
    })
    .sort((a, b) => (a.row === b.row ? a.col - b.col : a.row - b.row));

  /** slotId -> offset -> the crossings of that slot at that offset (0..n, B7). */
  const crossingsByOffset = new Map<string, Map<number, Array<{ otherSlotId: string; offsetInOther: number }>>>();
  for (const slot of slots) {
    const byOffset = new Map<number, Array<{ otherSlotId: string; offsetInOther: number }>>();
    for (const crossing of grid.crossings(slot.id)) {
      const list = byOffset.get(crossing.offsetInThis);
      const entry = { otherSlotId: crossing.otherSlotId, offsetInOther: crossing.offsetInOther };
      if (list === undefined) byOffset.set(crossing.offsetInThis, [entry]);
      else list.push(entry);
    }
    crossingsByOffset.set(slot.id, byOffset);
  }

  function slotOf(slotId: string): Slot {
    const slot = grid.slots.get(slotId);
    if (slot === undefined) throw new Error(`repair: unknown slot "${slotId}"`);
    return slot;
  }

  // ---------------------------------------------------------------------
  // Word list (B35). The null object disables the word-list arm of the gate
  // and leaves empty slots blank; either way the run says so exactly once.
  // ---------------------------------------------------------------------

  let warnedNoWordList = false;
  function wordListAvailable(): boolean {
    if (wordList.loaded) return true;
    if (!warnedNoWordList) {
      warnedNoWordList = true;
      log.warn(
        'repair: no word list loaded - the word-list arm of the plausibility gate is disabled and empty slots stay blank',
      );
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // Scores. A slot's current score is the best score the ledger holds for the
  // word it currently carries; an accepted proposal replaces it with what the
  // repair ask (for the anchor) or the ledger (for a crossing) says.
  // ---------------------------------------------------------------------

  function bestLedgerScore(slotId: string, answer: string): number {
    let best = 0;
    for (const candidate of service.peek(slotId)) {
      if (candidate.answer === answer && candidate.score > best) best = candidate.score;
    }
    return best;
  }

  const scoreOfSlot = new Map<string, number>();
  function currentScore(slotId: string): number {
    const cached = scoreOfSlot.get(slotId);
    if (cached !== undefined) return cached;
    const answer = grid.assignmentOf(slotId);
    const score = answer === undefined ? 0 : bestLedgerScore(slotId, answer);
    scoreOfSlot.set(slotId, score);
    return score;
  }

  // ---------------------------------------------------------------------
  // Counters
  // ---------------------------------------------------------------------

  let proposalCount = 0;
  let acceptedCount = 0;
  let callsUsed = 0;

  // ---------------------------------------------------------------------
  // The gate (B7). A changed letter is plausible when it appears at the
  // shared cell's offset in some candidate ever returned for a CROSSING slot;
  // with no crossings there is no such evidence and the word-list arm is the
  // only one available.
  // ---------------------------------------------------------------------

  /** Per-round memo: `peek` grows as the pass makes its own repair asks. */
  let plausibleCache = new Map<string, Set<string>>();

  function plausibleLetters(anchorId: string, offset: number): Set<string> {
    const key = `${anchorId}:${offset}`;
    const cached = plausibleCache.get(key);
    if (cached !== undefined) return cached;
    const letters = new Set<string>();
    for (const crossing of crossingsByOffset.get(anchorId)?.get(offset) ?? []) {
      for (const candidate of service.peek(crossing.otherSlotId)) {
        const letter = candidate.answer[crossing.offsetInOther];
        if (letter !== undefined) letters.add(letter);
      }
    }
    plausibleCache.set(key, letters);
    return letters;
  }

  function gateOf(proposal: Proposal): GateName {
    const everyLetterPlausible = proposal.edits.every((edit) =>
      plausibleLetters(proposal.anchorId, edit.offset).has(edit.letter),
    );
    if (everyLetterPlausible) return 'peek';
    if (!wordListAvailable()) return 'none';
    return wordList.has(proposal.after) ? 'wordlist' : 'none';
  }

  // ---------------------------------------------------------------------
  // Enumeration. Cells in row-major order, then candidate letters in
  // alphabetical order, so the pass is reproducible without a PRNG; every
  // distance-1 proposal is yielded before any distance-2 proposal.
  // ---------------------------------------------------------------------

  function anchorsAt(row: number, col: number): string[] {
    return (slotsAtCell.get(cellKey(row, col)) ?? []).filter(
      (slotId) => grid.assignmentOf(slotId) !== undefined,
    );
  }

  function editAt(anchorId: string, row: number, col: number, letter: string): CellEdit {
    const offset = offsetInSlot.get(anchorId)?.get(cellKey(row, col));
    if (offset === undefined) throw new Error(`repair: r${row}c${col} is not in ${anchorId}`);
    return { row, col, offset, letter };
  }

  /**
   * The letter pairs worth trying at two offsets of one slot: every pair the
   * peek arm can justify, plus every pair a word-list neighbour of the current
   * word exhibits. Both arms of the gate are represented, and neither is the
   * 625-entry cross-product of the alphabet.
   */
  function letterPairs(
    anchorId: string,
    word: string,
    offsetA: number,
    offsetB: number,
  ): Array<[string, string]> {
    const currentA = word[offsetA];
    const currentB = word[offsetB];
    const pairs = new Set<string>();

    for (const a of plausibleLetters(anchorId, offsetA)) {
      if (a === currentA) continue;
      for (const b of plausibleLetters(anchorId, offsetB)) {
        if (b === currentB) continue;
        pairs.add(`${a}${b}`);
      }
    }

    if (wordListAvailable()) {
      const masked = substitute(substitute(word, offsetA, '?'), offsetB, '?');
      for (const neighbour of wordList.match(masked, WORDLIST_MATCH_LIMIT)) {
        if (neighbour.length !== word.length) continue;
        const a = neighbour[offsetA];
        const b = neighbour[offsetB];
        if (a === undefined || b === undefined) continue;
        if (a === currentA || b === currentB) continue;
        pairs.add(`${a}${b}`);
      }
    }

    return [...pairs]
      .sort()
      .map((pair) => [pair.slice(0, 1), pair.slice(1, 2)] as [string, string]);
  }

  function* enumerate(distance: number): Generator<Proposal> {
    for (const { row, col } of cellsRowMajor) {
      const current = grid.letterAt(row, col);
      if (current === null) continue;
      for (const anchorId of anchorsAt(row, col)) {
        const word = grid.assignmentOf(anchorId);
        if (word === undefined) continue;
        const first = editAt(anchorId, row, col, current);

        if (distance === 1) {
          for (const letter of ALPHABET) {
            if (letter === current) continue;
            yield {
              anchorId,
              before: word,
              after: substitute(word, first.offset, letter),
              edits: [{ ...first, letter }],
            };
          }
          continue;
        }

        // Distance 2: the second cell is a later cell of the same slot, which
        // (across left to right, down top to bottom) is also later in
        // row-major order, so the pair order follows the cell order too.
        const anchorSlot = slotOf(anchorId);
        for (let second = first.offset + 1; second < anchorSlot.length; second += 1) {
          const secondCell = anchorSlot.cells[second];
          if (secondCell === undefined) continue;
          for (const [letterA, letterB] of letterPairs(anchorId, word, first.offset, second)) {
            yield {
              anchorId,
              before: word,
              after: substitute(substitute(word, first.offset, letterA), second, letterB),
              edits: [
                { ...first, letter: letterA },
                { row: secondCell[0], col: secondCell[1], offset: second, letter: letterB },
              ],
            };
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Applying a proposal
  // ---------------------------------------------------------------------

  /**
   * Every assigned slot a proposal's changed cells touch, with the word it
   * would end up holding. The anchor is always one of them; a crossing is one
   * whenever it is assigned, because a changed cell changes its word too.
   */
  function affectedBy(proposal: Proposal): AffectedSlot[] {
    const words = new Map<string, string>();
    for (const edit of proposal.edits) {
      for (const slotId of slotsAtCell.get(cellKey(edit.row, edit.col)) ?? []) {
        const current = grid.assignmentOf(slotId);
        if (current === undefined) continue;
        const offset = offsetInSlot.get(slotId)?.get(cellKey(edit.row, edit.col));
        if (offset === undefined) continue;
        words.set(slotId, substitute(words.get(slotId) ?? current, offset, edit.letter));
      }
    }

    const affected: AffectedSlot[] = [];
    for (const slot of slots) {
      const after = words.get(slot.id);
      if (after === undefined) continue;
      const before = grid.assignmentOf(slot.id);
      if (before === undefined) continue;
      affected.push({ slotId: slot.id, before, after, editDistance: hammingDistance(before, after) });
    }
    return affected;
  }

  /**
   * Unassign every affected slot first: a changed cell is covered only by
   * slots the proposal changes, so it goes back to null and the re-assignment
   * cannot collide with a letter the old fill had fixed.
   */
  function applyProposal(affected: readonly AffectedSlot[]): void {
    for (const change of affected) grid.unassign(change.slotId);
    for (const change of affected) grid.assign(change.slotId, change.after);
  }

  // ---------------------------------------------------------------------
  // Scoring a proposal. One service call per proposal, for the anchor slot
  // with its new (fully fixed) pattern; a crossing whose word also changes is
  // scored from the ledger, which is what keeps a proposal to one call.
  // ---------------------------------------------------------------------

  async function anchorScore(proposal: Proposal): Promise<number> {
    const slot = slotOf(proposal.anchorId);
    const request: CandidateRequest = {
      slotId: proposal.anchorId,
      clue: slot.clue,
      length: slot.length,
      pattern: proposal.after,
      style,
      enumeration: slot.enumeration,
      title: opts.title,
      // The pattern is fully fixed, so it already rules out everything the
      // rejection list would: the model is being asked one question, "does
      // this word answer this clue".
      rejected: [],
      tier: 1,
      purpose: 'repair',
      n: opts.candidatesPerAsk ?? 10,
      samples: opts.samples ?? 1,
      sampleIndex: opts.sampleIndex ?? 0,
    };
    const result = await service.getCandidates(request);
    let best = 0;
    for (const candidate of result.candidates) {
      if (candidate.answer === proposal.after && candidate.score > best) best = candidate.score;
    }
    return best;
  }

  /** The call budget is checked before the call, never after. */
  function callAllowed(): boolean {
    if (callsUsed >= opts.maxCalls) return false;
    const charge = opts.chargeBudget?.('repairCalls', 1);
    return charge === undefined || charge.exceeded === null;
  }

  // ---------------------------------------------------------------------
  // The pass
  // ---------------------------------------------------------------------

  async function runRound(): Promise<'accepted' | 'exhausted' | 'stopped'> {
    plausibleCache = new Map();
    for (let distance = 1; distance <= maxDistance; distance += 1) {
      for (const proposal of enumerate(distance)) {
        const gate = gateOf(proposal);
        proposalCount += 1;
        emit({
          type: 'repair:propose',
          slotId: proposal.anchorId,
          before: proposal.before,
          after: proposal.after,
          editDistance: proposal.edits.length,
          gate,
        });

        if (gate === 'none') {
          emit({
            type: 'repair:reject',
            slotId: proposal.anchorId,
            before: proposal.before,
            after: proposal.after,
            gate: 'plausibility',
            reason:
              'no crossing candidate carries the changed letter and the result is not in the word list',
          });
          continue;
        }

        if (!callAllowed()) return 'stopped';

        const affected = affectedBy(proposal);
        callsUsed += 1;
        const freshScore = await anchorScore(proposal);

        let before = 0;
        let after = 0;
        for (const change of affected) {
          before += currentScore(change.slotId);
          after +=
            change.slotId === proposal.anchorId
              ? freshScore
              : bestLedgerScore(change.slotId, change.after);
        }

        // Ties are rejected, so the summed score strictly increases on every
        // acceptance and the pass cannot oscillate between two fills.
        if (after <= before) {
          emit({
            type: 'repair:reject',
            slotId: proposal.anchorId,
            before: proposal.before,
            after: proposal.after,
            gate: 'score',
            reason: `summed score ${after.toFixed(3)} does not improve on ${before.toFixed(3)}`,
          });
          continue;
        }

        applyProposal(affected);
        for (const change of affected) {
          scoreOfSlot.set(
            change.slotId,
            change.slotId === proposal.anchorId
              ? freshScore
              : bestLedgerScore(change.slotId, change.after),
          );
          emit({
            type: 'repair:accept',
            slotId: change.slotId,
            before: change.before,
            after: change.after,
            editDistance: change.editDistance,
            tier: 1,
            producedBy: 'tier1',
          });
        }
        acceptedCount += 1;
        return 'accepted';
      }
    }
    return 'exhausted';
  }

  for (;;) {
    const outcome = await runRound();
    if (outcome === 'stopped') {
      log.debug(`repair: the call budget is spent after ${callsUsed} calls; the phase ends here`);
    }
    if (outcome !== 'accepted') break;
  }

  // ---------------------------------------------------------------------
  // Step 7's last line: fill still-empty slots from the word list. It costs
  // no service call, so a spent call budget does not skip it - the spec ends
  // the phase gracefully rather than throwing work away.
  // ---------------------------------------------------------------------

  for (const slot of slots) {
    if (grid.assignmentOf(slot.id) !== undefined) continue;
    if (!wordListAvailable()) continue;
    const pattern = grid.patternFor(slot.id);
    const [best] = wordList.match(pattern, 1);
    if (best === undefined || best.length !== slot.length || !patternMatches(pattern, best)) {
      continue;
    }
    grid.assign(slot.id, best);
    scoreOfSlot.set(slot.id, wordList.score(best));
    emit({
      type: 'repair:accept',
      slotId: slot.id,
      before: pattern,
      after: best,
      editDistance: hammingDistance(pattern, best),
      tier: 'wordlist',
      producedBy: 'wordlist',
    });
    acceptedCount += 1;
  }

  return { proposals: proposalCount, accepted: acceptedCount, callsUsed };
}
