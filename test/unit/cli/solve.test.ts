import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliError, ExitCode, offlineMissError } from '../../../src/cli/exit.js';
import type { GlobalOptions, SolveOptions as SolveCliOptions } from '../../../src/cli/options.js';
import { solveCommand } from '../../../src/cli/solve.js';
import type { SolveCommandOverrides } from '../../../src/cli/solve.js';
import * as puzzleLoader from '../../../src/puzzle/loader.js';
import type { Profile } from '../../../src/profiles/schema.js';
import type { SolveOrchestrationDeps, SolveOrchestrationResult } from '../../../src/solver/solve.js';
import type { SolveOptions as SolveRunOptions } from '../../../src/solver/types.js';

const JSON_FIXTURE_PATH = fileURLToPath(
  new URL('../../../test/fixtures/puzzles/synthetic-5x5.json', import.meta.url),
);
const IPUZ_FIXTURE_PATH = fileURLToPath(
  new URL('../../../test/fixtures/puzzles/synthetic-5x5.ipuz', import.meta.url),
);

const GLOBAL: GlobalOptions = { color: false };

function cliOptions(overrides: Partial<SolveCliOptions> = {}): SolveCliOptions {
  return {
    profile: 'baseline',
    verbose: 0,
    watch: false,
    offline: false,
    offlineLenient: false,
    trace: false,
    inferenceLog: true,
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

/** `<dir>/synthetic/synthetic-5x5.json`, matching the fixture's own `source` field. */
function libraryWithSyntheticFixture(): string {
  const dir = tmpDir('crossword-cli-solve-lib-');
  const sourceDir = join(dir, 'synthetic');
  mkdirSync(sourceDir, { recursive: true });
  copyFileSync(JSON_FIXTURE_PATH, join(sourceDir, 'synthetic-5x5.json'));
  return dir;
}

/** Every real filesystem location this handler touches, redirected under tmp dirs. */
function baseOverrides(): SolveCommandOverrides {
  return {
    puzzlesDir: libraryWithSyntheticFixture(),
    cacheDir: tmpDir('crossword-cli-solve-cache-'),
    inferenceLogDir: tmpDir('crossword-cli-solve-inflog-'),
    runsDir: tmpDir('crossword-cli-solve-runs-'),
    env: { NEBIUS_API_KEY: 'test-key' },
    isTty: false,
    stdout: makeSink().stream,
  };
}

interface MockSolveCall {
  deps: SolveOrchestrationDeps;
  profile: Profile;
  opts: SolveRunOptions;
}

interface MockSolve {
  fn: NonNullable<SolveCommandOverrides['solve']>;
  calls: MockSolveCall[];
}

/**
 * A test double for `solve()` (T44) that respects the one contract this
 * handler actually depends on - it emits `run:end` so `RunRecorder.written()`
 * resolves - and otherwise just records what it was called with, per the
 * task's own decision: "its test asserts that by mocking solve() and
 * checking only the wiring".
 */
function mockSolve(resultOverrides: Partial<SolveOrchestrationResult> = {}): MockSolve {
  const calls: MockSolveCall[] = [];
  const fn = (
    deps: SolveOrchestrationDeps,
    profile: Profile,
    opts: SolveRunOptions,
  ): Promise<SolveOrchestrationResult> => {
    calls.push({ deps, profile, opts });
    const status = resultOverrides.status ?? 'ok';
    deps.emit({ type: 'run:end', status, wallMs: 1 });
    return Promise.resolve({
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
      ...resultOverrides,
    });
  };
  return { fn, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('solveCommand', () => {
  it('acceptance 1: resolves the named profile (patient -> reasksPerSlot 3) and passes it to solve()', async () => {
    const { fn, calls } = mockSolve();
    const overrides = baseOverrides();
    const out = join(tmpDir('crossword-cli-solve-out-'), 'run.json');

    await solveCommand(
      'synthetic-5x5',
      cliOptions({ profile: 'patient', out }),
      GLOBAL,
      { ...overrides, solve: fn },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.profile.name).toBe('patient');
    expect(calls[0]?.profile.reasksPerSlot).toBe(3);
  });

  it('acceptance 2a: -vv attaches a ConsoleRenderer at level 2 and no jsonl sink', async () => {
    const stdout = makeSink();
    const { fn, calls } = mockSolve();
    const overrides = baseOverrides();
    const out = join(tmpDir('crossword-cli-solve-out-'), 'run.json');

    await solveCommand(
      'synthetic-5x5',
      cliOptions({ verbose: 2, out }),
      GLOBAL,
      { ...overrides, solve: fn, stdout: stdout.stream },
    );

    expect(calls).toHaveLength(1);
    const runsDir = overrides.runsDir;
    expect(runsDir).toBeDefined();
    const eventsPath = join(runsDir as string, `${calls[0]?.opts.runId}.events.jsonl`);
    expect(existsSync(eventsPath)).toBe(false);
  });

  it('acceptance 2b: -vvv attaches both a ConsoleRenderer and a jsonl sink', async () => {
    const stdout = makeSink();
    let capturedRunId = '';
    const { fn, calls } = mockSolve();
    const wrappedFn: NonNullable<SolveCommandOverrides["solve"]> = (deps, profile, opts) => {
      capturedRunId = opts.runId;
      deps.emit({
        type: 'pattern:built',
        slotId: '1A',
        pattern: '.....',
        regex: '.....',
      });
      deps.emit({
        type: 'llm:request',
        model: profile.tier1,
        slotId: '1A',
        prompt: 'hello',
      });
      return fn(deps, profile, opts);
    };
    const overrides = baseOverrides();
    const out = join(tmpDir('crossword-cli-solve-out-'), 'run.json');

    await solveCommand(
      'synthetic-5x5',
      cliOptions({ verbose: 3, out }),
      GLOBAL,
      { ...overrides, solve: wrappedFn, stdout: stdout.stream },
    );

    expect(calls).toHaveLength(1);

    // Level 3 shows both the level-2 pattern:built line and the level-3
    // llm:request line.
    const text = stdout.text();
    expect(text).toContain('pattern:built');
    expect(text).toContain('llm:request');

    const runsDir = overrides.runsDir as string;
    const eventsPath = join(runsDir, `${capturedRunId}.events.jsonl`);
    expect(existsSync(eventsPath)).toBe(true);
    const lines = readFileSync(eventsPath, 'utf8').trim().split('\n');
    expect(lines.some((line) => line.includes('pattern:built'))).toBe(true);
    expect(lines.some((line) => line.includes('llm:request'))).toBe(true);
  });

  it('acceptance 3: --watch with isTTY false writes one stderr line and renders at level 0', async () => {
    const stdout = makeSink();
    const stderr = makeSink();
    const { fn, calls } = mockSolve();
    const wrappedFn: NonNullable<SolveCommandOverrides["solve"]> = (deps, profile, opts) => {
      // A level-2 event: must not appear in the -watch fallback's level-0 output.
      deps.emit({ type: 'pattern:built', slotId: '1A', pattern: '.....', regex: '.....' });
      return fn(deps, profile, opts);
    };
    const overrides = baseOverrides();
    const out = join(tmpDir('crossword-cli-solve-out-'), 'run.json');

    await solveCommand(
      'synthetic-5x5',
      cliOptions({ watch: true, out }),
      GLOBAL,
      { ...overrides, solve: wrappedFn, isTty: false, stdout: stdout.stream, stderr: stderr.stream },
    );

    expect(calls).toHaveLength(1);

    const stderrLines = stderr.text().split('\n').filter((l) => l.length > 0);
    expect(stderrLines.length).toBe(1);
    expect(stderrLines[0]).toContain('no interactive TTY');

    // ConsoleRenderer(0)-shaped output: "+<ms>ms #<seq> ...".
    const stdoutText = stdout.text();
    expect(stdoutText).toMatch(/^\+\d+ms #\d+/m);
    expect(stdoutText).toContain('run:end');
    // The level-2 event never printed at level 0.
    expect(stdoutText).not.toContain('pattern:built');
  });

  it('acceptance 4a: --offline surfaces an offline-miss CliError (exit 4) naming the cache key and clue', async () => {
    const cause = offlineMissError(
      'offline: no cached response for 1A "A test clue" (cache key deadbeef00)',
      'run once without --offline to populate the cache',
    );
    const { fn } = mockSolve({ status: 'error', error: cause.message, errorCause: cause });
    const overrides = baseOverrides();
    const out = join(tmpDir('crossword-cli-solve-out-'), 'run.json');

    const rejection = solveCommand(
      'synthetic-5x5',
      cliOptions({ offline: true, out }),
      GLOBAL,
      { ...overrides, solve: fn },
    );

    await expect(rejection).rejects.toMatchObject({
      code: ExitCode.OFFLINE_MISS,
    });
    await expect(rejection).rejects.toThrow(/cache key deadbeef00/);
    await expect(rejection).rejects.toThrow(/A test clue/);
  });

  it('acceptance 4b: --offline-lenient degrades to a partial run and exits 0', async () => {
    const { fn, calls } = mockSolve({ status: 'partial' });
    const overrides = baseOverrides();
    const out = join(tmpDir('crossword-cli-solve-out-'), 'run.json');

    await expect(
      solveCommand(
        'synthetic-5x5',
        cliOptions({ offlineLenient: true, out }),
        GLOBAL,
        { ...overrides, solve: fn },
      ),
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts.offlineLenient).toBe(true);
  });

  it('acceptance 5a: xw solve <id> reads the normalised JSON only - the file-format loader is never called', async () => {
    const loadSpy = vi.spyOn(puzzleLoader, 'loadPuzzleWithSolution');
    const { fn, calls } = mockSolve();
    const overrides = baseOverrides();
    const out = join(tmpDir('crossword-cli-solve-out-'), 'run.json');

    await solveCommand('synthetic-5x5', cliOptions({ out }), GLOBAL, { ...overrides, solve: fn });

    expect(calls).toHaveLength(1);
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('acceptance 5b: xw solve <path> parses the file through the file-format loader', async () => {
    const loadSpy = vi.spyOn(puzzleLoader, 'loadPuzzleWithSolution');
    const { fn, calls } = mockSolve();
    const overrides = baseOverrides();
    const out = join(tmpDir('crossword-cli-solve-out-'), 'run.json');

    await solveCommand(IPUZ_FIXTURE_PATH, cliOptions({ out }), GLOBAL, { ...overrides, solve: fn });

    expect(calls).toHaveLength(1);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(calls[0]?.deps.grid.slots.size).toBeGreaterThan(0);
  });

  it('acceptance 6: a missing NEBIUS_API_KEY surfaces the transport\'s provider CliError (exit 5)', async () => {
    const { fn } = mockSolve();
    const overrides = baseOverrides();
    overrides.env = {};
    const out = join(tmpDir('crossword-cli-solve-out-'), 'run.json');

    const rejection = solveCommand(
      'synthetic-5x5',
      cliOptions({ out }),
      GLOBAL,
      { ...overrides, solve: fn },
    );

    await expect(rejection).rejects.toBeInstanceOf(CliError);
    await expect(rejection).rejects.toMatchObject({ code: ExitCode.PROVIDER });
  });

  it('acceptance 7a: the run record is written to --out when given', async () => {
    const { fn, calls } = mockSolve();
    const overrides = baseOverrides();
    const out = join(tmpDir('crossword-cli-solve-out-'), 'my-run.json');

    await solveCommand('synthetic-5x5', cliOptions({ out }), GLOBAL, { ...overrides, solve: fn });

    expect(calls).toHaveLength(1);
    expect(existsSync(out)).toBe(true);
    const record = JSON.parse(readFileSync(out, 'utf8')) as { runId: string };
    expect(record.runId).toBe(calls[0]?.opts.runId);
  });

  it('acceptance 7b: without --out, the run record is written to runs/<runId>.json', async () => {
    const { fn, calls } = mockSolve();
    const overrides = baseOverrides();
    const realRunsDir = process.env['CROSSWORD_RUNS_DIR'];
    const tmpRunsDir = tmpDir('crossword-cli-solve-default-runs-');
    process.env['CROSSWORD_RUNS_DIR'] = tmpRunsDir;

    try {
      await solveCommand('synthetic-5x5', cliOptions(), GLOBAL, { ...overrides, solve: fn });
    } finally {
      if (realRunsDir === undefined) delete process.env['CROSSWORD_RUNS_DIR'];
      else process.env['CROSSWORD_RUNS_DIR'] = realRunsDir;
    }

    expect(calls).toHaveLength(1);
    const runId = calls[0]?.opts.runId;
    expect(runId).toBeDefined();
    expect(existsSync(join(tmpRunsDir, `${runId}.json`))).toBe(true);
  });

  it('acceptance 8: a partial fill exits 0', async () => {
    const { fn, calls } = mockSolve({ status: 'partial' });
    const overrides = baseOverrides();
    const out = join(tmpDir('crossword-cli-solve-out-'), 'run.json');

    await expect(
      solveCommand('synthetic-5x5', cliOptions({ out }), GLOBAL, { ...overrides, solve: fn }),
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts).toBeDefined();
  });

  it('review finding 1: deps.costs() tallies llm:usage events from solve() by tier, not just the seed pass', async () => {
    const { fn, calls } = mockSolve();
    const wrappedFn: NonNullable<SolveCommandOverrides['solve']> = (deps, profile, opts) => {
      // Two calls on tier1 (e.g. seed pass plus a re-ask) and one on tier2
      // (an escalation), exactly as the candidate service's own
      // `callTransport` would emit them straight to the bus - never passing
      // through solve()'s own seed-only `cost` tally.
      deps.emit({
        type: 'llm:usage',
        model: profile.tier1,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        usdBilled: 0.01,
        usdCounterfactual: 0.01,
        latencyMs: 5,
      });
      deps.emit({
        type: 'llm:usage',
        model: profile.tier1,
        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
        usdBilled: 0.008,
        usdCounterfactual: 0.008,
        latencyMs: 6,
      });
      deps.emit({
        type: 'llm:usage',
        model: profile.tier2,
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
        usdBilled: 0.05,
        usdCounterfactual: 0.09,
        latencyMs: 12,
      });
      return fn(deps, profile, opts);
    };
    const overrides = baseOverrides();
    const out = join(tmpDir('crossword-cli-solve-out-'), 'run.json');

    await solveCommand(
      'synthetic-5x5',
      cliOptions({ out }),
      GLOBAL,
      { ...overrides, solve: wrappedFn },
    );

    expect(calls).toHaveLength(1);
    const costs = calls[0]?.deps.costs?.();
    expect(costs?.tier1.calls).toBe(2);
    expect(costs?.tier1.usdBilled).toBeCloseTo(0.018, 10);
    expect(costs?.tier1.usdCounterfactual).toBeCloseTo(0.018, 10);
    expect(costs?.tier2).toEqual({ calls: 1, usdBilled: 0.05, usdCounterfactual: 0.09 });
  });
});
