import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliError, ExitCode } from '../../../src/cli/exit.js';
import type { ShowCommandOverrides } from '../../../src/cli/show.js';
import type { GlobalOptions, ShowOptions } from '../../../src/cli/options.js';
import { showCommand } from '../../../src/cli/show.js';
import type { PerSlotRecord, RunRecord } from '../../../src/eval/types.js';
import { ProfileSchema } from '../../../src/profiles/schema.js';

const GLOBAL: GlobalOptions = { color: false };

function options(overrides: Partial<ShowOptions> = {}): ShowOptions {
  return { solution: false, ...overrides };
}

const fixturePath = fileURLToPath(
  new URL('../../../test/fixtures/puzzles/synthetic-5x5.json', import.meta.url),
);

const temps: string[] = [];

/** `<dir>/synthetic/synthetic-5x5.json`, matching the fixture's own `source` field. */
function libraryWithSyntheticFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crossword-cli-show-'));
  temps.push(dir);
  const sourceDir = join(dir, 'synthetic');
  mkdirSync(sourceDir, { recursive: true });
  copyFileSync(fixturePath, join(sourceDir, 'synthetic-5x5.json'));
  return dir;
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
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('showCommand', () => {
  it('prints a grid with # for blocks and . for letters, then Across and Down in number order', async () => {
    const dir = libraryWithSyntheticFixture();

    await showCommand('synthetic-5x5', options(), GLOBAL, { puzzlesDir: dir });

    const output = lines.join('\n');

    // Row 0 of the fixture: two open cells, a block, then two open cells.
    expect(lines[0]).toBe('. . # . .');
    // Row 4: block, open, block, open, open.
    expect(lines[4]).toBe('# . # . .');

    const acrossIndex = lines.indexOf('Across:');
    const downIndex = lines.indexOf('Down:');
    expect(acrossIndex).toBeGreaterThan(-1);
    expect(downIndex).toBeGreaterThan(acrossIndex);

    const acrossLines = lines.slice(acrossIndex + 1, downIndex).filter((l) => l.trim().length > 0);
    const acrossNumbers = acrossLines.map((l) => Number(l.trim().split('.')[0]));
    expect(acrossNumbers).toEqual([...acrossNumbers].sort((a, b) => a - b));
    expect(acrossLines.some((l) => l.includes('Cry of surprise'))).toBe(true);

    const downLines = lines.slice(downIndex + 1).filter((l) => l.trim().length > 0);
    const downNumbers = downLines.map((l) => Number(l.trim().split('.')[0]));
    expect(downNumbers).toEqual([...downNumbers].sort((a, b) => a - b));

    // No solution letter anywhere without --solution.
    expect(output).not.toContain('RAYON');
    expect(output).not.toContain('AVOID');
  });

  it('--solution prints the solution letters', async () => {
    const dir = libraryWithSyntheticFixture();

    await showCommand('synthetic-5x5', options({ solution: true }), GLOBAL, { puzzlesDir: dir });

    // Row 1 of the fixture's solution is R A Y O N.
    expect(lines[1]).toBe('R A Y O N');
  });

  it('exits 3 on an unknown id, with a hint suggesting xw list', async () => {
    const dir = libraryWithSyntheticFixture();

    let caught: unknown;
    try {
      await showCommand('does-not-exist', options(), GLOBAL, { puzzlesDir: dir });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CliError);
    const cliError = caught as CliError;
    expect(cliError.code).toBe(ExitCode.NOT_FOUND);
    expect(cliError.hint).toMatch(/xw list/);
  });
});

// ---------------------------------------------------------------------------
// T59: `xw show --run`.
// ---------------------------------------------------------------------------

const PROFILE = ProfileSchema.parse({ name: 'baseline' });

/** synthetic-5x5.json's own solution, keyed by slot id (see its `cells`). */
const SYNTHETIC_5X5_TRUTH: Readonly<Record<string, string>> = {
  '1A': 'OH',
  '1D': 'ORAL',
  '2D': 'HAVOC',
  '3A': 'PI',
  '3D': 'POISE',
  '4D': 'INDEX',
  '5A': 'RAYON',
  '6D': 'YOU',
  '7A': 'AVOID',
  '8A': 'LOUSE',
  '9A': 'EX',
};

