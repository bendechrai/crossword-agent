import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { loadConfig } from '../config.js';
import {
  aggregate,
  compare,
  type Aggregation,
  type ComparisonRow,
  type GroupAggregate,
  type GroupBy,
} from '../eval/aggregate.js';
import {
  loadInferenceReport,
  type InferenceFilters,
  type InferenceLogFile,
  type InferenceLogReader,
  type InferenceReport,
} from '../eval/inference.js';
import type { RunRecord } from '../eval/types.js';
import { repoRoot, resolveInferenceLogDir } from '../util/fs.js';
import { notFoundError, usageError } from './exit.js';
import type { GlobalOptions, ReportOptions } from './options.js';

/**
 * T46: the `report` handler. Reads a glob of run records and calls T40's
 * `aggregate`, or (with `--inference`) reads `logs/inference/*.jsonl`
 * through T41's `loadInferenceReport` instead. Prints `--json`, `--md` or a
 * plain table.
 *
 * `overrides.inferenceReader` lets tests hand back fixture log content
 * directly (matching T41's own test style) without touching the real
 * filesystem; the real CLI never passes it.
 */
export interface ReportCommandOverrides {
  inferenceReader?: InferenceLogReader;
}

// ---------------------------------------------------------------------------
// Minimal glob support for --runs.
// ---------------------------------------------------------------------------

/**
 * Splits a pattern into its literal directory and its (possibly wildcarded)
 * final segment. Only the final segment may contain `*`/`?`; every directory
 * segment is taken literally. This is sufficient for every glob this command
 * is ever asked to resolve ("runs/*.json", a bench glob under sets/, or a
 * fixture directory in tests) - a wildcarded directory segment is not
 * supported.
 */
function splitGlobPath(pattern: string): { dir: string; base: string } {
  const idx = pattern.lastIndexOf('/');
  if (idx === -1) return { dir: '.', base: pattern };
  return { dir: pattern.slice(0, idx) || '/', base: pattern.slice(idx + 1) };
}

