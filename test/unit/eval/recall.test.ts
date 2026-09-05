import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  parseRecallArgs,
  parsePuzzleSet,
  runRecall,
} from '../../../scripts/eval-recall.js';
import type { RecallArgs, RecallOverrides } from '../../../scripts/eval-recall.js';
import { ExitCode, isCliError } from '../../../src/cli/exit.js';
import {
  ASSUMED_SEED_COMPLETION_TOKENS,
  ASSUMED_SEED_PROMPT_TOKENS,
  aggregateRecall,
  estimateRecallUsd,
  modelSlug,
  renderRecallMarkdown,
  renderRecallTable,
} from '../../../src/eval/recall.js';
import type { PuzzleRecallRecord, SlotRecallRecord } from '../../../src/eval/recall.js';
import type { LlmRequest, LlmResult, LlmTransport } from '../../../src/llm/types.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE = join(ROOT, 'test/fixtures/recall/two-models.json');
const MODELS_MIN = join(ROOT, 'test/fixtures/models.min.json');
const TINY_SET = join(ROOT, 'test/fixtures/sets/tiny.json');
const CACHE_FIXTURES = join(ROOT, 'test/fixtures/cache');

const TIER1 = 'nvidia/Nemotron-3_5-Lightning';
const TIER2 = 'deepseek-ai/DeepSeek-V4-Pro';