function zeroRejectCounts(): PerSlotRecord['rejectCounts'] {
  return { length: 0, charset: 0, pattern: 0, 'clue-echo': 0, duplicate: 0, 'rejected-before': 0 };
}

function makePerSlot(slotId: string, filled: string | null): PerSlotRecord {
  const truth = SYNTHETIC_5X5_TRUTH[slotId] ?? '';
  return {
    slotId,
    clue: '',
    length: truth.length,
    truth,
    filled,
    correct: filled !== null && filled.toUpperCase() === truth,
    producedBy: filled === null ? null : 1,
    batchIndex: null,
    truthInCandidates: filled !== null,
    truthRank: filled !== null ? 0 : null,
    rejectCounts: zeroRejectCounts(),
    parseFailures: 0,
    latencyMs: 0,
    usd: 0,
    reasks: 0,
    escalated: false,
    candidatesSeen: filled === null ? 0 : 1,
    pickedRank: filled === null ? null : 0,
  };
}

/** Every synthetic-5x5 slot filled with its true answer: identical output to `--solution`. */
function fullSolutionPerSlot(): PerSlotRecord[] {
  return Object.keys(SYNTHETIC_5X5_TRUTH).map((slotId) => {
    const truth = SYNTHETIC_5X5_TRUTH[slotId];
    return makePerSlot(slotId, truth ?? null);
  });
}

function makeRunRecord(runId: string, puzzleId: string, overrides: Partial<RunRecord> = {}): RunRecord {
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
      slots: 11,
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
    perSlot: fullSolutionPerSlot(),
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

function tempRunsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crossword-cli-show-runs-'));
  temps.push(dir);
  return dir;
}

function writeRunRecord(dir: string, record: RunRecord): void {
  writeFileSync(join(dir, `${record.runId}.json`), JSON.stringify(record, null, 2));
}

function libAndRuns(runsDir: string): ShowCommandOverrides {
  return { puzzlesDir: libraryWithSyntheticFixture(), runsDir };
}

