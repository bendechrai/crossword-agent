import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  aggregateInference,
  loadInferenceReport,
  readInferenceLog,
  type InferenceLogFile,
  type InferenceLogReader,
} from '../../../src/eval/inference.js';
import type { InferenceLogRecord } from '../../../src/llm/types.js';

function fixturePath(name: string): URL {
  return new URL(`../../fixtures/inference/${name}`, import.meta.url);
}

function fixtureText(name: string): string {
  return readFileSync(fixturePath(name), 'utf8');
}

function readerFor(...names: string[]): InferenceLogReader {
  const files: InferenceLogFile[] = names.map((name) => ({
    path: `logs/inference/${name}`,
    text: fixtureText(name),
  }));
  return () => files;
}

function recordsFrom(name: string): InferenceLogRecord[] {
  return fixtureText(name)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as InferenceLogRecord);
}

describe('aggregateInference', () => {
  it('1. groups a 10-record fixture spanning two dates into two days with the right call counts and USD totals', () => {
    const records = recordsFrom('basic10.jsonl');
    const report = aggregateInference(records, {});

    expect(report.callsPerModelPerDay).toEqual([
      { day: '2026-01-01', model: 'nvidia/Nemotron-3_5-Lightning', calls: 5 },
      { day: '2026-01-02', model: 'nvidia/Nemotron-3_5-Lightning', calls: 5 },
    ]);

    expect(report.usdPerDay).toHaveLength(2);
    const day1 = report.usdPerDay.find((d) => d.day === '2026-01-01');
    const day2 = report.usdPerDay.find((d) => d.day === '2026-01-02');
    expect(day1?.usdBilled).toBeCloseTo(0.0046, 6);
    expect(day1?.usdCounterfactual).toBeCloseTo(0.0057, 6);
    expect(day2?.usdBilled).toBeCloseTo(0.0047, 6);
    expect(day2?.usdCounterfactual).toBeCloseTo(0.0056, 6);
  });

  it('2. computes a parse-failure rate of 0.25 (2 failures of 8 non-cache-hit calls), unaffected by the 2 cache hits', () => {
    const records = recordsFrom('basic10.jsonl');
    const report = aggregateInference(records, {});

    expect(report.parseFailureRate).toEqual([
      { model: 'nvidia/Nemotron-3_5-Lightning', failures: 2, calls: 8, rate: 0.25 },
    ]);
  });

  it('3. computes a cache-hit rate of 2/10', () => {
    const records = recordsFrom('basic10.jsonl');
    const report = aggregateInference(records, {});

    expect(report.cacheHitRate).toBeCloseTo(0.2, 10);
  });

  it('4. returns exactly 20 slowest calls, sorted descending by latencyMs, for a 30-record fixture', () => {
    const records = recordsFrom('slowest30.jsonl');
    const report = aggregateInference(records, {});

    expect(report.slowest).toHaveLength(20);
    const latencies = report.slowest.map((r) => r.latencyMs);
    const sorted = [...latencies].sort((a, b) => b - a);
    expect(latencies).toEqual(sorted);

    const allLatencies = records.map((r) => r.latencyMs as number).sort((a, b) => b - a);
    expect(latencies).toEqual(allLatencies.slice(0, 20));
  });

  it('5. --model and --run filters each reduce the set to the expected ids', () => {
    const records = recordsFrom('filters.jsonl');

    const byModel = aggregateInference(records, { model: 'modelA', dump: true });
    expect((byModel.records ?? []).map((r) => r.id).sort()).toEqual(['filt-1', 'filt-2', 'filt-5']);

    const byRun = aggregateInference(records, { run: 'runX', dump: true });
    expect((byRun.records ?? []).map((r) => r.id).sort()).toEqual(['filt-1', 'filt-3', 'filt-5']);

    const bySlot = aggregateInference(records, { slot: 's4', dump: true });
    expect((bySlot.records ?? []).map((r) => r.id)).toEqual(['filt-4']);
  });

  it('6. --since/--until are inclusive and filter on the record UTC date', () => {
    const records = recordsFrom('basic10.jsonl');

    const sinceDay2 = aggregateInference(records, { since: '2026-01-02', dump: true });
    expect((sinceDay2.records ?? []).map((r) => r.id).sort()).toEqual([
      'rec-06',
      'rec-07',
      'rec-08',
      'rec-09',
      'rec-10',
    ]);

    const untilDay1 = aggregateInference(records, { until: '2026-01-01', dump: true });
    expect((untilDay1.records ?? []).map((r) => r.id).sort()).toEqual([
      'rec-01',
      'rec-02',
      'rec-03',
      'rec-04',
      'rec-05',
    ]);

    const onlyDay2 = aggregateInference(records, {
      since: '2026-01-02',
      until: '2026-01-02',
      dump: true,
    });
    expect((onlyDay2.records ?? []).map((r) => r.id)).toHaveLength(5);

    const both = aggregateInference(records, {
      since: '2026-01-01',
      until: '2026-01-02',
      dump: true,
    });
    expect((both.records ?? []).map((r) => r.id)).toHaveLength(10);
  });

  it('7. reports skippedLines: 1 for a fixture with one malformed line and still aggregates the rest', () => {
    const { records, skippedLines } = readInferenceLog(readerFor('malformed.jsonl'));
    expect(skippedLines).toBe(1);
    expect(records).toHaveLength(3);

    const report = loadInferenceReport(readerFor('malformed.jsonl'), {});
    expect(report.skippedLines).toBe(1);
    expect(report.cacheHitRate).toBe(0);
  });

  it('8. --dump output round-trips: every returned object deep-equals the fixture line it came from', () => {
    const raw = fixtureText('basic10.jsonl')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as InferenceLogRecord);

    const report = aggregateInference(raw, { dump: true });
    expect(report.records).toBeDefined();
    expect(report.records).toHaveLength(raw.length);

    const byId = new Map(raw.map((r) => [r.id, r]));
    for (const record of report.records ?? []) {
      expect(record).toEqual(byId.get(record.id));
    }
  });

  it('excludes a null parsed value (a parse failure) from the clue_understood-defaulted count', () => {
    const records = recordsFrom('basic10.jsonl');
    const report = aggregateInference(records, {});
    // Only rec-02 carries parsed.clue_understood === 0; the two parse
    // failures (parsed: null) and the two cache hits (0.55, 0.4) do not
    // contribute.
    expect(report.clueUnderstoodDefaulted).toBe(1);
  });

  it('readInferenceLog reads across multiple files handed back by the injected reader', () => {
    const { records, skippedLines } = readInferenceLog(readerFor('filters.jsonl', 'slowest30.jsonl'));
    expect(skippedLines).toBe(0);
    expect(records).toHaveLength(6 + 30);
  });
});
