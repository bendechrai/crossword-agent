import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliError, ExitCode } from '../../../src/cli/exit.js';
import { findRun, latestRun, listRuns } from '../../../src/eval/runs.js';
import type { RunRecord } from '../../../src/eval/types.js';
import { ProfileSchema } from '../../../src/profiles/schema.js';

const PROFILE = ProfileSchema.parse({ name: 'baseline' });

function makeRecord(runId: string, puzzleId: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId,
    timestamp: '2026-09-01T00:00:00.000Z',
    status: 'ok',
    puzzle: {
      id: puzzleId,
      source: 'synthetic',
      style: 'american',
      stratum: 'american',
      size: '5x5',
      slots: 1,
    },
    profile: PROFILE,
    provenance: {
      gitCommit: 'unknown',
      nodeVersion: process.version,
      packageVersion: '0.0.0',
      profileSource: 'builtin',
    },
    repeatIndex: 0,
    seed: null,
    models: { tier1: PROFILE.tier1, tier2: PROFILE.tier2 },
    accuracy: { letters: 1, words: 1, perfect: true, emptyCells: 0 },
    perSlot: [],
    calls: {
      tier1: {
        count: 0,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        usdBilled: 0,
        usdCounterfactual: 0,
        cacheHits: 0,
        avgLatencyMs: 0,
      },
      tier2: {
        count: 0,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        usdBilled: 0,
        usdCounterfactual: 0,
        cacheHits: 0,
        avgLatencyMs: 0,
      },
    },
    search: { backtracks: 0, discrepancies: 0, wipeouts: 0, ac3Reductions: 0 },
    repair: { proposals: 0, accepted: 0 },
    wallMs: 0,
    budgetHits: [],
    ...overrides,
  };
}

const temps: string[] = [];

function tempRunsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crossword-runs-'));
  temps.push(dir);
  return dir;
}

function writeRecord(dir: string, record: RunRecord): void {
  writeFileSync(join(dir, `${record.runId}.json`), JSON.stringify(record, null, 2));
}

afterEach(() => {
  vi.restoreAllMocks();
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('listRuns / latestRun', () => {
  it('returns only the records for the given puzzle id, and latestRun picks the newest timestamp', async () => {
    const dir = tempRunsDir();
    const p1 = makeRecord('P--baseline--20260901T000000Z--aaaaaaaa', 'P', { timestamp: '2026-09-01T00:00:00.000Z' });
    const p2 = makeRecord('P--baseline--20260902T000000Z--bbbbbbbb', 'P', { timestamp: '2026-09-02T00:00:00.000Z' });
    const q1 = makeRecord('Q--baseline--20260901T000000Z--cccccccc', 'Q', { timestamp: '2026-09-01T00:00:00.000Z' });
    writeRecord(dir, p1);
    writeRecord(dir, p2);
    writeRecord(dir, q1);

    const records = await listRuns(dir, 'P');
    expect(records.map((r) => r.runId).sort()).toEqual([p1.runId, p2.runId].sort());

    const latest = await latestRun(dir, 'P');
    expect(latest?.runId).toBe(p2.runId);
  });

  it('latestRun returns null and listRuns returns [] for an empty or missing runs dir', async () => {
    const dir = tempRunsDir();
    expect(await listRuns(dir, 'P')).toEqual([]);
    expect(await latestRun(dir, 'P')).toBeNull();

    // A runs dir that does not exist at all yet.
    expect(await listRuns(join(dir, 'nope'), 'P')).toEqual([]);
    expect(await latestRun(join(dir, 'nope'), 'P')).toBeNull();
  });

  it('skips a non-record JSON file and a .events.jsonl file, warning once, and still returns the valid record', async () => {
    const dir = tempRunsDir();
    const good = makeRecord('P--baseline--20260901T000000Z--aaaaaaaa', 'P');
    writeRecord(dir, good);
    writeFileSync(join(dir, 'not-a-run-record.json'), JSON.stringify({ hello: 'world' }));
    writeFileSync(join(dir, `${good.runId}.events.jsonl`), '{"type":"run:start"}\n{"type":"run:end"}\n');

    const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const records = await listRuns(dir, 'P');

    expect(records).toHaveLength(1);
    expect(records[0]?.runId).toBe(good.runId);
    expect(warnSpy).toHaveBeenCalled();
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('not-a-run-record.json');
    expect(warned).not.toContain('.events.jsonl');
  });
});

describe('findRun', () => {
  it('resolves a full run id', async () => {
    const dir = tempRunsDir();
    const record = makeRecord('P--baseline--20260901T000000Z--aaaaaaaa', 'P');
    writeRecord(dir, record);

    const found = await findRun(dir, record.runId);
    expect(found.runId).toBe(record.runId);
  });

  it('resolves a unique prefix', async () => {
    const dir = tempRunsDir();
    const record = makeRecord('P--baseline--20260901T000000Z--aaaaaaaa', 'P');
    writeRecord(dir, record);

    const found = await findRun(dir, 'P--baseline--20260901T000000Z');
    expect(found.runId).toBe(record.runId);
  });

  it('throws NOT_FOUND when nothing matches', async () => {
    const dir = tempRunsDir();
    writeRecord(dir, makeRecord('P--baseline--20260901T000000Z--aaaaaaaa', 'P'));

    let caught: unknown;
    try {
      await findRun(dir, 'does-not-exist');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).code).toBe(ExitCode.NOT_FOUND);
  });

  it('throws USAGE listing candidates for an ambiguous prefix', async () => {
    const dir = tempRunsDir();
    const a = makeRecord('P--baseline--20260901T000000Z--aaaaaaaa', 'P');
    const b = makeRecord('P--baseline--20260901T000000Z--aaaabbbb', 'P');
    writeRecord(dir, a);
    writeRecord(dir, b);

    let caught: unknown;
    try {
      await findRun(dir, 'P--baseline--20260901T000000Z--aaaa');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CliError);
    const cliError = caught as CliError;
    expect(cliError.code).toBe(ExitCode.USAGE);
    expect(cliError.message).toContain(a.runId);
    expect(cliError.message).toContain(b.runId);
  });

  it('an exact runId match wins even if it would also be an ambiguous prefix of another record', async () => {
    const dir = tempRunsDir();
    const short = makeRecord('P--baseline--20260901T000000Z--aaaaaaaa', 'P');
    const longer = makeRecord('P--baseline--20260901T000000Z--aaaaaaaa-extra', 'P');
    writeRecord(dir, short);
    writeRecord(dir, longer);

    const found = await findRun(dir, short.runId);
    expect(found.runId).toBe(short.runId);
  });
});