describe('showCommand --run', () => {
  it('bare --run renders the most recent run for the puzzle, and the header names it', async () => {
    const runsDir = tempRunsDir();
    const t1 = makeRunRecord('P--baseline--20260901T000000Z--aaaaaaaa', 'synthetic-5x5', {
      timestamp: '2026-09-01T00:00:00.000Z',
      perSlot: [makePerSlot('5A', 'WRONG')],
      accuracy: { letters: 0.1, words: 0, perfect: false, emptyCells: 20 },
    });
    const t2 = makeRunRecord('P--baseline--20260902T000000Z--bbbbbbbb', 'synthetic-5x5', {
      timestamp: '2026-09-02T00:00:00.000Z',
    });
    const q = makeRunRecord('Q--baseline--20260901T000000Z--cccccccc', 'other-puzzle', {
      timestamp: '2026-09-03T00:00:00.000Z',
    });
    writeRunRecord(runsDir, t1);
    writeRunRecord(runsDir, t2);
    writeRunRecord(runsDir, q);

    await showCommand('synthetic-5x5', options({ run: true }), GLOBAL, libAndRuns(runsDir));

    expect(lines[0]).toContain(t2.runId);
    // Header is lines[0]; row 1 of the puzzle's solution (which t2's perSlot
    // fully matches) is R A Y O N, at lines[2] (lines[1] is row 0).
    expect(lines[2]).toBe('R A Y O N');
  });

  it('--run <runId> and --run <unique prefix> render that specific run', async () => {
    const runsDir = tempRunsDir();
    const t1 = makeRunRecord('P--baseline--20260901T000000Z--aaaaaaaa', 'synthetic-5x5', {
      perSlot: [makePerSlot('5A', 'RAYON')],
    });
    const t2 = makeRunRecord('P--baseline--20260902T000000Z--bbbbbbbb', 'synthetic-5x5');
    writeRunRecord(runsDir, t1);
    writeRunRecord(runsDir, t2);

    await showCommand('synthetic-5x5', options({ run: t1.runId }), GLOBAL, libAndRuns(runsDir));
    expect(lines[0]).toContain(t1.runId);
    expect(lines[2]).toBe('R A Y O N');
    // Only 5A was filled in t1: row 0 (lines[1]) has no letters from the run.
    expect(lines[1]).toBe('. . # . .');

    lines = [];
    await showCommand(
      'synthetic-5x5',
      options({ run: 'P--baseline--20260901T000000Z' }),
      GLOBAL,
      libAndRuns(runsDir),
    );
    expect(lines[0]).toContain(t1.runId);
  });

  it('exits 2 naming both ids when the runId belongs to a different puzzle', async () => {
    const runsDir = tempRunsDir();
    const own = makeRunRecord('P--baseline--20260901T000000Z--aaaaaaaa', 'synthetic-5x5');
    const other = makeRunRecord('Q--baseline--20260901T000000Z--dddddddd', 'other-puzzle');
    writeRunRecord(runsDir, own);
    writeRunRecord(runsDir, other);

    let caught: unknown;
    try {
      await showCommand('synthetic-5x5', options({ run: other.runId }), GLOBAL, libAndRuns(runsDir));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CliError);
    const cliError = caught as CliError;
    expect(cliError.code).toBe(ExitCode.USAGE);
    expect(cliError.message).toContain('synthetic-5x5');
    expect(cliError.message).toContain('other-puzzle');
  });

  it('exits 2 listing the candidates for an ambiguous run id prefix', async () => {
    const runsDir = tempRunsDir();
    const a = makeRunRecord('P--baseline--20260901T000000Z--aaaaaaaa', 'synthetic-5x5');
    const b = makeRunRecord('P--baseline--20260901T000000Z--aaaabbbb', 'synthetic-5x5');
    writeRunRecord(runsDir, a);
    writeRunRecord(runsDir, b);

    let caught: unknown;
    try {
      await showCommand(
        'synthetic-5x5',
        options({ run: 'P--baseline--20260901T000000Z--aaaa' }),
        GLOBAL,
        libAndRuns(runsDir),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CliError);
    const cliError = caught as CliError;
    expect(cliError.code).toBe(ExitCode.USAGE);
    expect(cliError.message).toContain(a.runId);
    expect(cliError.message).toContain(b.runId);
  });

  it('exits 3 with a hint pointing at xw solve when the runs dir has no run for the puzzle', async () => {
    const runsDir = tempRunsDir();

    let caught: unknown;
    try {
      await showCommand('synthetic-5x5', options({ run: true }), GLOBAL, libAndRuns(runsDir));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CliError);
    const cliError = caught as CliError;
    expect(cliError.code).toBe(ExitCode.NOT_FOUND);
    expect(cliError.hint).toMatch(/xw solve/);
  });

  it('a run whose filled answers equal the solution renders a grid and clue section byte-identical to --solution', async () => {
    const runsDir = tempRunsDir();
    const record = makeRunRecord('P--baseline--20260901T000000Z--aaaaaaaa', 'synthetic-5x5');
    writeRunRecord(runsDir, record);

    const overrides = libAndRuns(runsDir);
    await showCommand('synthetic-5x5', options({ run: true }), GLOBAL, overrides);
    const runOutput = lines.slice(1).join('\n'); // drop the header line

    lines = [];
    await showCommand('synthetic-5x5', options({ solution: true }), GLOBAL, { puzzlesDir: overrides.puzzlesDir });
    const solutionOutput = lines.join('\n');

    expect(runOutput).toBe(solutionOutput);
  });

  it('a partial run renders blank cells for unfilled slots and does not throw', async () => {
    const runsDir = tempRunsDir();
    const record = makeRunRecord('P--baseline--20260901T000000Z--aaaaaaaa', 'synthetic-5x5', {
      perSlot: [makePerSlot('5A', 'RAYON'), makePerSlot('1A', null)],
      accuracy: { letters: 0.2, words: 0.09, perfect: false, emptyCells: 16 },
    });
    writeRunRecord(runsDir, record);

    await expect(
      showCommand('synthetic-5x5', options({ run: true }), GLOBAL, libAndRuns(runsDir)),
    ).resolves.toBeUndefined();

    // Header is lines[0]; row 1 ("R A Y O N") is lines[2].
    expect(lines[2]).toBe('R A Y O N');
    // 1A ("OH") was left unfilled: row 0 (lines[1]) renders fully blank.
    expect(lines[1]).toBe('. . # . .');
  });

  it('--run combined with --solution exits 2', async () => {
    const runsDir = tempRunsDir();

    let caught: unknown;
    try {
      await showCommand(
        'synthetic-5x5',
        options({ run: true, solution: true }),
        GLOBAL,
        libAndRuns(runsDir),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).code).toBe(ExitCode.USAGE);
  });
});
