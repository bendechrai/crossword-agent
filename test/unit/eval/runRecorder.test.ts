import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchemaObject } from 'ajv/dist/2020.js';
// ajv-formats is CommonJS with only a default export, which from an ES module
// arrives as the namespace's `default`; TypeScript models that as the module
// type rather than the callable, hence the cast to its own exported type,
// mirroring test/contract/schemas.test.ts.
import * as ajvFormatsModule from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EventBase, SolverEvent } from '../../../src/events/types.js';
import {
  createRunRecorder,
  IndexUpsertError,
  makeRunId,
  type RunIdInput,
} from '../../../src/eval/runRecorder.js';
import { aggregate } from '../../../src/eval/aggregate.js';
import { usdFor } from '../../../src/llm/pricing.js';
import type { PuzzleIndexRow } from '../../../src/puzzle/types.js';
import { getLogLevel, setLogLevel } from '../../../src/util/log.js';
import { readGitCommit } from '../../../src/util/git.js';
import { ProfileSchema } from '../../../src/profiles/schema.js';

const addFormats = ajvFormatsModule.default as unknown as FormatsPlugin;

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function compileRunRecordSchema() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const schema = JSON.parse(
    readFileSync(join(REPO_ROOT, 'schemas', 'run-record.schema.json'), 'utf8'),
  ) as AnySchemaObject;
  return ajv.compile(schema);
}

const profile = ProfileSchema.parse({ name: 'baseline' });
const TIER1 = profile.tier1;
const TIER2 = profile.tier2;

const FIXTURE_EVENTS_PATH = join(REPO_ROOT, 'test', 'fixtures', 'events', 'full-run.events.jsonl');

/**
 * T14's committed events fixture, parsed directly from JSONL: the canonical
 * source for the "main path" tests below (acceptance 1). Read fresh each
 * call so a test that maps over the array (`eventsScoring`) never mutates
 * what another test sees.
 */
function loadFixtureEvents(): SolverEvent[] {
  return readFileSync(FIXTURE_EVENTS_PATH, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SolverEvent);
}

/**
 * The correct answer for every slot in `test/fixtures/events/full-run.events.jsonl`'s
 * `synthetic-5x5` grid, hand-derived from each clue (independently of the
 * fixture's own `grid:final`, which records what the run actually filled in,
 * including its one deliberately wrong letter at row 1 col 1 - see T14's
 * reviewer notes in docs/build-notes/wave-1.md). This is what a real caller
 * would load via B11's solution grid; the fixture's event stream never
 * carries it.
 */
