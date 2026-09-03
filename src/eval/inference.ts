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
  /** Malformed JSONL lines skipped while reading, across every file read (T41 decision). */
  skippedLines: number;
  /**
   * Records whose `parsed.clue_understood` is exactly 0. `InferenceLogRecord`
   * (frozen `src/llm/types.ts`) carries no explicit "this was defaulted by
   * the parser" flag - the parser's own warning
   * (`llm/parser.ts`'s `ParseOutcome.warnings`) is not threaded into the log
   * record - so this is a proxy count, not an exact one: a defaulted
   * `clue_understood` always reads as 0, but a model that genuinely
   * self-reports 0 confidence is indistinguishable from a default with this
   * schema alone. Counted over every record with a non-null `parsed` value
   * (cache hits included, since they carry the cached `parsed`).
   */
  clueUnderstoodDefaulted: number;
  /** Populated only when `dump` is set. */
  records?: InferenceLogRecord[];
}

/** One inference-log file as handed back by an `InferenceLogReader`. */
export interface InferenceLogFile {
  /** For diagnostics only (e.g. a malformed-line warning); not parsed for its date. */
  path: string;
  text: string;
}

/**
 * The injection seam for reading `logs/inference/*.jsonl`: production code
 * (T46) globs the directory and reads each file from disk; tests hand back
 * fixture content directly, so no real filesystem is touched.
 */
export type InferenceLogReader = () => ReadonlyArray<InferenceLogFile>;

export interface InferenceLogLoadResult {
  records: InferenceLogRecord[];
  /** Count of non-blank lines that failed to parse as JSON (T41 decision: reported, never silently dropped). */
  skippedLines: number;
}

/**
 * Parses every file an `InferenceLogReader` hands back into
 * `InferenceLogRecord`s. A blank line (including the file's trailing
 * newline) is skipped without counting against `skippedLines`; any other
 * line that fails `JSON.parse` is counted and otherwise ignored, so one
 * malformed line never loses the rest of the file.
 */
export function readInferenceLog(reader: InferenceLogReader): InferenceLogLoadResult {
  const records: InferenceLogRecord[] = [];
  let skippedLines = 0;

  for (const file of reader()) {
    const lines = file.text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        records.push(JSON.parse(trimmed) as InferenceLogRecord);
      } catch {
        skippedLines += 1;
      }
    }
  }

  return { records, skippedLines };
}

/** The record's UTC calendar date, taken from `ts` (T41 decision: never from the filename). */
function utcDateOf(ts: string): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function passesFilters(record: InferenceLogRecord, filters: InferenceFilters): boolean {
  if (filters.model !== undefined && record.model !== filters.model) return false;
  if (filters.run !== undefined && record.runId !== filters.run) return false;
  if (filters.slot !== undefined && record.slotId !== filters.slot) return false;

  const day = utcDateOf(record.ts);
  if (filters.since !== undefined && day < filters.since) return false;
  if (filters.until !== undefined && day > filters.until) return false;

  return true;
}

function hasLatency(
  record: InferenceLogRecord,
): record is InferenceLogRecord & { latencyMs: number } {
  return record.latencyMs !== null;
}

/**
 * T41. Pure aggregation over already-read records: calls per model per day,
 * USD per day (billed and counterfactual), parse-failure rate per model
 * (`parseError != null` over non-cache-hit calls - a cache hit has no
 * response to parse, so it is excluded from that denominator but still
 * counted in the call count and the cache-hit-rate numerator, per decision),
 * cache-hit rate, and the 20 slowest calls by `latencyMs`. `--since`/`--until`
 * are inclusive and compare against the record's own UTC date.
 */
export function aggregateInference(
  records: ReadonlyArray<InferenceLogRecord>,
  filters: InferenceFilters,
): InferenceReport {
  const filtered = records.filter((r) => passesFilters(r, filters));

  const callsByDayModel = new Map<string, { day: string; model: string; calls: number }>();
  const usdByDay = new Map<string, { day: string; usdBilled: number; usdCounterfactual: number }>();
  const parseStatsByModel = new Map<string, { failures: number; calls: number }>();
  let cacheHits = 0;
  let clueUnderstoodDefaulted = 0;

  for (const record of filtered) {
    const day = utcDateOf(record.ts);

    const dayModelKey = `${day}|${record.model}`;
    const dayModelEntry = callsByDayModel.get(dayModelKey) ?? {
      day,
      model: record.model,
      calls: 0,
    };
    dayModelEntry.calls += 1;
    callsByDayModel.set(dayModelKey, dayModelEntry);

    const usdEntry = usdByDay.get(day) ?? { day, usdBilled: 0, usdCounterfactual: 0 };
    usdEntry.usdBilled += record.usdBilled ?? 0;
    usdEntry.usdCounterfactual += record.usdCounterfactual ?? 0;
    usdByDay.set(day, usdEntry);

    if (record.parsed !== null && record.parsed.clue_understood === 0) {
      clueUnderstoodDefaulted += 1;
    }

    if (record.cacheHit) {
      cacheHits += 1;
      continue;
    }

    const parseEntry = parseStatsByModel.get(record.model) ?? { failures: 0, calls: 0 };
    parseEntry.calls += 1;
    if (record.parseError !== null) parseEntry.failures += 1;
    parseStatsByModel.set(record.model, parseEntry);
  }

  const callsPerModelPerDay = [...callsByDayModel.values()].sort((a, b) =>
    a.day === b.day ? a.model.localeCompare(b.model) : a.day.localeCompare(b.day),
  );
  const usdPerDay = [...usdByDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const parseFailureRate = [...parseStatsByModel.entries()]
    .map(([model, { failures, calls }]) => ({
      model,
      failures,
      calls,
      rate: calls === 0 ? 0 : failures / calls,
    }))
    .sort((a, b) => a.model.localeCompare(b.model));
  const slowest = filtered
    .filter(hasLatency)
    .slice()
    .sort((a, b) => b.latencyMs - a.latencyMs)
    .slice(0, 20)
    .map((r) => ({ id: r.id, model: r.model, latencyMs: r.latencyMs, slotId: r.slotId }));

  const report: InferenceReport = {
    callsPerModelPerDay,
    usdPerDay,
    parseFailureRate,
    cacheHitRate: filtered.length === 0 ? 0 : cacheHits / filtered.length,
    slowest,
    skippedLines: 0,
    clueUnderstoodDefaulted,
  };
  if (filters.dump) report.records = filtered.slice();
  return report;
}

/**
 * The end-to-end entry point: reads `logs/inference/*.jsonl` through an
 * injected `InferenceLogReader` (so production code globs the real
 * directory and tests hand back fixtures), then aggregates. `skippedLines`
 * comes from the read, not from `aggregateInference` (which never sees raw
 * lines), and is merged into the returned report.
 */
export function loadInferenceReport(
  reader: InferenceLogReader,
  filters: InferenceFilters,
): InferenceReport {
  const { records, skippedLines } = readInferenceLog(reader);
  return { ...aggregateInference(records, filters), skippedLines };
}