function globPatternToRegExp(glob: string): RegExp {
  let src = '^';
  for (const ch of glob) {
    if (ch === '*') src += '[^/]*';
    else if (ch === '?') src += '[^/]';
    else src += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${src}$`);
}

/**
 * Resolves `pattern` against `root` (unless already absolute) and lists the
 * matching file paths, sorted so output ordering never depends on directory
 * entry order (acceptance 7: byte-identical output across repeated runs). A
 * directory that does not exist yields zero matches rather than throwing.
 */
function globFiles(pattern: string, root: string): string[] {
  const resolvedPattern = isAbsolute(pattern) ? pattern : resolve(root, pattern);
  const { dir, base } = splitGlobPath(resolvedPattern);
  const regex = globPatternToRegExp(base);

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => regex.test(name))
    .sort()
    .map((name) => join(dir, name));
}

/**
 * `--runs` always has a value (commander defaults it to "runs/*.json"), so -
 * matching the precedent in `src/cli/fetch.ts` for `--out`, which is also
 * always present - it always wins over `$CROSSWORD_RUNS_DIR` and a config
 * file's `runsDir`. Resolved against the repo root, not `process.cwd()`, so
 * the command behaves the same regardless of where it is invoked from.
 */
function loadRunRecords(opts: ReportOptions): RunRecord[] {
  const files = globFiles(opts.runs, repoRoot());
  if (files.length === 0) {
    throw notFoundError(`no run records matched ${opts.runs}`);
  }
  return files.map((file) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as RunRecord;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw notFoundError(`failed to parse run record "${file}": ${message}`);
    }
  });
}

/**
 * B1: pass `splitVariance: true` only when the input is known to span more
 * than one repeat. `--repeat N` feeds `repeatIndex`, so any record with a
 * nonzero `repeatIndex` proves at least one (puzzle, profile) pair was
 * sampled more than once among the records being aggregated.
 */
function detectSplitVariance(records: ReadonlyArray<RunRecord>): boolean {
  return records.some((r) => r.repeatIndex > 0);
}

// ---------------------------------------------------------------------------
// Fixed-precision formatting (decision: same data always renders the same
// string). Accuracies and other [0,1]-ish fractions get 4 decimal places,
// USD gets 6, latency/wall-clock gets a rounded integer.
// ---------------------------------------------------------------------------

function fmtFraction(v: number | null): string {
  return v === null ? '-' : v.toFixed(4);
}

function fmtUsd(v: number): string {
  return v.toFixed(6);
}

function fmtMs(v: number): string {
  return String(Math.round(v));
}

function fmtCount(v: number): string {
  return String(v);
}

function fmtBudgetHits(hits: Record<string, number>): string {
  const entries = Object.entries(hits).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? '-' : entries.map(([cap, n]) => `${cap}:${n}`).join(',');
}

// ---------------------------------------------------------------------------
// Group table rendering. Run-level groupings ("profile", "puzzle",
// "stratum") and slot-level groupings ("tier", "batchIndex") get a different,
// fixed column order each, per the T40 build notes: at slot granularity,
// letters/words/perfect collapse to the same per-slot correct fraction,
// usdPerPuzzle is really a per-slot usd mean, meanWallMs is really a mean
// latencyMs, and budgetHits is always empty.
// ---------------------------------------------------------------------------

const SLOT_LEVEL_GROUPINGS: ReadonlySet<GroupBy> = new Set(['tier', 'batchIndex']);

interface Column {
  header: string;
  cell: (g: GroupAggregate) => string;
}

function runLevelColumns(splitVariance: boolean): Column[] {
  const columns: Column[] = [
    { header: 'group', cell: (g) => g.group },
    { header: 'n', cell: (g) => fmtCount(g.n) },
    { header: 'letters_mean', cell: (g) => fmtFraction(g.letters.mean) },
    { header: 'letters_stdev', cell: (g) => fmtFraction(g.letters.stdev) },
    { header: 'words_mean', cell: (g) => fmtFraction(g.words.mean) },
    { header: 'words_stdev', cell: (g) => fmtFraction(g.words.stdev) },
    { header: 'perfect_mean', cell: (g) => fmtFraction(g.perfect.mean) },
    { header: 'perfect_stdev', cell: (g) => fmtFraction(g.perfect.stdev) },
    { header: 'usd_per_puzzle', cell: (g) => fmtUsd(g.usdPerPuzzle) },
    { header: 'usd_per_correct_word', cell: (g) => fmtUsd(g.usdPerCorrectWord) },
    { header: 'tier2_share', cell: (g) => fmtFraction(g.tier2Share) },
    { header: 'mean_wall_ms', cell: (g) => fmtMs(g.meanWallMs) },
    { header: 'budget_hits', cell: (g) => fmtBudgetHits(g.budgetHits) },
  ];
  if (splitVariance) {
    columns.push(
      { header: 'within_puzzle_variance', cell: (g) => fmtFraction(g.variance?.withinPuzzle ?? null) },
      { header: 'across_puzzle_variance', cell: (g) => fmtFraction(g.variance?.acrossPuzzle ?? null) },
    );
  }
  return columns;
}

function slotLevelColumns(): Column[] {
  return [
    { header: 'group', cell: (g) => g.group },
    { header: 'n', cell: (g) => fmtCount(g.n) },
    { header: 'correct_mean', cell: (g) => fmtFraction(g.letters.mean) },
    { header: 'correct_stdev', cell: (g) => fmtFraction(g.letters.stdev) },
    { header: 'usd_per_slot', cell: (g) => fmtUsd(g.usdPerPuzzle) },
    { header: 'usd_per_correct_word', cell: (g) => fmtUsd(g.usdPerCorrectWord) },
    { header: 'tier2_share', cell: (g) => fmtFraction(g.tier2Share) },
    { header: 'mean_latency_ms', cell: (g) => fmtMs(g.meanWallMs) },
  ];
}

function columnsFor(by: GroupBy, splitVariance: boolean): Column[] {
  return SLOT_LEVEL_GROUPINGS.has(by) ? slotLevelColumns() : runLevelColumns(splitVariance);
}

/**
 * `aggregate` sorts every grouping with `String.localeCompare` (T40 build
 * notes), which orders "10" before "2". For the two numeric groupings this
 * command re-sorts numerically before rendering; a non-numeric group (for
 * example "wordlist" under `--by tier`) sorts after every numeric one, then
 * alphabetically among themselves. Only the rendered tables are reordered -
 * `--json` always prints the `Aggregation` object exactly as `aggregate`
 * returned it.
 */
function numericGroupCompare(a: string, b: string): number {
  const an = Number.parseInt(a, 10);
  const bn = Number.parseInt(b, 10);
  const aNumeric = String(an) === a;
  const bNumeric = String(bn) === b;
  if (aNumeric && bNumeric) return an - bn;
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a.localeCompare(b);
}

function orderedGroups(aggregation: Aggregation): GroupAggregate[] {
  const groups = [...aggregation.groups];
  if (SLOT_LEVEL_GROUPINGS.has(aggregation.by)) {
    groups.sort((a, b) => numericGroupCompare(a.group, b.group));
  }
  return groups;
}

function computeColumnWidths(header: readonly string[], rows: readonly string[][]): number[] {
  return header.map((h, i) => {
    let max = h.length;
    for (const row of rows) {
      const value = row[i] ?? '';
      if (value.length > max) max = value.length;
    }
    return max;
  });
}

function padCells(cells: readonly string[], widths: readonly number[]): string {
  return cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join('  ').trimEnd();
}

function renderPlainRows(header: readonly string[], rows: readonly string[][]): string[] {
  const widths = computeColumnWidths(header, rows);
  const lines = [padCells(header, widths)];
  for (const row of rows) lines.push(padCells(row, widths));
  return lines;
}

function renderMdRows(header: readonly string[], rows: readonly string[][]): string[] {
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return lines;
}

function renderTable(md: boolean, header: readonly string[], rows: readonly string[][]): string[] {
  return md ? renderMdRows(header, rows) : renderPlainRows(header, rows);
}

function renderGroupsTable(md: boolean, columns: readonly Column[], groups: readonly GroupAggregate[]): string[] {
  const header = columns.map((c) => c.header);
  const rows = groups.map((g) => columns.map((c) => c.cell(g)));
  return renderTable(md, header, rows);
}

// ---------------------------------------------------------------------------
// --compare
// ---------------------------------------------------------------------------

type MetricKind = 'fraction' | 'usd' | 'ms';

const COMPARE_METRIC_KIND: Record<string, MetricKind> = {
  letters: 'fraction',
  words: 'fraction',
  perfect: 'fraction',
  usdPerPuzzle: 'usd',
  usdPerCorrectWord: 'usd',
  tier2Share: 'fraction',
  meanWallMs: 'ms',
};

function fmtMetric(kind: MetricKind, v: number): string {
  switch (kind) {
    case 'usd':
      return fmtUsd(v);
    case 'ms':
      return fmtMs(v);
    case 'fraction':
      return fmtFraction(v);
  }
}

function resolveCompareGroups(aggregation: Aggregation, names: readonly string[]): GroupAggregate[] {
  return names.map((name) => {
    const found = aggregation.groups.find((group) => group.group === name);
    if (found === undefined) {
      const known = aggregation.groups.map((g) => g.group).join(', ');
      throw usageError(`unknown --compare group "${name}"`, `known groups: ${known}`);
    }
    return found;
  });
}

interface CompareTable {
  a: string;
  b: string;
  rows: ComparisonRow[];
}

/** Decision: `--compare` requires at least two names (exit 2 otherwise). */
function buildCompareTables(aggregation: Aggregation, names: readonly string[] | undefined): CompareTable[] {
  if (names === undefined) return [];
  if (names.length < 2) {
    throw usageError('--compare requires at least two group names', 'for example --compare baseline,patient');
  }
  const groups = resolveCompareGroups(aggregation, names);
  const baseline = groups[0];
  if (baseline === undefined) {
    throw new Error('unreachable: --compare length was checked above');
  }
  return groups.slice(1).map((g) => ({ a: baseline.group, b: g.group, rows: compare(baseline, g) }));
}

function renderCompareTable(md: boolean, table: CompareTable): string[] {
  const header = ['metric', 'a', 'b', 'delta'];
  const rows = table.rows.map((r) => {
    const kind = COMPARE_METRIC_KIND[r.metric] ?? 'fraction';
    return [r.metric, fmtMetric(kind, r.a), fmtMetric(kind, r.b), fmtMetric(kind, r.delta)];
  });
  const lines = [md ? `### compare: ${table.a} vs ${table.b}` : `compare: ${table.a} vs ${table.b}`];
  lines.push(...renderTable(md, header, rows));
  return lines;
}

// ---------------------------------------------------------------------------
// `xw report` (run records)
// ---------------------------------------------------------------------------

function runRunsReport(opts: ReportOptions): void {
  const records = loadRunRecords(opts);
  const splitVariance = detectSplitVariance(records);
  const aggregation = aggregate(records, { by: opts.by, ...(splitVariance ? { splitVariance: true } : {}) });
  const compareTables = buildCompareTables(aggregation, opts.compare);

  if (opts.json) {
    const payload = compareTables.length > 0 ? { ...aggregation, comparisons: compareTables } : aggregation;
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const columns = columnsFor(aggregation.by, splitVariance);
  const groups = orderedGroups(aggregation);
  const lines = renderGroupsTable(opts.md, columns, groups);

  for (const table of compareTables) {
    lines.push('');
    lines.push(...renderCompareTable(opts.md, table));
  }

  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// `xw report --inference`
// ---------------------------------------------------------------------------

/**
 * Normalises a `--since`/`--until` value to exactly `YYYY-MM-DD`: T41's
 * `passesFilters` compares this string against the record's own UTC date
 * with plain string comparison, so an unpadded or time-bearing input would
 * silently misorder or exclude a day it should include.
 */
function normalizeDateFlag(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw usageError(`invalid date "${value}"`, 'expected YYYY-MM-DD');
  }
  return parsed.toISOString().slice(0, 10);
}

function buildInferenceFilters(opts: ReportOptions): InferenceFilters {
  return {
    ...(opts.since !== undefined ? { since: normalizeDateFlag(opts.since) } : {}),
    ...(opts.until !== undefined ? { until: normalizeDateFlag(opts.until) } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.run !== undefined ? { run: opts.run } : {}),
    ...(opts.slot !== undefined ? { slot: opts.slot } : {}),
  };
}

/** Real `InferenceLogReader` (T41): reads every `*.jsonl` file in `dir`, sorted. */
function realInferenceLogReader(dir: string): InferenceLogReader {
  return () => {
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return [];
    }
    return names.sort().map((name): InferenceLogFile => {
      const path = join(dir, name);
      return { path, text: readFileSync(path, 'utf8') };
    });
  };
}

/**
 * There is no `--logs-dir` flag, so (unlike `--runs`) this does consult
 * config and `$CROSSWORD_INFERENCE_LOG_DIR` via the normal precedence, the
 * same way `src/cli/list.ts` resolves the puzzles directory.
 */
async function resolveInferenceReader(
  global: GlobalOptions,
  overrides: ReportCommandOverrides,
): Promise<InferenceLogReader> {
  if (overrides.inferenceReader !== undefined) return overrides.inferenceReader;
  const { config } = await loadConfig({ path: global.config });
  const dir = resolveInferenceLogDir({ config: config.inferenceLogDir, env: process.env });
  return realInferenceLogReader(dir);
}

function renderInferenceReport(md: boolean, report: InferenceReport): string {
  const sections: string[] = [];

  sections.push(
    [
      md ? '### calls per model per day' : 'calls per model per day:',
      ...renderTable(
        md,
        ['day', 'model', 'calls'],
        report.callsPerModelPerDay.map((r) => [r.day, r.model, fmtCount(r.calls)]),
      ),
    ].join('\n'),
  );

  sections.push(
    [
      md ? '### usd per day' : 'usd per day:',
      ...renderTable(
        md,
        ['day', 'usd_billed', 'usd_counterfactual'],
        report.usdPerDay.map((r) => [r.day, fmtUsd(r.usdBilled), fmtUsd(r.usdCounterfactual)]),
      ),
    ].join('\n'),
  );

  sections.push(
    [
      md ? '### parse failure rate' : 'parse failure rate:',
      ...renderTable(
        md,
        ['model', 'failures', 'calls', 'rate'],
        report.parseFailureRate.map((r) => [r.model, fmtCount(r.failures), fmtCount(r.calls), fmtFraction(r.rate)]),
      ),
    ].join('\n'),
  );

  sections.push(
    [
      md ? '### slowest calls' : 'slowest calls:',
      ...renderTable(
        md,
        ['id', 'model', 'slot_id', 'latency_ms'],
        report.slowest.map((r) => [r.id, r.model, r.slotId ?? '-', fmtMs(r.latencyMs)]),
      ),
    ].join('\n'),
  );

  sections.push(
    [
      `cache_hit_rate: ${fmtFraction(report.cacheHitRate)}`,
      `skipped_lines: ${fmtCount(report.skippedLines)}`,
      `clue_understood_defaulted: ${fmtCount(report.clueUnderstoodDefaulted)}`,
    ].join('\n'),
  );

  return sections.join('\n\n');
}

/**
 * `--dump` prints only the full matching records, one JSON object per line
 * (acceptance 5), regardless of `--json`/`--md`: that is what the CLI
 * reference means by "print full matching records as JSON, for feeding a
 * parser fixture or debugging a single clue".
 */
async function runInferenceReport(
  opts: ReportOptions,
  global: GlobalOptions,
  overrides: ReportCommandOverrides,
): Promise<void> {
  const reader = await resolveInferenceReader(global, overrides);
  const filters = buildInferenceFilters(opts);

  if (opts.dump) {
    const report = loadInferenceReport(reader, { ...filters, dump: true });
    for (const record of report.records ?? []) {
      console.log(JSON.stringify(record));
    }
    return;
  }

  const report = loadInferenceReport(reader, filters);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(renderInferenceReport(opts.md, report));
}

// ---------------------------------------------------------------------------

export async function reportCommand(
  opts: ReportOptions,
  global: GlobalOptions,
  overrides: ReportCommandOverrides = {},
): Promise<void> {
  if (opts.inference) {
    await runInferenceReport(opts, global, overrides);
    return;
  }
  runRunsReport(opts);
}