const FIXTURE_TRUTH: Readonly<Record<string, string>> = {
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

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crossword-runrecorder-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Builds a `SolverEvent[]` where every element gets its own seq/tMs. */
class EventBuilder {
  private seq = 0;
  private tMs = 0;
  private readonly runId: string;
  readonly events: SolverEvent[] = [];

  constructor(runId: string) {
    this.runId = runId;
  }

  private base(): EventBase {
    this.seq += 1;
    this.tMs += 10;
    return { runId: this.runId, seq: this.seq, tMs: this.tMs };
  }

  push(event: SolverEvent): this {
    this.events.push(event);
    return this;
  }

  next(): EventBase {
    return this.base();
  }
}

function grid5x5() {
  const blocks: boolean[][] = Array.from({ length: 5 }, () => Array<boolean>(5).fill(false));
  const numbers: (number | null)[][] = Array.from({ length: 5 }, () => Array<number | null>(5).fill(null));
  return { width: 5, height: 5, blocks, numbers };
}

/** The cold call's tokens in `cacheHitEvents`, priced through `models.json`. */
const COLD_USAGE = { promptTokens: 100, completionTokens: 20, reasoningTokens: 0, totalTokens: 120 };
/**
 * The cache hit's tokens in `cacheHitEvents`: the blob the original cold call
 * stored, which is exactly what makes the hit priceable (B2). Deliberately
 * different from `COLD_USAGE` so a test cannot pass by pricing the wrong one.
 */
const HIT_USAGE = { promptTokens: 80, completionTokens: 40, reasoningTokens: 0, totalTokens: 120 };

/** What `src/llm/pricing.ts` charges for one call with those tokens (B29). */
function priced(usage: { promptTokens: number; completionTokens: number }): number {
  return usdFor({
    model: TIER1,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    calls: 1,
  });
}

/**
 * A minimal two-slot run with a fresh tier-1 call and a cache-hit tier-1
 * call in the seed pass. Used only by the one test below whose shape
 * `test/fixtures/events/full-run.events.jsonl` lacks: the fixture's single
 * `llm:usage` event is a cache miss, so it cannot exercise the
 * usdCounterfactual-vs-usdBilled divergence a cache hit produces.
 */
function cacheHitEvents(): SolverEvent[] {
  const b = new EventBuilder('test-run');
  const { width, height, blocks, numbers } = grid5x5();

  b.push({
    ...b.next(),
    type: 'run:start',
    puzzleId: 'synthetic-5x5',
    profileName: 'baseline',
    models: { tier1: TIER1, tier2: TIER2 },
    seed: null,
  });
  b.push({
    ...b.next(),
    type: 'grid:init',
    width,
    height,
    blocks,
    numbers,
    slots: [
      { id: '1A', row: 0, col: 0, length: 3, direction: 'across', clue: 'Feline' },
      { id: '2D', row: 0, col: 0, length: 4, direction: 'down', clue: 'Canines' },
    ],
  });
  b.push({ ...b.next(), type: 'phase:start', phase: 'seed' });

  // 1A: a fresh (non-cached) tier-1 call.
  b.push({
    ...b.next(),
    type: 'slot:ask',
    slotId: '1A',
    clue: 'Feline',
    length: 3,
    pattern: '...',
    tier: 1,
    purpose: 'seed',
    promptKind: 'seed',
    batchIndex: 0,
  });
  b.push({ ...b.next(), type: 'cache:lookup', key: 'k1', hit: false, slotId: '1A' });
  b.push({ ...b.next(), type: 'llm:request', model: TIER1, slotId: '1A', prompt: 'p1' });
  b.push({ ...b.next(), type: 'llm:response', model: TIER1, slotId: '1A', raw: 'r1' });
  b.push({
    ...b.next(),
    type: 'llm:usage',
    model: TIER1,
    usage: COLD_USAGE,
    usdBilled: 0.001,
    usdCounterfactual: 0.001,
    cacheHit: false,
    latencyMs: 200,
  });
  b.push({
    ...b.next(),
    type: 'slot:candidates',
    slotId: '1A',
    accepted: [
      { answer: 'CAT', score: 0.9 },
      { answer: 'BAT', score: 0.5 },
    ],
    clueUnderstood: 0.8,
    cacheHit: false,
  });
  b.push({ ...b.next(), type: 'candidate:reject', slotId: '1A', answer: 'ZAT', reason: 'charset' });
  b.push({
    ...b.next(),
    type: 'search:assign',
    slotId: '1A',
    answer: 'CAT',
    score: 0.9,
    margin: 0.4,
    tier: 1,
    producedBy: TIER1,
  });

  // 2D: a cache-hit tier-1 call.
  b.push({
    ...b.next(),
    type: 'slot:ask',
    slotId: '2D',
    clue: 'Canines',
    length: 4,
    pattern: '....',
    tier: 1,
    purpose: 'seed',
    promptKind: 'seed',
    batchIndex: 1,
  });
  b.push({ ...b.next(), type: 'cache:lookup', key: 'k2', hit: true, slotId: '2D' });
  // T61: the service reports a hit on the same event a cold call uses,
  // carrying the cached usage blob, `usdBilled` 0 and `cacheHit` true.
  b.push({
    ...b.next(),
    type: 'llm:usage',
    model: TIER1,
    usage: HIT_USAGE,
    usdBilled: 0,
    usdCounterfactual: 0,
    cacheHit: true,
    latencyMs: 0,
  });
  b.push({
    ...b.next(),
    type: 'slot:candidates',
    slotId: '2D',
    accepted: [{ answer: 'DOGS', score: 0.7 }],
    clueUnderstood: 0.6,
    cacheHit: true,
  });
  b.push({
    ...b.next(),
    type: 'search:assign',
    slotId: '2D',
    answer: 'DOGS',
    score: 0.7,
    margin: 0.3,
    tier: 1,
    producedBy: TIER1,
  });
  b.push({ ...b.next(), type: 'phase:end', phase: 'seed', durationMs: 500 });

  b.push({ ...b.next(), type: 'phase:start', phase: 'score' });
  b.push({
    ...b.next(),
    type: 'score:final',
    accuracy: { letters: 1, words: 1, perfect: true, emptyCells: 0 },
  });
  b.push({ ...b.next(), type: 'phase:end', phase: 'score', durationMs: 50 });
  b.push({ ...b.next(), type: 'run:end', status: 'ok', wallMs: 5000 });

  return b.events;
}

const FIXED_AT = new Date('2026-09-03T10:15:00Z');
const FIXED_GIT_COMMIT = 'f'.repeat(40);

/**
 * Every test routes `--out` through a temp directory (cleaned up in
 * `afterEach`) rather than the default `runs/<runId>.json`, so a test run
 * never writes into the real repo's `runs/` directory. Defaults describe the
 * fixture's own `synthetic-5x5` grid (11 slots); a test driving a different
 * event stream overrides `puzzle`/`truth` as needed.
 */
function baseRecorderOptions() {
  return {
    out: join(tempDir(), 'run.json'),
    puzzle: {
      id: 'synthetic-5x5',
      source: 'synthetic',
      style: 'american' as const,
      stratum: 'american' as const,
      size: '5x5',
      slots: 11,
    },
    truth: FIXTURE_TRUTH,
    profile,
    profileSource: 'builtin',
    repeatIndex: 0,
    now: () => FIXED_AT,
    gitCommit: FIXED_GIT_COMMIT,
    nodeVersion: 'v22.11.0',
    packageVersion: '0.1.0',
    updateIndex: false as const,
  };
}

describe('makeRunId', () => {
  const input: RunIdInput = {
    puzzleId: 'synthetic-5x5',
    profileName: 'baseline',
    profile,
    gitCommit: FIXED_GIT_COMMIT,
    repeatIndex: 0,
    at: FIXED_AT,
  };

  it('is deterministic for identical inputs', () => {
    expect(makeRunId({ ...input })).toBe(makeRunId({ ...input }));
  });

  it('changes the short hash when repeatIndex changes', () => {
    const a = makeRunId(input);
    const b = makeRunId({ ...input, repeatIndex: 1 });
    expect(a).not.toBe(b);
    const hashA = a.split('--')[3];
    const hashB = b.split('--')[3];
    expect(hashA).not.toBe(hashB);
  });

  it('sanitises a puzzle id containing "/" and matches the run id shape', () => {
    const id = makeRunId({ ...input, puzzleId: 'guardian/27000' });
    expect(id).toMatch(/^[A-Za-z0-9._-]+--[A-Za-z0-9._-]+--\d{8}T\d{6}Z--[0-9a-f]{8}$/);
    expect(id.startsWith('guardian-27000--')).toBe(true);
  });

  it('formats the timestamp as YYYYMMDDTHHmmssZ in UTC', () => {
    const id = makeRunId(input);
    expect(id).toContain('--20260903T101500Z--');
  });
});

describe('readGitCommit', () => {
  const savedEnv = process.env.GIT_COMMIT;

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.GIT_COMMIT;
    else process.env.GIT_COMMIT = savedEnv;
  });

  it('returns the commit for a loose ref layout', () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const hash = 'a'.repeat(40);
    writeFileSync(join(dir, '.git', 'refs', 'heads', 'main'), `${hash}\n`);

    expect(readGitCommit(dir)).toBe(hash);
  });

  it('falls back to packed-refs when there is no loose ref file', () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const hash = 'b'.repeat(40);
    writeFileSync(
      join(dir, '.git', 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted\n${hash} refs/heads/main\n`,
    );

    expect(readGitCommit(dir)).toBe(hash);
  });

  it('returns "unknown" without throwing when neither exists and $GIT_COMMIT is unset', () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    delete process.env.GIT_COMMIT;

    expect(() => readGitCommit(dir)).not.toThrow();
    expect(readGitCommit(dir)).toBe('unknown');
  });

  it('returns "unknown" without throwing when there is no .git directory at all', () => {
    const dir = tempDir();
    delete process.env.GIT_COMMIT;

    expect(() => readGitCommit(dir)).not.toThrow();
    expect(readGitCommit(dir)).toBe('unknown');
  });

  it('falls back to $GIT_COMMIT when the .git layout resolves nothing', () => {
    const dir = tempDir();
    process.env.GIT_COMMIT = 'from-env';

    expect(readGitCommit(dir)).toBe('from-env');
  });

  it('resolves a worktree checkout by following commondir to the main repo', () => {
    // A worktree checkout: `<worktree>/.git` is a pointer file to a
    // per-worktree gitdir under `<main>/.git/worktrees/<name>`, which holds
    // HEAD and a `commondir` file naming the main `.git` (refs and
    // packed-refs live there, not under the per-worktree gitdir).
    const root = tempDir();
    const mainDir = join(root, 'main');
    const worktreeDir = join(root, 'wt');
    const perWorktreeGitDir = join(mainDir, '.git', 'worktrees', 'wt');

    mkdirSync(join(mainDir, '.git', 'refs', 'heads'), { recursive: true });
    const hash = 'c'.repeat(40);
    writeFileSync(join(mainDir, '.git', 'refs', 'heads', 'task'), `${hash}\n`);

    mkdirSync(perWorktreeGitDir, { recursive: true });
    writeFileSync(join(perWorktreeGitDir, 'HEAD'), 'ref: refs/heads/task\n');
    writeFileSync(join(perWorktreeGitDir, 'commondir'), '../..\n');

    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(join(worktreeDir, '.git'), `gitdir: ${perWorktreeGitDir}\n`);

    expect(readGitCommit(worktreeDir)).toBe(hash);
  });

  it('resolves a worktree checkout against a packed-refs entry in the common dir', () => {
    const root = tempDir();
    const mainDir = join(root, 'main');
    const worktreeDir = join(root, 'wt');
    const perWorktreeGitDir = join(mainDir, '.git', 'worktrees', 'wt');

    mkdirSync(join(mainDir, '.git'), { recursive: true });
    const hash = 'd'.repeat(40);
    writeFileSync(
      join(mainDir, '.git', 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted\n${hash} refs/heads/task\n`,
    );

    mkdirSync(perWorktreeGitDir, { recursive: true });
    writeFileSync(join(perWorktreeGitDir, 'HEAD'), 'ref: refs/heads/task\n');
    writeFileSync(join(perWorktreeGitDir, 'commondir'), '../..\n');

    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(join(worktreeDir, '.git'), `gitdir: ${perWorktreeGitDir}\n`);

    expect(readGitCommit(worktreeDir)).toBe(hash);
  });
});

