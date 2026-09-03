import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { aggregate } from '../../../src/eval/aggregate.js';
import type { Aggregation } from '../../../src/eval/aggregate.js';
import type { InferenceLogFile, InferenceLogReader } from '../../../src/eval/inference.js';
import type { RunRecord } from '../../../src/eval/types.js';
import { reportCommand } from '../../../src/cli/report.js';
import { ExitCode, isCliError } from '../../../src/cli/exit.js';
import type { GlobalOptions, ReportOptions } from '../../../src/cli/options.js';

const GLOBAL: GlobalOptions = { color: false };

const FIXTURE_DIR = 'test/fixtures/runs/aggregate';
/** Six run-level fixtures: baseline/patient x p1/p2/p3 (T40's own acceptance-1 set). */
const SIX_GLOB = `${FIXTURE_DIR}/*-p*.json`;
/** The four repeat fixtures used for B1's variance-split acceptance. */
const REPEAT_GLOB = `${FIXTURE_DIR}/baseline-r*.json`;

function options(overrides: Partial<ReportOptions> = {}): ReportOptions {
  return {
    runs: SIX_GLOB,
    by: 'profile',
    json: false,
    md: false,
    inference: false,
    dump: false,
    ...overrides,
  };
}

function loadFixture(name: string): RunRecord {
  const url = new URL(`../../fixtures/runs/aggregate/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as RunRecord;
}

const SIX = [
  loadFixture('baseline-p1'),
  loadFixture('baseline-p2'),
  loadFixture('baseline-p3'),
  loadFixture('patient-p1'),
  loadFixture('patient-p2'),
  loadFixture('patient-p3'),
];

function inferenceFixtureText(name: string): string {
  const url = new URL(`../../fixtures/inference/${name}`, import.meta.url);
  return readFileSync(url, 'utf8');
}

function inferenceReaderFor(...names: string[]): InferenceLogReader {
  const files: InferenceLogFile[] = names.map((name) => ({
    path: `logs/inference/${name}`,
    text: inferenceFixtureText(name),
  }));
  return () => files;
}

let lines: string[];

beforeEach(() => {
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reportCommand: run records', () => {
  it('1. --by profile --md matches a committed golden table (header and row order)', async () => {
    await reportCommand(options({ md: true }), GLOBAL);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      [
        '| group | n | letters_mean | letters_stdev | words_mean | words_stdev | perfect_mean | perfect_stdev | usd_per_puzzle | usd_per_correct_word | tier2_share | mean_wall_ms | budget_hits |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        '| baseline | 3 | 0.9000 | 0.1000 | 0.8000 | 0.2000 | 0.3333 | 0.5774 | 0.100000 | 0.075000 | 0.2857 | 1200 | usd:1 |',
        '| patient | 3 | 0.9333 | 0.0764 | 0.8667 | 0.1528 | 0.3333 | 0.5774 | 0.070000 | 0.052500 | 0.1875 | 1000 | tokens:1 |',
      ].join('\n'),
    );
  });

  it('2. --json parses and deep-equals the Aggregation object', async () => {
    await reportCommand(options({ json: true }), GLOBAL);

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '{}') as Aggregation;
    const expected = aggregate(SIX, { by: 'profile' });
    expect(parsed).toEqual(expected);
  });

  it('3a. --by stratum renders the two strata', async () => {
    await reportCommand(options({ by: 'stratum' }), GLOBAL);

    expect(lines).toHaveLength(1);
    const rows = (lines[0] ?? '').split('\n');
    const groupCells = rows.slice(1).map((row) => row.trim().split(/\s{2,}/)[0]);
    expect(groupCells.sort()).toEqual(['american', 'cryptic']);
  });

  it('3b. --by batchIndex renders one row per index', async () => {
    await reportCommand(options({ by: 'batchIndex' }), GLOBAL);

    expect(lines).toHaveLength(1);
    const rows = (lines[0] ?? '').split('\n');
    const groupCells = rows.slice(1).map((row) => row.trim().split(/\s{2,}/)[0]);
    // '3D' carries batchIndex: null in two fixtures and must not appear as its
    // own group; the surviving groups sort numerically ('0' before '1').
    expect(groupCells).toEqual(['0', '1']);
  });

  it('4a. --compare baseline,patient prints a delta column', async () => {
    await reportCommand(options({ compare: ['baseline', 'patient'] }), GLOBAL);

    expect(lines).toHaveLength(1);
    const text = lines[0] ?? '';
    expect(text).toContain('compare: baseline vs patient');
    expect(text).toContain('metric');
    expect(text).toContain('delta');
    expect(text).toContain('meanWallMs');
    // b (patient, 1000) - a (baseline, 1200) = -200.
    expect(text).toMatch(/meanWallMs\s+1200\s+1000\s+-200/);
  });

  it('4b. --compare baseline (a single name) exits 2', async () => {
    await expect(reportCommand(options({ compare: ['baseline'] }), GLOBAL)).rejects.toSatisfy(
      (err: unknown) => isCliError(err) && err.code === ExitCode.USAGE,
    );
  });

  it('5. with repeat fixtures, splitVariance is detected and within/across variance columns appear', async () => {
    await reportCommand(options({ runs: REPEAT_GLOB, md: true }), GLOBAL);

    expect(lines).toHaveLength(1);
    const text = lines[0] ?? '';
    expect(text).toContain('within_puzzle_variance');
    expect(text).toContain('across_puzzle_variance');
    // rx: [0.9, 0.7] -> sample variance 0.02; ry: [0.6, 0.6] -> sample variance 0.
    // withinPuzzle = mean(0.02, 0) = 0.01. Puzzle means [0.8, 0.6] -> acrossPuzzle 0.02.
    expect(text).toContain('| baseline | 4 |');
    expect(text).toMatch(/\| 0\.0100 \| 0\.0200 \|$/m);
  });

  it('6. a zero-match glob prints the glob in the message and exits 3', async () => {
    await expect(
      reportCommand(options({ runs: `${FIXTURE_DIR}/does-not-exist-*.json` }), GLOBAL),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        isCliError(err) &&
        err.code === ExitCode.NOT_FOUND &&
        err.message === `no run records matched ${FIXTURE_DIR}/does-not-exist-*.json`
      );
    });
  });

  it('7. rendering the same fixture set twice produces byte-identical output', async () => {
    await reportCommand(options({ md: true }), GLOBAL);
    const first = lines[0];
    lines = [];
    await reportCommand(options({ md: true }), GLOBAL);
    const second = lines[0];

    expect(first).toBeDefined();
    expect(first).toBe(second);
  });

  it('groups by producing tier at slot granularity, sorted numerically with non-numeric groups last', async () => {
    await reportCommand(options({ by: 'tier', md: true }), GLOBAL);

    expect(lines).toHaveLength(1);
    const rows = (lines[0] ?? '').split('\n').slice(2);
    const groupCells = rows.map((row) => row.split('|')[1]?.trim());
    expect(groupCells).toEqual(['1', '2', 'wordlist']);
  });

  it('plain-table mode (neither --json nor --md) prints a padded, non-markdown table', async () => {
    await reportCommand(options(), GLOBAL);

    expect(lines).toHaveLength(1);
    const text = lines[0] ?? '';
    expect(text).not.toContain('|');
    expect(text.split('\n')[0]).toMatch(/^group\s+n\s+letters_mean/);
  });
});

describe('reportCommand: --inference', () => {
  function inferenceOptions(overrides: Partial<ReportOptions> = {}): ReportOptions {
    return options({ inference: true, ...overrides });
  }

  it('5. --dump --run runX prints only records for run X, one JSON object per line', async () => {
    await reportCommand(
      inferenceOptions({ dump: true, run: 'runX' }),
      GLOBAL,
      { inferenceReader: inferenceReaderFor('filters.jsonl') },
    );

    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { runId: string | null };
      expect(parsed.runId).toBe('runX');
    }
    expect(lines.map((l) => (JSON.parse(l) as { id: string }).id).sort()).toEqual([
      'filt-1',
      'filt-3',
      'filt-5',
    ]);
  });

  it('prints callsPerModelPerDay, usdPerDay, parseFailureRate, cacheHitRate, slowest, skippedLines and clueUnderstoodDefaulted', async () => {
    await reportCommand(inferenceOptions({ md: true }), GLOBAL, {
      inferenceReader: inferenceReaderFor('basic10.jsonl'),
    });

    expect(lines).toHaveLength(1);
    const text = lines[0] ?? '';
    expect(text).toContain('calls per model per day');
    expect(text).toContain('usd per day');
    expect(text).toContain('parse failure rate');
    expect(text).toContain('slowest calls');
    expect(text).toContain('cache_hit_rate: 0.2000');
    expect(text).toContain('skipped_lines: 0');
    expect(text).toContain('clue_understood_defaulted: 1');
  });

  it('--json prints the InferenceReport (without records, since --dump was not given)', async () => {
    await reportCommand(inferenceOptions({ json: true }), GLOBAL, {
      inferenceReader: inferenceReaderFor('basic10.jsonl'),
    });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '{}') as { records?: unknown; skippedLines: number };
    expect(parsed.records).toBeUndefined();
    expect(parsed.skippedLines).toBe(0);
  });

  it('--since/--until normalise to YYYY-MM-DD and filter inclusively', async () => {
    await reportCommand(inferenceOptions({ json: true, since: '2026-01-02' }), GLOBAL, {
      inferenceReader: inferenceReaderFor('basic10.jsonl'),
    });

    const parsed = JSON.parse(lines[0] ?? '{}') as { callsPerModelPerDay: Array<{ day: string }> };
    expect(parsed.callsPerModelPerDay.every((r) => r.day === '2026-01-02')).toBe(true);
  });

  it('a malformed log line is skipped and reported in skippedLines', async () => {
    await reportCommand(inferenceOptions({ json: true }), GLOBAL, {
      inferenceReader: inferenceReaderFor('malformed.jsonl'),
    });

    const parsed = JSON.parse(lines[0] ?? '{}') as { skippedLines: number };
    expect(parsed.skippedLines).toBe(1);
  });
});
