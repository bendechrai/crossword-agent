import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { benchCommand } from '../../../src/cli/bench.js';
import type { BenchCommandOverrides } from '../../../src/cli/bench.js';
import { CliError, ExitCode, isCliError } from '../../../src/cli/exit.js';
import type { BenchOptions, GlobalOptions } from '../../../src/cli/options.js';
import type { RunRecord, RunStatus } from '../../../src/eval/types.js';
import type { Profile } from '../../../src/profiles/schema.js';
import type { PuzzleIndexRow } from '../../../src/puzzle/types.js';
import type { SolveOrchestrationDeps, SolveOrchestrationResult } from '../../../src/solver/solve.js';
import type { SolveOptions as SolveRunOptions } from '../../../src/solver/types.js';

const SET_PATH = fileURLToPath(new URL('../../../test/fixtures/sets/tiny.json', import.meta.url));
const JSON_5X5_PATH = fileURLToPath(
  new URL('../../../test/fixtures/puzzles/synthetic-5x5.json', import.meta.url),
);
const JSON_7X7_PATH = fileURLToPath(
  new URL('../../../test/fixtures/puzzles/synthetic-7x7.json', import.meta.url),
);

const GLOBAL: GlobalOptions = { color: false };

function benchOptions(overrides: Partial<BenchOptions> = {}): BenchOptions {
  return {
    profiles: ['baseline'],
    repeat: 1,
    offline: false,
    offlineLenient: false,
    concurrency: 2,
    maxUsd: 25,
    yes: false,
    inferenceLog: false,
    out: 'runs/',
    ...overrides,
  };
}

interface Sink {
  stream: PassThrough;
  text: () => string;
}

