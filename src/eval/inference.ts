import { notImplemented } from '../util/errors.js';
import type { InferenceLogRecord } from '../llm/types.js';

export interface InferenceFilters {
  since?: string;
  until?: string;
  model?: string;
  run?: string;
  slot?: string;
  /** Return the full matching records instead of the aggregates. */
  dump?: boolean;
}

export interface InferenceReport {
  callsPerModelPerDay: Array<{ day: string; model: string; calls: number }>;
  usdPerDay: Array<{ day: string; usdBilled: number; usdCounterfactual: number }>;
  parseFailureRate: Array<{ model: string; failures: number; calls: number; rate: number }>;
  cacheHitRate: number;
  slowest: Array<{ id: string; model: string; latencyMs: number; slotId: string | null }>;
  /** Populated only when `dump` is set. */
  records?: InferenceLogRecord[];
}

/** T41. Reads `logs/inference/*.jsonl` through an injected reader. */
export function aggregateInference(
  _records: ReadonlyArray<InferenceLogRecord>,
  _filters: InferenceFilters,
): InferenceReport {
  return notImplemented('src/eval/inference.ts');
}