describe('createRunRecorder', () => {
  it('produces a RunRecord that validates against schemas/run-record.schema.json', async () => {
    const recorder = createRunRecorder(baseRecorderOptions());
    for (const event of loadFixtureEvents()) recorder.handler(event);
    await recorder.written();

    const validate = compileRunRecordSchema();
    const record = recorder.record();
    expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
  });

  it('writes the record to the given --out path', async () => {
    const dir = tempDir();
    const out = join(dir, 'out.json');
    const recorder = createRunRecorder({ ...baseRecorderOptions(), out });
    for (const event of loadFixtureEvents()) recorder.handler(event);

    const written = await recorder.written();
    expect(written).toBe(out);
    const onDisk = JSON.parse(readFileSync(out, 'utf8')) as { runId: string };
    expect(onDisk.runId).toBe(recorder.record().runId);
  });

  it('counts search.backtracks, repair.accepted and calls.tier1.count as literals (recomputed against the fixture)', async () => {
    const recorder = createRunRecorder(baseRecorderOptions());
    for (const event of loadFixtureEvents()) recorder.handler(event);
    await recorder.written();

    const record = recorder.record();
    // The fixture has one search:backtrack (slot 5A), one repair:accept
    // (slot 9A), and exactly one llm:usage event, tied by the FIFO
    // cache:lookup pairing to the tier-1 (test/tier1-model) call for 1A.
    expect(record.search.backtracks).toBe(1);
    expect(record.repair.accepted).toBe(1);
    expect(record.calls.tier1.count).toBe(1);
  });

  it('makes usdCounterfactual >= usdBilled when a tier has a cache hit, and equal when it does not', async () => {
    // The fixture's one llm:usage event is a cache miss (acceptance 1's
    // "main path" fixture-only coverage does not reach this case), so this
    // test keeps its own small dedicated stream - see cacheHitEvents' doc
    // comment.
    const recorder = createRunRecorder({
      ...baseRecorderOptions(),
      puzzle: { ...baseRecorderOptions().puzzle, slots: 2 },
      truth: { '1A': 'CAT', '2D': 'DOGS' },
    });
    for (const event of cacheHitEvents()) recorder.handler(event);
    await recorder.written();

    const record = recorder.record();
    // tier1 saw one fresh call and one cache hit.
    expect(record.calls.tier1.usdCounterfactual).toBeGreaterThan(record.calls.tier1.usdBilled);
    expect(record.calls.tier1.cacheHits).toBe(1);
    // tier2 was never called: the two figures coincide at zero.
    expect(record.calls.tier2.usdCounterfactual).toBe(record.calls.tier2.usdBilled);
    expect(record.calls.tier2.cacheHits).toBe(0);
  });

  /**
   * T61 acceptance 2 (B2, B29). Both usage events are priced here, at write
   * time, from the model each one names and `models.json`; only the cold one
   * is billed. The hit's own `usdCounterfactual` on the event is deliberately
   * 0 in `cacheHitEvents`, so a recorder that trusted the event instead of
   * pricing it would fail this test.
   */
  it('prices every llm:usage event into usdCounterfactual and only cold ones into usdBilled', async () => {
    const recorder = createRunRecorder({
      ...baseRecorderOptions(),
      puzzle: { ...baseRecorderOptions().puzzle, slots: 2 },
      truth: { '1A': 'CAT', '2D': 'DOGS' },
    });
    for (const event of cacheHitEvents()) recorder.handler(event);
    await recorder.written();

    const tier1 = recorder.record().calls.tier1;
    expect(priced(COLD_USAGE)).toBeGreaterThan(0);
    expect(priced(HIT_USAGE)).toBeGreaterThan(0);
    expect(tier1.usdCounterfactual).toBeCloseTo(priced(COLD_USAGE) + priced(HIT_USAGE), 12);
    expect(tier1.usdBilled).toBeCloseTo(priced(COLD_USAGE), 12);
    expect(tier1.cacheHits).toBe(1);
    // Both calls are counted, and the tokens beside the dollars are the tokens
    // those dollars were computed from.
    expect(tier1.count).toBe(2);
    expect(tier1.promptTokens).toBe(COLD_USAGE.promptTokens + HIT_USAGE.promptTokens);
    expect(tier1.completionTokens).toBe(COLD_USAGE.completionTokens + HIT_USAGE.completionTokens);
    // A hit waited on no provider, so it is not folded into the average.
    expect(tier1.avgLatencyMs).toBe(200);
  });

  it('attributes the cache-hit slot its counterfactual usd, not zero', async () => {
    const recorder = createRunRecorder({
      ...baseRecorderOptions(),
      puzzle: { ...baseRecorderOptions().puzzle, slots: 2 },
      truth: { '1A': 'CAT', '2D': 'DOGS' },
    });
    for (const event of cacheHitEvents()) recorder.handler(event);
    await recorder.written();

    const bySlot = new Map(recorder.record().perSlot.map((slot) => [slot.slotId, slot]));
    expect(bySlot.get('1A')?.usd).toBeCloseTo(priced(COLD_USAGE), 12);
    expect(bySlot.get('2D')?.usd).toBeCloseTo(priced(HIT_USAGE), 12);
  });

  /**
   * T61 acceptance: `src/eval/aggregate.ts` (and hence the `xw bench` summary
   * table and `xw report`, which both render its groups) already reads
   * `usdCounterfactual`. This pins that with a record that actually contains
   * a cache hit, which is the only case where the two figures differ.
   */
  it('feeds aggregate() a counterfactual usd per puzzle and per correct word, not the billed one', async () => {
    const recorder = createRunRecorder({
      ...baseRecorderOptions(),
      puzzle: { ...baseRecorderOptions().puzzle, slots: 2 },
      truth: { '1A': 'CAT', '2D': 'DOGS' },
    });
    for (const event of cacheHitEvents()) recorder.handler(event);
    await recorder.written();

    const record = recorder.record();
    const counterfactual = priced(COLD_USAGE) + priced(HIT_USAGE);
    expect(record.calls.tier1.usdBilled).toBeLessThan(counterfactual);

    const group = aggregate([record], { by: 'profile' }).groups[0];
    expect(group?.n).toBe(1);
    expect(group?.usdPerPuzzle).toBeCloseTo(counterfactual, 12);
    // Both slots were filled correctly by cacheHitEvents' stream.
    expect(group?.usdPerCorrectWord).toBeCloseTo(counterfactual / 2, 12);
  });

  it('marks a run "partial" (not "error") when a budget cap was hit even with a complete fill', async () => {
    const b = new EventBuilder('test-run-2');
    const { width, height, blocks, numbers } = grid5x5();
    const events: SolverEvent[] = [
      { ...b.next(), type: 'run:start', puzzleId: 'p', profileName: 'baseline', models: { tier1: TIER1, tier2: TIER2 }, seed: null },
      {
        ...b.next(),
        type: 'grid:init',
        width,
        height,
        blocks,
        numbers,
        slots: [{ id: '1A', row: 0, col: 0, length: 3, direction: 'across', clue: 'Feline' }],
      },
      { ...b.next(), type: 'phase:start', phase: 'search' },
      {
        ...b.next(),
        type: 'search:assign',
        slotId: '1A',
        answer: 'CAT',
        score: 0.9,
        margin: 0.4,
        tier: 1,
        producedBy: TIER1,
      },
      { ...b.next(), type: 'budget:hit', cap: 'wallMs', limit: 1000, actual: 1050 },
      { ...b.next(), type: 'phase:end', phase: 'search', durationMs: 1050 },
      {
        ...b.next(),
        type: 'score:final',
        accuracy: { letters: 1, words: 1, perfect: true, emptyCells: 0 },
      },
      { ...b.next(), type: 'run:end', status: 'ok', wallMs: 1050 },
    ];

    const recorder = createRunRecorder({
      ...baseRecorderOptions(),
      puzzle: { ...baseRecorderOptions().puzzle, id: 'p', slots: 1 },
      truth: { '1A': 'CAT' },
    });
    for (const event of events) recorder.handler(event);
    await recorder.written();

    const record = recorder.record();
    expect(record.status).toBe('partial');
    expect(record.budgetHits).toEqual([{ cap: 'wallMs', limit: 1000, actual: 1050, atMs: 50 }]);

    const validate = compileRunRecordSchema();
    expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
  });

  it('sanitises a puzzle id containing "/" in both the run id and record.puzzle.id', async () => {
    const recorder = createRunRecorder({
      ...baseRecorderOptions(),
      puzzle: { ...baseRecorderOptions().puzzle, id: 'guardian/27000' },
    });
    for (const event of loadFixtureEvents()) recorder.handler(event);
    await recorder.written();

    const record = recorder.record();
    expect(record.puzzle.id).toBe('guardian-27000');
    expect(record.runId).toMatch(/^guardian-27000--[A-Za-z0-9._-]+--\d{8}T\d{6}Z--[0-9a-f]{8}$/);
  });
});

