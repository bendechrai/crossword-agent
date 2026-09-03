import type { PerSlotRecord, RunRecord } from './types.js';

export type GroupBy = 'profile' | 'puzzle' | 'tier' | 'stratum' | 'batchIndex';

export interface AggregateOptions {
  by: GroupBy;
  /** True when the runs span more than one repeat (B1). */
  splitVariance?: boolean;
}

export interface GroupAggregate {
  group: string;
  n: number;
  letters: { mean: number; stdev: number | null };
  words: { mean: number; stdev: number | null };
  perfect: { mean: number; stdev: number | null };
  /**
   * Within-puzzle and across-puzzle variance of letter accuracy, present only
   * when `opts.splitVariance` is set (B1): within-puzzle is the mean of each
   * puzzle's own sample variance across its repeats (model nondeterminism);
   * across-puzzle is the sample variance of each puzzle's mean letter
   * accuracy (puzzle difficulty spread). Either component is `null` when it
   * has no eligible puzzle (fewer than 2 repeats, or fewer than 2 puzzles,
   * respectively) to compute it from. Only meaningful for the run-level
   * groupings ('profile', 'puzzle', 'stratum'); always absent for the
   * slot-level groupings ('tier', 'batchIndex').
   */
  variance?: { withinPuzzle: number | null; acrossPuzzle: number | null };
  /**
   * Mean `usdCounterfactual` per run in the group (B2). For the slot-level
   * groupings this is instead the mean per-slot `usd` in the group - there is
   * no single "puzzle" at that granularity.
   */
  usdPerPuzzle: number;
  /**
   * `sum(usdCounterfactual) / sum(correct words)` (B2). Zero when the group
   * has no correct words, rather than NaN, so the value stays JSON-safe.
   */
  usdPerCorrectWord: number;
  /** `tier2.count / (tier1.count + tier2.count)`, pooled across the group. */
  tier2Share: number;
  /**
   * Mean `wallMs` per run in the group. For the slot-level groupings this is
   * instead the mean per-slot `latencyMs`, since a slot has no `wallMs`.
   */
  meanWallMs: number;
  /** Count of `budgetHits` entries in the group, keyed by cap. Empty for the slot-level groupings. */
  budgetHits: Record<string, number>;
}

export interface SlotDifficultyRow {
  puzzleId: string;
  slotId: string;
  clue: string;
  profilesWrong: number;
  profilesTotal: number;
}

export interface Aggregation {
  by: GroupBy;
  groups: GroupAggregate[];
  slotDifficulty: SlotDifficultyRow[];
}

export interface ComparisonRow {
  metric: string;
  a: number;
  b: number;
  /** `b - a`, signed. */
  delta: number;
}

const SLOT_LEVEL_GROUPINGS: ReadonlySet<GroupBy> = new Set(['tier', 'batchIndex']);

function mean(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Sample (n-1) variance. `null` for fewer than two values (B1). */
function sampleVariance(values: ReadonlyArray<number>): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  let sumSq = 0;
  for (const v of values) sumSq += (v - m) ** 2;
  return sumSq / (values.length - 1);
}

/** Sample (n-1) standard deviation. `null` for a group of size 1, not 0. */
function sampleStdev(values: ReadonlyArray<number>): number | null {
  const variance = sampleVariance(values);
  return variance === null ? null : Math.sqrt(variance);
}

function usdCounterfactualOf(record: RunRecord): number {
  return record.calls.tier1.usdCounterfactual + record.calls.tier2.usdCounterfactual;
}

function correctWordCountOf(record: RunRecord): number {
  return record.perSlot.filter((slot) => slot.correct).length;
}

function tallyBudgetHits(records: ReadonlyArray<RunRecord>): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const record of records) {
    for (const hit of record.budgetHits) {
      tally[hit.cap] = (tally[hit.cap] ?? 0) + 1;
    }
  }
  return tally;
}

function runGroupKey(record: RunRecord, by: 'profile' | 'puzzle' | 'stratum'): string {
  switch (by) {
    case 'profile':
      return record.profile.name;
    case 'puzzle':
      return record.puzzle.id;
    case 'stratum':
      return record.puzzle.stratum;
  }
}