const temps: string[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function loadFixture(): PuzzleRecallRecord[] {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as PuzzleRecallRecord[];
}

function near(actual: number, expected: number): void {
  expect(actual).toBeCloseTo(expected, 9);
}

// ---------------------------------------------------------------------------
// Acceptance 1: aggregate() over a hand-written fixture with two models and
// mixed strata.
// ---------------------------------------------------------------------------

describe('aggregateRecall', () => {
  it('produces the expected shares, ranks and cost for two models over mixed strata', () => {
    const aggregation = aggregateRecall(loadFixture());

    expect(aggregation.byModel.map((row) => row.model)).toEqual([TIER1, 'Qwen/Qwen3-32B']);

    const lightning = aggregation.byModel[0];
    expect(lightning).toBeDefined();
    if (lightning === undefined) return;
    expect(lightning.puzzles).toBe(2);
    expect(lightning.slots).toBe(6);
    // 1A, 2A and 1D carried the truth; 3A, 4A and 2D did not.
    near(lightning.truthInCandidatesShare, 0.5);
    // 1A and 1D had it at rank 0.
    near(lightning.top1Share, 2 / 6);
    near(lightning.meanCandidatesSeen, 2);
    near(lightning.meanRawCandidates, 20 / 6);
    // 4 of 8 rejections were length errors.
    near(lightning.lengthErrorShare, 0.5);
    near(lightning.parseFailureRate, 1 / 6);
    near(lightning.zeroCandidateShare, 1 / 6);
    // The cache-hit slot (2D) waited on nobody and is left out of the mean.
    near(lightning.meanLatencyMs, 300);
    near(lightning.usdPerPuzzle, 0.004);
    // ... and cost nothing, so billed and counterfactual differ (B2).
    near(lightning.usdBilledPerPuzzle, 0.003);

    const qwen = aggregation.byModel[1];
    expect(qwen).toBeDefined();
    if (qwen === undefined) return;
    near(qwen.truthInCandidatesShare, 5 / 6);
    near(qwen.top1Share, 0.5);
    near(qwen.meanCandidatesSeen, 26 / 6);
    near(qwen.lengthErrorShare, 2 / 6);
    near(qwen.parseFailureRate, 0);
    near(qwen.zeroCandidateShare, 0);
    near(qwen.meanLatencyMs, 6400 / 6);
    near(qwen.usdPerPuzzle, 0.015);
    near(qwen.usdBilledPerPuzzle, 0.015);
  });

  it('splits the same slots by stratum', () => {
    const { byModelStratum } = aggregateRecall(loadFixture());
    expect(byModelStratum.map((row) => row.group)).toEqual([
      `${TIER1} / american`,
      `${TIER1} / cryptic`,
      'Qwen/Qwen3-32B / american',
      'Qwen/Qwen3-32B / cryptic',
    ]);

    const lightningAmerican = byModelStratum[0];
    expect(lightningAmerican).toBeDefined();
    if (lightningAmerican === undefined) return;
    expect(lightningAmerican.puzzles).toBe(1);
    expect(lightningAmerican.slots).toBe(4);
    near(lightningAmerican.truthInCandidatesShare, 0.5);
    near(lightningAmerican.top1Share, 0.25);
    near(lightningAmerican.meanCandidatesSeen, 2.25);
    near(lightningAmerican.lengthErrorShare, 0.5);
    near(lightningAmerican.parseFailureRate, 0.25);
    near(lightningAmerican.zeroCandidateShare, 0.25);
    near(lightningAmerican.meanLatencyMs, 250);
    near(lightningAmerican.usdPerPuzzle, 0.004);

    const qwenAmerican = byModelStratum[2];
    expect(qwenAmerican).toBeDefined();
    if (qwenAmerican === undefined) return;
    near(qwenAmerican.truthInCandidatesShare, 1);
    near(qwenAmerican.lengthErrorShare, 0);
    near(qwenAmerican.usdPerPuzzle, 0.02);
  });

  it('ranks on the american stratum first and usd per puzzle second', () => {
    const { ranking } = aggregateRecall(loadFixture());
    expect(ranking.map((row) => [row.rank, row.model, row.carry])).toEqual([
      [1, 'Qwen/Qwen3-32B', true],
      [2, TIER1, true],
    ]);
    const first = ranking[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    near(first.americanTruthInCandidatesShare ?? -1, 1);
    near(first.usdPerPuzzle, 0.015);
  });

  it('breaks a tie on the american share with usd per puzzle', () => {
    const records = loadFixture().filter((record) => record.stratum === 'american');
    const cheap: PuzzleRecallRecord = {
      ...structuredClone(records[0] as PuzzleRecallRecord),
      model: 'cheap-twin',
    };
    const dear: PuzzleRecallRecord = {
      ...structuredClone(records[0] as PuzzleRecallRecord),
      model: 'dear-twin',
      slots: (records[0] as PuzzleRecallRecord).slots.map((slot) => ({
        ...structuredClone(slot),
        usdCounterfactual: slot.usdCounterfactual * 10,
      })),
    };
    const { ranking } = aggregateRecall([dear, cheap]);
    expect(ranking.map((row) => row.model)).toEqual(['cheap-twin', 'dear-twin']);
  });

  it('ranks a model with no american slots after every model that has some', () => {
    const crypticOnly = loadFixture()
      .filter((record) => record.stratum === 'cryptic')
      .map((record) => ({ ...record, model: `${record.model}-cryptic-only` }));
    // The cryptic-only clones score 0.5 and 0.5 overall, above Lightning's
    // american 0.5-tie only if the rule ignored the stratum - it must not.
    const { ranking } = aggregateRecall([...loadFixture(), ...crypticOnly]);
    const withAmerican = ranking.filter((row) => row.americanTruthInCandidatesShare !== null);
    const without = ranking.filter((row) => row.americanTruthInCandidatesShare === null);
    expect(withAmerican).toHaveLength(2);
    expect(without).toHaveLength(2);
    expect(Math.max(...withAmerican.map((row) => row.rank))).toBeLessThan(
      Math.min(...without.map((row) => row.rank)),
    );
  });

  it('returns zeroed rows rather than NaN for an empty screen', () => {
    const aggregation = aggregateRecall([]);
    expect(aggregation.byModel).toEqual([]);
    expect(aggregation.ranking).toEqual([]);
  });

  it('never divides by zero when a group rejected nothing', () => {
    const record = loadFixture()[2];
    expect(record).toBeDefined();
    if (record === undefined) return;
    const noRejects: PuzzleRecallRecord = {
      ...structuredClone(record),
      slots: record.slots.map((slot): SlotRecallRecord => ({
        ...structuredClone(slot),
        rejectCounts: {
          length: 0,
          charset: 0,
          pattern: 0,
          'clue-echo': 0,
          duplicate: 0,
          'rejected-before': 0,
        },
      })),
    };
    const row = aggregateRecall([noRejects]).byModel[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.lengthErrorShare).toBe(0);
  });
});

describe('renderRecallTable and renderRecallMarkdown', () => {
  it('renders every required column, tab separated', () => {
    const aggregation = aggregateRecall(loadFixture());
    const lines = renderRecallTable(aggregation.byModel).split('\n');
    expect(lines[0]?.split('\t')).toEqual([
      'group',
      'slots',
      'truth-in-candidates',
      'top-1',
      'mean candidates',
      'length-error share',
      'parse-failure rate',
      'zero-candidate share',
      'mean latency ms',
      'usd per puzzle',
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[1]?.split('\t')[0]).toBe(TIER1);
    expect(lines[1]?.split('\t')[2]).toBe('0.5000');
  });

  it('writes the decision rule into the markdown summary', () => {
    const markdown = renderRecallMarkdown(aggregateRecall(loadFixture()), {
      setName: 'fixture',
      models: [TIER1, 'Qwen/Qwen3-32B'],
      repeat: 1,
      generatedAt: '2026-09-05T00:00:00.000Z',
      currentTier1: TIER1,
      offline: true,
    });
    expect(markdown).toContain('# Seed-only candidate recall screen');
    expect(markdown).toContain('truth-in-candidates share on the american stratum');
    expect(markdown).toContain('| 1 | Qwen/Qwen3-32B |');
    expect(markdown).toContain('## By model and stratum');
    // ASCII only, per the repo rule.
    expect(/^[\t\n\x20-\x7e]*$/.test(markdown)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Acceptance 2: the estimate formula, priced from a fixture catalogue.
// ---------------------------------------------------------------------------

describe('estimateRecallUsd', () => {
  it('is slots x models x repeats x assumed tokens x price', () => {
    const estimate = estimateRecallUsd({
      slots: 40,
      models: [TIER1, TIER2],
      repeat: 3,
      pricingPath: MODELS_MIN,
    });
    expect(estimate.callsPerModel).toBe(120);

    // test/fixtures/models.min.json: Lightning 6e-8 prompt / 2.4e-7
    // completion, DeepSeek 1.75e-6 / 3.5e-6, both with a zero per-request
    // price.
    const promptTokens = 120 * ASSUMED_SEED_PROMPT_TOKENS;
    const completionTokens = 120 * ASSUMED_SEED_COMPLETION_TOKENS;
    const lightning = promptTokens * 6e-8 + completionTokens * 2.4e-7;
    const deepseek = promptTokens * 1.75e-6 + completionTokens * 3.5e-6;
    expect(estimate.perModel.map((row) => row.model)).toEqual([TIER1, TIER2]);
    near(estimate.perModel[0]?.usd ?? -1, Math.round(1e9 * lightning) / 1e9);
    near(estimate.perModel[1]?.usd ?? -1, Math.round(1e9 * deepseek) / 1e9);
    near(estimate.totalUsd, Math.round(1e9 * (lightning + deepseek)) / 1e9);
  });

  it('scales linearly in slots, models and repeats', () => {
    const one = estimateRecallUsd({ slots: 10, models: [TIER1], repeat: 1, pricingPath: MODELS_MIN });
    const six = estimateRecallUsd({
      slots: 20,
      models: [TIER1, TIER1],
      repeat: 3,
      pricingPath: MODELS_MIN,
    });
    near(six.totalUsd, one.totalUsd * 12);
  });

  it('honours an explicit tokens-per-call assumption', () => {
    const doubled = estimateRecallUsd({
      slots: 10,
      models: [TIER1],
      repeat: 1,
      promptTokens: 2 * ASSUMED_SEED_PROMPT_TOKENS,
      completionTokens: 2 * ASSUMED_SEED_COMPLETION_TOKENS,
      pricingPath: MODELS_MIN,
    });
    const plain = estimateRecallUsd({ slots: 10, models: [TIER1], repeat: 1, pricingPath: MODELS_MIN });
    near(doubled.totalUsd, plain.totalUsd * 2);
  });
});

describe('modelSlug', () => {
  it('turns a model id into one safe path segment', () => {
    expect(modelSlug(TIER1)).toBe('nvidia-Nemotron-3_5-Lightning');
    expect(modelSlug('Qwen/Qwen3-32B')).toBe('Qwen-Qwen3-32B');
    expect(modelSlug('a b/c')).toBe('a-b-c');
  });
});

// ---------------------------------------------------------------------------
// The runner: argument parsing.
// ---------------------------------------------------------------------------

describe('parseRecallArgs', () => {
  it('parses the documented invocation', () => {
    const args = parseRecallArgs([
      '--set',
      'sets/modern-12.json',
      '--models',
      `${TIER1},Qwen/Qwen3-32B`,
      '--repeat',
      '2',
      '--max-usd',
      '3.5',
      '--out',
      'logs/recall',
    ]);
    expect(args.set).toBe('sets/modern-12.json');
    expect(args.models).toEqual([TIER1, 'Qwen/Qwen3-32B']);
    expect(args.repeat).toBe(2);
    expect(args.maxUsd).toBe(3.5);
    expect(args.out).toBe('logs/recall');
  });

  it('defaults repeat, max-usd, out, concurrency and the base profile', () => {
    const args = parseRecallArgs(['--set', 'x.json', '--models', TIER1]);
    expect(args.repeat).toBe(1);
    expect(args.maxUsd).toBe(10);
    expect(args.out).toBe('logs/recall');
    expect(args.concurrency).toBe(2);
    expect(args.profile).toBe('baseline');
    expect(args.yes).toBe(false);
    expect(args.offline).toBe(false);
    expect(args.inferenceLog).toBe(true);
  });

  it('accepts the boolean flags', () => {
    const args = parseRecallArgs([
      '--set',
      'x.json',
      '--models',
      TIER1,
      '--yes',
      '--offline',
      '--no-inference-log',
    ]);
    expect(args.yes).toBe(true);
    expect(args.offline).toBe(true);
    expect(args.inferenceLog).toBe(false);
  });

  it('trims and drops empty entries in --models', () => {
    const args = parseRecallArgs(['--set', 'x.json', '--models', ` ${TIER1} , ,Qwen/Qwen3-32B`]);
    expect(args.models).toEqual([TIER1, 'Qwen/Qwen3-32B']);
  });

  const bad: Array<[string, string[]]> = [
    ['no --set', ['--models', TIER1]],
    ['no --models', ['--set', 'x.json']],
    ['an empty --models list', ['--set', 'x.json', '--models', ' , ']],
    ['a duplicate model', ['--set', 'x.json', '--models', `${TIER1},${TIER1}`]],
    ['a zero --repeat', ['--set', 'x.json', '--models', TIER1, '--repeat', '0']],
    ['a fractional --repeat', ['--set', 'x.json', '--models', TIER1, '--repeat', '1.5']],
    ['a negative --max-usd', ['--set', 'x.json', '--models', TIER1, '--max-usd', '-1']],
    ['a missing flag value', ['--set', '--models', TIER1]],
    ['an unknown flag', ['--set', 'x.json', '--models', TIER1, '--wat']],
  ];

  for (const [label, argv] of bad) {
    it(`exits with USAGE on ${label}`, () => {
      let thrown: unknown;
      try {
        parseRecallArgs(argv);
      } catch (cause) {
        thrown = cause;
      }
      expect(isCliError(thrown)).toBe(true);
      if (isCliError(thrown)) expect(thrown.code).toBe(ExitCode.USAGE);
    });
  }
});

describe('parsePuzzleSet', () => {
  it('accepts the bench set shape', () => {
    const set = parsePuzzleSet(
      { name: 'tiny', puzzles: [{ id: 'a', stratum: 'american' }] },
      'inline',
    );
    expect(set.name).toBe('tiny');
    expect(set.puzzles).toEqual([{ id: 'a', stratum: 'american' }]);
  });

  const malformed: Array<[string, unknown]> = [
    ['a non-object', 'nope'],
    ['a missing name', { puzzles: [{ id: 'a', stratum: 'american' }] }],
    ['an empty puzzle list', { name: 'x', puzzles: [] }],
    ['a bad stratum', { name: 'x', puzzles: [{ id: 'a', stratum: 'quick' }] }],
    ['a missing id', { name: 'x', puzzles: [{ stratum: 'american' }] }],
  ];

  for (const [label, raw] of malformed) {
    it(`rejects ${label}`, () => {
      expect(() => parsePuzzleSet(raw, 'inline')).toThrow();
    });
  }
});

// ---------------------------------------------------------------------------
// The runner: the estimate/refusal path and the offline dry run.
// ---------------------------------------------------------------------------

/** `<dir>/synthetic/{synthetic-5x5,synthetic-7x7}.json`, matching tiny.json's ids. */
function libraryWithSyntheticFixtures(): string {
  const dir = tmpDir('recall-lib-');
  const sourceDir = join(dir, 'synthetic');
  mkdirSync(sourceDir, { recursive: true });
  for (const id of ['synthetic-5x5', 'synthetic-7x7']) {
    copyFileSync(join(ROOT, 'test/fixtures/puzzles', `${id}.json`), join(sourceDir, `${id}.json`));
  }
  return dir;
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

/** Counts calls and never returns one: nothing in these tests may reach a provider. */
function countingTransport(): { transport: LlmTransport; calls: () => number } {
  let calls = 0;
  return {
    transport: {
      complete(_req: LlmRequest): Promise<LlmResult> {
        calls += 1;
        return Promise.reject(new Error('the recall screen must not call a transport here'));
      },
    },
    calls: () => calls,
  };
}

function recallArgs(overrides: Partial<RecallArgs> = {}): RecallArgs {
  return {
    set: TINY_SET,
    models: [TIER1],
    repeat: 1,
    maxUsd: 10,
    out: 'logs/recall',
    yes: false,
    offline: true,
    offlineLenient: false,
    concurrency: 2,
    inferenceLog: false,
    profile: 'baseline',
    ...overrides,
  };
}

function baseOverrides(): RecallOverrides {
  return {
    puzzlesDir: libraryWithSyntheticFixtures(),
    cacheDir: CACHE_FIXTURES,
    inferenceLogDir: tmpDir('recall-inflog-'),
    outDir: tmpDir('recall-out-'),
    env: {},
    now: () => new Date('2026-09-05T00:00:00.000Z'),
  };
}

describe('runRecall pre-flight', () => {
  it('refuses to start above --max-usd without --yes, and calls no transport', async () => {
    const stub = countingTransport();
    const stdout = makeSink();
    const overrides: RecallOverrides = {
      ...baseOverrides(),
      transport: stub.transport,
      stdout: stdout.stream,
      stderr: makeSink().stream,
    };
    let thrown: unknown;
    try {
      await runRecall(recallArgs({ maxUsd: 0, offline: false }), overrides);
    } catch (cause) {
      thrown = cause;
    }
    expect(isCliError(thrown)).toBe(true);
    if (isCliError(thrown)) {
      expect(thrown.code).toBe(ExitCode.USAGE);
      expect(thrown.message).toContain('--max-usd');
    }
    expect(stub.calls()).toBe(0);
    // The estimate is printed before the refusal, so the operator can see how
    // far over the ceiling the matrix is.
    expect(stdout.text()).toContain('estimate: 34 slots x 1 models x 1 repeats');
  });

  it('runs when --yes is given despite the ceiling', async () => {
    const stdout = makeSink();
    const result = await runRecall(recallArgs({ maxUsd: 0, yes: true }), {
      ...baseOverrides(),
      stdout: stdout.stream,
      stderr: makeSink().stream,
    });
    expect(result.records).toHaveLength(2);
  });

  it('rejects a model that is not in the catalogue before anything is loaded', async () => {
    let thrown: unknown;
    try {
      await runRecall(recallArgs({ models: ['not/a-real-model'] }), {
        ...baseOverrides(),
        stdout: makeSink().stream,
        stderr: makeSink().stream,
      });
    } catch (cause) {
      thrown = cause;
    }
    expect(isCliError(thrown)).toBe(true);
    if (isCliError(thrown)) expect(thrown.code).toBe(ExitCode.USAGE);
  });
});

// ---------------------------------------------------------------------------
// Acceptance 4: an offline dry run against the committed synthetic cache.
// ---------------------------------------------------------------------------

describe('runRecall offline dry run', () => {
  it('screens both synthetic fixtures from the committed cache at zero spend', async () => {
    const stub = countingTransport();
    const stdout = makeSink();
    const overrides: RecallOverrides = {
      ...baseOverrides(),
      transport: stub.transport,
      stdout: stdout.stream,
      stderr: makeSink().stream,
    };
    const result = await runRecall(recallArgs(), overrides);

    // Two puzzles, one model, one repeat, and the seed pass only: 34 slots.
    expect(result.records).toHaveLength(2);
    expect(result.records.map((r) => r.puzzleId).sort()).toEqual([
      'synthetic-5x5',
      'synthetic-7x7',
    ]);
    const slots = result.records.flatMap((r) => r.slots);
    expect(slots).toHaveLength(34);

    // Offline means the provider is never reached and nothing is billed.
    expect(stub.calls()).toBe(0);
    for (const slot of slots) {
      expect(slot.usdBilled).toBe(0);
      expect(slot.cacheHit).toBe(true);
    }

    const aggregation = aggregateRecall(result.records);
    const row = aggregation.byModel[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.slots).toBe(34);
    expect(row.usdBilledPerPuzzle).toBe(0);
    // Every slot was served from the cache, so the counterfactual price is
    // non-zero even though nothing was spent (B2).
    expect(row.usdPerPuzzle).toBeGreaterThan(0);
    // The screen is a measurement, not a threshold: what it must do here is
    // produce a number for every slot from the committed cache alone.
    expect(row.truthInCandidatesShare).toBeGreaterThan(0);
    expect(row.truthInCandidatesShare).toBeLessThanOrEqual(1);

    // Every per-cell file, plus the two summaries.
    const cell = JSON.parse(
      readFileSync(
        join(result.outDir, modelSlug(TIER1), 'synthetic-5x5--r0.json'),
        'utf8',
      ),
    ) as { slots: unknown[]; promptVersion: string; offline: boolean };
    expect(cell.slots).toHaveLength(11);
    expect(cell.promptVersion).toBe('2');
    expect(cell.offline).toBe(true);

    const markdown = readFileSync(join(result.outDir, 'summary.md'), 'utf8');
    expect(markdown).toContain('# Seed-only candidate recall screen');
    expect(markdown).toContain(TIER1);
    const summary = JSON.parse(readFileSync(join(result.outDir, 'summary.json'), 'utf8')) as {
      models: string[];
      offline: boolean;
    };
    expect(summary.models).toEqual([TIER1]);
    expect(summary.offline).toBe(true);

    // The table reaches stdout, split by stratum as well as by model.
    expect(stdout.text()).toContain('truth-in-candidates');
    expect(stdout.text()).toContain(`${TIER1} / american`);
  });

  it('is deterministic: a second identical replay produces identical per-slot records', async () => {
    const first = await runRecall(recallArgs(), {
      ...baseOverrides(),
      stdout: makeSink().stream,
      stderr: makeSink().stream,
    });
    const second = await runRecall(recallArgs(), {
      ...baseOverrides(),
      stdout: makeSink().stream,
      stderr: makeSink().stream,
    });
    expect(JSON.stringify(second.records)).toBe(JSON.stringify(first.records));
  });
});
