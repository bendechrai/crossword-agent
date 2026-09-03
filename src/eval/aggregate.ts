import { notImplemented } from '../util/errors.js';
import type { RunRecord } from './types.js';

export type GroupBy = 'profile' | 'puzzle' | 'tier' | 'stratum' | 'batchIndex';

export interface AggregateOptions {
  by: GroupBy;
  /** True when the runs span more than one repeat (B1). */
  splitVariance?: boolean;
}

export interface GroupAggregate {
  group: string;
  n: number;
  letters: { mean: number; stdev: number };
  words: { mean: number; stdev: number };
  perfect: { mean: number; stdev: number };
  /** Within-puzzle and across-puzzle variance, when repeat > 1 (B1). */
  variance?: { withinPuzzle: number; acrossPuzzle: number };
  usdPerPuzzle: number;
  usdPerCorrectWord: number;
  tier2Share: number;
  meanWallMs: number;
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
  delta: number;
}

/** T40. All cost figures use `usdCounterfactual` (B2). */
export function aggregate(
  _records: ReadonlyArray<RunRecord>,
  _opts: AggregateOptions,
): Aggregation {
  return notImplemented('src/eval/aggregate.ts');
}

export function compare(_a: GroupAggregate, _b: GroupAggregate): ComparisonRow[] {
  return notImplemented('src/eval/aggregate.ts');
}