function computeVariance(
  records: ReadonlyArray<RunRecord>,
): { withinPuzzle: number | null; acrossPuzzle: number | null } {
  const byPuzzle = new Map<string, number[]>();
  for (const record of records) {
    const list = byPuzzle.get(record.puzzle.id) ?? [];
    list.push(record.accuracy.letters);
    byPuzzle.set(record.puzzle.id, list);
  }

  const withinVariances: number[] = [];
  const puzzleMeans: number[] = [];
  for (const values of byPuzzle.values()) {
    puzzleMeans.push(mean(values));
    const v = sampleVariance(values);
    if (v !== null) withinVariances.push(v);
  }

  const withinPuzzle = withinVariances.length > 0 ? mean(withinVariances) : null;
  const acrossPuzzle = sampleVariance(puzzleMeans);
  return { withinPuzzle, acrossPuzzle };
}

function computeRunGroup(
  group: string,
  records: ReadonlyArray<RunRecord>,
  splitVariance: boolean,
): GroupAggregate {
  const lettersValues = records.map((r) => r.accuracy.letters);
  const wordsValues = records.map((r) => r.accuracy.words);
  const perfectValues = records.map((r) => (r.accuracy.perfect ? 1 : 0));

  const usdValues = records.map(usdCounterfactualOf);
  const totalUsd = usdValues.reduce((a, b) => a + b, 0);
  const totalCorrectWords = records.reduce((a, r) => a + correctWordCountOf(r), 0);

  const tier1Count = records.reduce((a, r) => a + r.calls.tier1.count, 0);
  const tier2Count = records.reduce((a, r) => a + r.calls.tier2.count, 0);
  const totalCalls = tier1Count + tier2Count;

  return {
    group,
    n: records.length,
    letters: { mean: mean(lettersValues), stdev: sampleStdev(lettersValues) },
    words: { mean: mean(wordsValues), stdev: sampleStdev(wordsValues) },
    perfect: { mean: mean(perfectValues), stdev: sampleStdev(perfectValues) },
    ...(splitVariance ? { variance: computeVariance(records) } : {}),
    usdPerPuzzle: mean(usdValues),
    usdPerCorrectWord: totalCorrectWords > 0 ? totalUsd / totalCorrectWords : 0,
    tier2Share: totalCalls > 0 ? tier2Count / totalCalls : 0,
    meanWallMs: mean(records.map((r) => r.wallMs)),
    budgetHits: tallyBudgetHits(records),
  };
}

function aggregateByRun(
  records: ReadonlyArray<RunRecord>,
  by: 'profile' | 'puzzle' | 'stratum',
  splitVariance: boolean,
): GroupAggregate[] {
  const byGroup = new Map<string, RunRecord[]>();
  for (const record of records) {
    const key = runGroupKey(record, by);
    const list = byGroup.get(key) ?? [];
    list.push(record);
    byGroup.set(key, list);
  }

  return [...byGroup.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, groupRecords]) => computeRunGroup(group, groupRecords, splitVariance));
}

interface FlatSlot {
  slot: PerSlotRecord;
}

function slotGroupKey(slot: PerSlotRecord, by: 'tier' | 'batchIndex'): string | null {
  switch (by) {
    case 'tier':
      return slot.producedBy === null ? null : String(slot.producedBy);
    case 'batchIndex':
      // Skip slots with a null batchIndex (B14).
      return slot.batchIndex === null ? null : String(slot.batchIndex);
  }
}

function computeSlotGroup(group: string, entries: ReadonlyArray<FlatSlot>): GroupAggregate {
  const n = entries.length;
  const correctIndicators: number[] = entries.map((e) => (e.slot.correct ? 1 : 0));
  const correctCount = correctIndicators.reduce((a, b) => a + b, 0);

  const usdValues = entries.map((e) => e.slot.usd);
  const totalUsd = usdValues.reduce((a, b) => a + b, 0);

  const tier2Count = entries.filter((e) => e.slot.producedBy === 2).length;

  // Only whole-slot correctness is available at slot granularity, so letters
  // and words collapse to the same correct-fraction (documented
  // approximation; there is no per-letter truth carried on PerSlotRecord).
  const correctStats = { mean: mean(correctIndicators), stdev: sampleStdev(correctIndicators) };

  return {
    group,
    n,
    letters: correctStats,
    words: correctStats,
    perfect: correctStats,
    // No per-puzzle decomposition makes sense at slot granularity.
    usdPerPuzzle: mean(usdValues),
    usdPerCorrectWord: correctCount > 0 ? totalUsd / correctCount : 0,
    tier2Share: n > 0 ? tier2Count / n : 0,
    meanWallMs: mean(entries.map((e) => e.slot.latencyMs)),
    budgetHits: {},
  };
}