describe('createRunRecorder index upsert', () => {
  /**
   * The `updateIndex` half of `RunRecorderIndexUpdate`: everything
   * `puzzles/index.json` needs that a `RunRecord` does not already carry.
   * `upsertIndexRow` is supplied per test, since what it does with the row -
   * record it, or reject - is what each of these tests is about.
   */
  function indexFields() {
    return {
      date: '2026-09-01',
      title: 'Synthetic 5x5',
      width: 5,
      height: 5,
      files: { original: 'puzzles/synthetic-5x5/original.puz', normalised: 'puzzles/synthetic-5x5/normalised.json' },
      parsedBy: '@xwordly/xword-parser' as const,
    };
  }

  /** The fixture run with its final accuracy replaced, for the "previous row wins" case. */
  function eventsScoring(letters: number): SolverEvent[] {
    return loadFixtureEvents().map((event) =>
      event.type === 'score:final'
        ? { ...event, accuracy: { letters, words: letters, perfect: false, emptyCells: 2 } }
        : event,
    );
  }

  it('upserts a puzzles/index.json row built from the record and the injected fields', async () => {
    const rows: PuzzleIndexRow[] = [];
    const recorder = createRunRecorder({
      ...baseRecorderOptions(),
      updateIndex: {
        ...indexFields(),
        upsertIndexRow: (row: PuzzleIndexRow) => {
          rows.push(row);
          return Promise.resolve();
        },
      },
    });
    for (const event of loadFixtureEvents()) recorder.handler(event);
    await recorder.written();

    const stamp = recorder.record().timestamp;
    expect(rows).toEqual([
      {
        id: 'synthetic-5x5',
        source: 'synthetic',
        date: '2026-09-01',
        title: 'Synthetic 5x5',
        style: 'american',
        width: 5,
        height: 5,
        slotCount: 11,
        files: {
          original: 'puzzles/synthetic-5x5/original.puz',
          normalised: 'puzzles/synthetic-5x5/normalised.json',
        },
        schemaVersion: 1,
        parsedBy: '@xwordly/xword-parser',
        addedAt: stamp,
        // The fixture's own score:final: 21 of 22 letters correct (one
        // deliberately wrong letter at row 1 col 1).
        bestLetterAccuracy: 0.9545454545454546,
        lastRunAt: stamp,
      },
    ]);
  });

  it('keeps the addedAt and the better letter accuracy from the previous row', async () => {
    const previousRow: PuzzleIndexRow = {
      ...indexFields(),
      id: 'synthetic-5x5',
      source: 'synthetic',
      style: 'american',
      slotCount: 11,
      schemaVersion: 1,
      addedAt: '2026-01-01T00:00:00.000Z',
      bestLetterAccuracy: 0.9,
      lastRunAt: '2026-01-01T00:00:00.000Z',
    };
    const rows: PuzzleIndexRow[] = [];
    const recorder = createRunRecorder({
      ...baseRecorderOptions(),
      updateIndex: {
        ...indexFields(),
        previousRow,
        upsertIndexRow: (row: PuzzleIndexRow) => {
          rows.push(row);
          return Promise.resolve();
        },
      },
    });
    for (const event of eventsScoring(0.5)) recorder.handler(event);
    await recorder.written();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.addedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(rows[0]?.bestLetterAccuracy).toBe(0.9);
    expect(rows[0]?.lastRunAt).toBe(recorder.record().timestamp);
  });

  it('rejects written() with IndexUpsertError when the upsert fails, keeping the record on disk', async () => {
    const out = join(tempDir(), 'out.json');
    const lockTimeout = new Error('puzzles/.index.lock: timed out after 5000ms');
    const recorder = createRunRecorder({
      ...baseRecorderOptions(),
      out,
      updateIndex: {
        ...indexFields(),
        upsertIndexRow: () => Promise.reject(lockTimeout),
      },
    });
    for (const event of loadFixtureEvents()) recorder.handler(event);

    const error = await recorder.written().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(IndexUpsertError);
    const upsertError = error as IndexUpsertError;
    expect(upsertError.recordPath).toBe(out);
    expect(upsertError.puzzleId).toBe('synthetic-5x5');
    expect(upsertError.cause).toBe(lockTimeout);
    expect(upsertError.message).toContain(out);
    expect(upsertError.message).toContain('puzzles/.index.lock: timed out after 5000ms');

    // The record itself is the durable copy and must survive the failure.
    const onDisk = JSON.parse(readFileSync(out, 'utf8')) as { runId: string };
    expect(onDisk.runId).toBe(recorder.record().runId);
  });

  it('reports the upsert failure on stderr when nobody calls written()', async () => {
    const out = join(tempDir(), 'out.json');
    const previousLevel = getLogLevel();
    setLogLevel('error');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const recorder = createRunRecorder({
        ...baseRecorderOptions(),
        out,
        updateIndex: {
          ...indexFields(),
          upsertIndexRow: () => Promise.reject(new Error('index locked')),
        },
      });
      for (const event of loadFixtureEvents()) recorder.handler(event);

      await vi.waitFor(() => {
        expect(stderr).toHaveBeenCalled();
      });
      const lines = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(lines).toContain('index locked');
      expect(lines).toContain(out);
    } finally {
      stderr.mockRestore();
      setLogLevel(previousLevel);
    }
  });
});