function makeSink(): Sink {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

const temps: string[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** `<dir>/synthetic/{synthetic-5x5,synthetic-7x7}.json`, matching tiny.json's puzzle ids. */
function libraryWithSyntheticFixtures(): string {
  const dir = tmpDir('crossword-cli-bench-lib-');
  const sourceDir = join(dir, 'synthetic');
  mkdirSync(sourceDir, { recursive: true });
  copyFileSync(JSON_5X5_PATH, join(sourceDir, 'synthetic-5x5.json'));
  copyFileSync(JSON_7X7_PATH, join(sourceDir, 'synthetic-7x7.json'));
  return dir;
}

/**
 * One `puzzles/index.json` row per given id, as `xw fetch` would have left
 * it: never run, so `bestLetterAccuracy` and `lastRunAt` are still null.
 */
function writeIndex(puzzlesDir: string, ids: readonly string[]): void {
  const rows: PuzzleIndexRow[] = ids.map((id) => ({
    id,
    source: 'synthetic',
    date: null,
    title: null,
    style: 'american',
    width: 5,
    height: 5,
    slotCount: 4,
    files: {
      original: `puzzles/originals/${id}.json`,
      normalised: `puzzles/synthetic/${id}.json`,
    },
    schemaVersion: 1,
    parsedBy: 'xd-crossword-tools',
    addedAt: '2026-01-01T00:00:00.000Z',
    bestLetterAccuracy: null,
    lastRunAt: null,
  }));
  writeFileSync(join(puzzlesDir, 'index.json'), `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
}

function readIndexRows(puzzlesDir: string): PuzzleIndexRow[] {
  return JSON.parse(readFileSync(join(puzzlesDir, 'index.json'), 'utf8')) as PuzzleIndexRow[];
}

/** Every real filesystem location this handler touches, redirected under tmp dirs. */
function baseOverrides(): BenchCommandOverrides {
  return {
    puzzlesDir: libraryWithSyntheticFixtures(),
    cacheDir: tmpDir('crossword-cli-bench-cache-'),
    inferenceLogDir: tmpDir('crossword-cli-bench-inflog-'),
    runsDir: tmpDir('crossword-cli-bench-runs-'),
    env: { NEBIUS_API_KEY: 'test-key' },
    stdout: makeSink().stream,
    stderr: makeSink().stream,
  };
}

interface MockSolveCall {
  deps: SolveOrchestrationDeps;
  profile: Profile;
  opts: SolveRunOptions;
}

interface MockSolve {
  fn: NonNullable<BenchCommandOverrides['solve']>;
  calls: MockSolveCall[];
}

function baseResult(status: RunStatus): SolveOrchestrationResult {
  return {
    status,
    snapshot: { letters: [], assigned: {} },
    accuracy: { letters: 0, words: 0, perfect: false, emptyCells: 0 },
    ac3: { arcsVisited: 0, reductions: 0, wipeouts: [] },
    search: {
      complete: false,
      assigned: 0,
      backtracks: 0,
      discrepancies: 0,
      wipeouts: 0,
      ldsRestarts: 0,
      emptySlotIds: [],
    },
    repair: { proposals: 0, accepted: 0, callsUsed: 0 },
    wallMs: 1,
  };
}

/**
 * A test double for `solve()` (T44) that respects the one contract this
 * handler actually depends on - it emits `run:end` so `RunRecorder.written()`
 * resolves - and otherwise just records what it was called with. Matches the
 * precedent in test/unit/cli/solve.test.ts's own `mockSolve`.
 */
function mockSolve(statusFor: (call: MockSolveCall) => RunStatus = () => 'ok'): MockSolve {
  const calls: MockSolveCall[] = [];
  const fn: NonNullable<BenchCommandOverrides['solve']> = (deps, profile, opts) => {
    const call: MockSolveCall = { deps, profile, opts };
    calls.push(call);
    const status = statusFor(call);
    deps.emit({ type: 'run:end', status, wallMs: 1 });
    return Promise.resolve(baseResult(status));
  };
  return { fn, calls };
}

function readRunRecords(runsDir: string): RunRecord[] {
  return readdirSync(runsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(runsDir, f), 'utf8')) as RunRecord);
}

async function expectCliError(promise: Promise<void>, code: ExitCode): Promise<CliError> {
  try {
    await promise;
  } catch (cause) {
    if (!isCliError(cause)) throw cause;
    expect(cause.code).toBe(code);
    return cause;
  }
  throw new Error('expected benchCommand to reject with a CliError');
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('benchCommand', () => {
  it('acceptance 1: a 2-puzzle x 2-profile x 2-repeat matrix issues 8 runs and writes 8 run records', async () => {
    const { fn, calls } = mockSolve();
    const overrides = baseOverrides();

    await benchCommand(
      SET_PATH,
      benchOptions({ profiles: ['baseline', 'patient'], repeat: 2 }),
      GLOBAL,
      { ...overrides, solve: fn },
    );

    expect(calls).toHaveLength(8);
    const records = readRunRecords(overrides.runsDir as string);
    expect(records).toHaveLength(8);
  });

  it('acceptance 2: sampleIndex (fed by repeatIndex, B1) differs per repeat index for the same (puzzle, profile)', async () => {
    const { fn, calls } = mockSolve();
    const overrides = baseOverrides();

    await benchCommand(SET_PATH, benchOptions({ repeat: 2 }), GLOBAL, { ...overrides, solve: fn });

    const forSynthetic5x5 = calls.filter((c) => c.opts.puzzleId === 'synthetic-5x5');
    expect(forSynthetic5x5).toHaveLength(2);
    const repeatIndices = forSynthetic5x5.map((c) => c.opts.repeatIndex).sort();
    expect(repeatIndices).toEqual([0, 1]);
  });

  it('acceptance 3: a mocked run returning status error continues the matrix and exits 6', async () => {
    const { fn, calls } = mockSolve((call) =>
      call.opts.puzzleId === 'synthetic-7x7' ? 'error' : 'ok',
    );
    const overrides = baseOverrides();

    const cause = await expectCliError(
      benchCommand(SET_PATH, benchOptions(), GLOBAL, { ...overrides, solve: fn }),
      ExitCode.BENCH_PARTIAL,
    );
    expect(cause.code).toBe(6);

    // The matrix continued: every cell still ran and wrote a record.
    expect(calls).toHaveLength(2);
    const records = readRunRecords(overrides.runsDir as string);
    expect(records).toHaveLength(2);
    const erroredRecord = records.find((r) => r.puzzle.id === 'synthetic-7x7');
    expect(erroredRecord?.status).toBe('error');
    const okRecord = records.find((r) => r.puzzle.id === 'synthetic-5x5');
    expect(okRecord?.status).toBe('ok');
  });

  it('acceptance 4: an unknown profile name exits 2 before any run starts', async () => {
    const { fn, calls } = mockSolve();
    const overrides = baseOverrides();

    await expectCliError(
      benchCommand(SET_PATH, benchOptions({ profiles: ['not-a-real-profile'] }), GLOBAL, {
        ...overrides,
        solve: fn,
      }),
      ExitCode.USAGE,
    );

    expect(calls).toHaveLength(0);
  });

  it('acceptance 5a: an estimate above --max-usd without --yes exits 2 and runs nothing', async () => {
    const { fn, calls } = mockSolve();
    const overrides = baseOverrides();

    await expectCliError(
      benchCommand(SET_PATH, benchOptions({ maxUsd: 0.01, yes: false }), GLOBAL, {
        ...overrides,
        solve: fn,
      }),
      ExitCode.USAGE,
    );

    expect(calls).toHaveLength(0);
  });

  it('acceptance 5b: the same estimate with --yes runs the matrix', async () => {
    const { fn, calls } = mockSolve();
    const overrides = baseOverrides();

    await benchCommand(SET_PATH, benchOptions({ maxUsd: 0.01, yes: true }), GLOBAL, {
      ...overrides,
      solve: fn,
    });

    expect(calls).toHaveLength(2);
  });

  it('acceptance 6: exceeding --max-usd mid-matrix aborts the remaining runs and exits 6', async () => {
    const { fn } = mockSolve();
    const calls: MockSolveCall[] = [];
    // Every run bills 0.6 usdCounterfactual on tier1; a ceiling of 1.0 is
    // crossed after the second run, so the remaining two (of four) never
    // start. concurrency: 1 keeps the run order deterministic.
    const wrappedFn: NonNullable<BenchCommandOverrides['solve']> = (deps, profile, opts) => {
      calls.push({ deps, profile, opts });
      deps.emit({
        type: 'llm:usage',
        model: profile.tier1,
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        usdBilled: 0.6,
        usdCounterfactual: 0.6,
        latencyMs: 5,
      });
      return fn(deps, profile, opts);
    };
    const overrides = baseOverrides();

    const cause = await expectCliError(
      benchCommand(SET_PATH, benchOptions({ repeat: 2, concurrency: 1, maxUsd: 1 }), GLOBAL, {
        ...overrides,
        solve: wrappedFn,
      }),
      ExitCode.BENCH_PARTIAL,
    );
    expect(cause.code).toBe(6);

    // 4 cells total (2 puzzles x 1 profile x 2 repeats); the matrix stopped
    // starting new runs once cumulative usdCounterfactual crossed 1.0.
    expect(calls.length).toBeLessThan(4);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('acceptance 7: --concurrency 2 never has more than 2 runs in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const wrappedFn: NonNullable<BenchCommandOverrides['solve']> = (deps, _profile, _opts) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => {
        setTimeout(() => {
          inFlight -= 1;
          deps.emit({ type: 'run:end', status: 'ok', wallMs: 1 });
          resolve(baseResult('ok'));
        }, 10);
      });
    };
    const overrides = baseOverrides();

    await benchCommand(SET_PATH, benchOptions({ repeat: 2, concurrency: 2 }), GLOBAL, {
      ...overrides,
      solve: wrappedFn,
    });

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('acceptance 8: the summary table columns are exactly the documented set', async () => {
    const { fn } = mockSolve();
    const stdout = makeSink();
    const overrides = baseOverrides();

    await benchCommand(SET_PATH, benchOptions(), GLOBAL, {
      ...overrides,
      solve: fn,
      stdout: stdout.stream,
    });

    const lines = stdout.text().trim().split('\n');
    const headerLine = lines.find((line) =>
      line.startsWith('profile\tn\tletters\twords\tperfect\t'),
    );
    expect(headerLine).toBeDefined();
    expect(headerLine?.split('\t')).toEqual([
      'profile',
      'n',
      'letters',
      'words',
      'perfect',
      'usd per puzzle',
      'usd per correct word',
    ]);
  });

  it('upserts bestLetterAccuracy and lastRunAt into puzzles/index.json for every indexed run', async () => {
    const { fn } = mockSolve();
    const overrides = baseOverrides();
    const puzzlesDir = overrides.puzzlesDir as string;
    writeIndex(puzzlesDir, ['synthetic-5x5', 'synthetic-7x7']);

    await benchCommand(SET_PATH, benchOptions(), GLOBAL, { ...overrides, solve: fn });

    const rows = readIndexRows(puzzlesDir);
    expect(rows.map((r) => r.id).sort()).toEqual(['synthetic-5x5', 'synthetic-7x7']);
    const records = readRunRecords(overrides.runsDir as string);
    for (const row of rows) {
      // Both rows started at null; the bench run is what filled them in.
      expect(row.lastRunAt).not.toBeNull();
      const record = records.find((r) => r.puzzle.id === row.id);
      expect(record).toBeDefined();
      expect(row.lastRunAt).toBe(record?.timestamp);
      expect(row.bestLetterAccuracy).toBe(record?.accuracy.letters);
      // Untouched fields survive the upsert.
      expect(row.addedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(row.files.original).toBe(`puzzles/originals/${row.id}.json`);
    }
  });

  it('keeps every index row at concurrency 2 with --repeat 2 (the puzzles/.index.lock case)', async () => {
    const { fn } = mockSolve();
    const overrides = baseOverrides();
    const puzzlesDir = overrides.puzzlesDir as string;
    writeIndex(puzzlesDir, ['synthetic-5x5', 'synthetic-7x7']);

    await benchCommand(SET_PATH, benchOptions({ repeat: 2, concurrency: 2 }), GLOBAL, {
      ...overrides,
      solve: fn,
    });

    const rows = readIndexRows(puzzlesDir);
    expect(rows.map((r) => r.id).sort()).toEqual(['synthetic-5x5', 'synthetic-7x7']);
    expect(rows.every((r) => r.lastRunAt !== null)).toBe(true);
  });

  it('leaves an unindexed library alone rather than fabricating a row', async () => {
    const { fn } = mockSolve();
    const overrides = baseOverrides();
    const puzzlesDir = overrides.puzzlesDir as string;

    await benchCommand(SET_PATH, benchOptions(), GLOBAL, { ...overrides, solve: fn });

    expect(existsSync(join(puzzlesDir, 'index.json'))).toBe(false);
  });

  it('writes runs under the resolved runs directory and honours puzzlesDir', async () => {
    const { fn } = mockSolve();
    const overrides = baseOverrides();

    await benchCommand(SET_PATH, benchOptions(), GLOBAL, { ...overrides, solve: fn });

    expect(existsSync(overrides.runsDir as string)).toBe(true);
    const records = readRunRecords(overrides.runsDir as string);
    expect(records.map((r) => r.puzzle.id).sort()).toEqual(['synthetic-5x5', 'synthetic-7x7']);
  });
});