function aggregateBySlot(records: ReadonlyArray<RunRecord>, by: 'tier' | 'batchIndex'): GroupAggregate[] {
  const byGroup = new Map<string, FlatSlot[]>();
  for (const record of records) {
    for (const slot of record.perSlot) {
      const key = slotGroupKey(slot, by);
      if (key === null) continue;
      const list = byGroup.get(key) ?? [];
      list.push({ slot });
      byGroup.set(key, list);
    }
  }

  return [...byGroup.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, entries]) => computeSlotGroup(group, entries));
}

function buildSlotDifficulty(records: ReadonlyArray<RunRecord>): SlotDifficultyRow[] {
  interface Cell {
    clue: string;
    /** profile name -> true if any of that profile's runs on this puzzle got the slot wrong. */
    wrongByProfile: Map<string, boolean>;
  }
  const cells = new Map<string, Cell>();

  for (const record of records) {
    const profileName = record.profile.name;
    for (const slot of record.perSlot) {
      const key = `${record.puzzle.id} ${slot.slotId}`;
      const cell = cells.get(key) ?? { clue: slot.clue, wrongByProfile: new Map<string, boolean>() };
      const alreadyWrong = cell.wrongByProfile.get(profileName) ?? false;
      cell.wrongByProfile.set(profileName, alreadyWrong || !slot.correct);
      cells.set(key, cell);
    }
  }

  const rows: SlotDifficultyRow[] = [];
  for (const [key, cell] of cells) {
    const [puzzleId, slotId] = key.split(' ') as [string, string];
    const profilesTotal = cell.wrongByProfile.size;
    let profilesWrong = 0;
    for (const wrong of cell.wrongByProfile.values()) if (wrong) profilesWrong += 1;
    rows.push({ puzzleId, slotId, clue: cell.clue, profilesWrong, profilesTotal });
  }

  rows.sort((a, b) => {
    if (b.profilesWrong !== a.profilesWrong) return b.profilesWrong - a.profilesWrong;
    if (a.puzzleId !== b.puzzleId) return a.puzzleId.localeCompare(b.puzzleId);
    return a.slotId.localeCompare(b.slotId);
  });
  return rows;
}

/**
 * Pure aggregation over parsed run records (T40). Rendering is T46's job.
 *
 * `by: 'profile' | 'puzzle' | 'stratum'` groups whole run records.
 * `by: 'tier' | 'batchIndex'` groups the flattened `perSlot` rows across
 * every record instead, since those two axes are properties of a clue's
 * production, not of a run (spec: "'--by tier' groups by producing tier ...
 * '--by batchIndex' groups by the clue's position within its batch").
 *
 * All cost figures use `usdCounterfactual` (B2); `usdBilled` is never
 * divided by anything here.
 */
export function aggregate(records: ReadonlyArray<RunRecord>, opts: AggregateOptions): Aggregation {
  const groups = SLOT_LEVEL_GROUPINGS.has(opts.by)
    ? aggregateBySlot(records, opts.by as 'tier' | 'batchIndex')
    : aggregateByRun(records, opts.by as 'profile' | 'puzzle' | 'stratum', opts.splitVariance ?? false);

  return { by: opts.by, groups, slotDifficulty: buildSlotDifficulty(records) };
}

const COMPARISON_METRICS: ReadonlyArray<{ name: string; get: (g: GroupAggregate) => number }> = [
  { name: 'letters', get: (g) => g.letters.mean },
  { name: 'words', get: (g) => g.words.mean },
  { name: 'perfect', get: (g) => g.perfect.mean },
  { name: 'usdPerPuzzle', get: (g) => g.usdPerPuzzle },
  { name: 'usdPerCorrectWord', get: (g) => g.usdPerCorrectWord },
  { name: 'tier2Share', get: (g) => g.tier2Share },
  { name: 'meanWallMs', get: (g) => g.meanWallMs },
];

/** Paired delta table between two already-aggregated groups. `delta` is `b - a`, signed. */
export function compare(a: GroupAggregate, b: GroupAggregate): ComparisonRow[] {
  return COMPARISON_METRICS.map(({ name, get }) => {
    const av = get(a);
    const bv = get(b);
    return { metric: name, a: av, b: bv, delta: bv - av };
  });
}
