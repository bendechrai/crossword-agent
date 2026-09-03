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
import { afterEach, describe, expect, it } from 'vitest';

import type { EventBase, SolverEvent } from '../../../src/events/types.js';
import { createRunRecorder, makeRunId, type RunIdInput } from '../../../src/eval/runRecorder.js';
import { readGitCommit } from '../../../src/util/git.js';
import { ProfileSchema } from '../../../src/profiles/schema.js';

const addFormats = ajvFormatsModule.default as unknown as FormatsPlugin;

function compileRunRecordSchema() {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const schema = JSON.parse(
    readFileSync(join(root, 'schemas', 'run-record.schema.json'), 'utf8'),
  ) as AnySchemaObject;
  return ajv.compile(schema);
}

const profile = ProfileSchema.parse({ name: 'baseline' });
const TIER1 = profile.tier1;
const TIER2 = profile.tier2;

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

/**
 * A full happy-path run: two slots, a fresh tier-1 call and a cache-hit
 * tier-1 call in the seed pass, a backtrack cycle, an ac3 reduction, a
 * tier-2 repair call that is accepted, then a perfect score. Stands in for
 * `test/fixtures/events/full-run.events.jsonl` (T14's fixture), which does
 * not exist yet in this wave - see the PR's "Deviations" note.
 */
function fullRunEvents(): SolverEvent[] {
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
    usage: { promptTokens: 100, completionTokens: 20, reasoningTokens: 0, totalTokens: 120 },
    usdBilled: 0.001,
    usdCounterfactual: 0.001,
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
  b.push({
    ...b.next(),
    type: 'llm:usage',
    model: TIER1,
    usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 },
    usdBilled: 0,
    usdCounterfactual: 0.0007,
    latencyMs: 5,
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

  // Search: two backtracks, a wipeout and an ac3 reduction.
  b.push({ ...b.next(), type: 'phase:start', phase: 'search' });
  b.push({ ...b.next(), type: 'search:unassign', slotId: '1A', answer: 'CAT' });
  b.push({ ...b.next(), type: 'search:backtrack', slotId: '1A', margin: 0.4, reason: 'crossing wipeout' });
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
  b.push({ ...b.next(), type: 'search:backtrack', slotId: '2D', margin: 0.3, reason: 'lds restart' });
  b.push({ ...b.next(), type: 'search:wipeout', slotId: '2D' });
  b.push({ ...b.next(), type: 'ac3:reduce', slotId: '1A', otherSlotId: '2D', removed: ['XAT'] });
  b.push({ ...b.next(), type: 'phase:end', phase: 'search', durationMs: 800 });

  // Repair: one tier-2 call, accepted.
  b.push({ ...b.next(), type: 'phase:start', phase: 'repair' });
  b.push({ ...b.next(), type: 'cache:lookup', key: 'k3', hit: false, slotId: '2D' });
  b.push({ ...b.next(), type: 'llm:request', model: TIER2, slotId: '2D', prompt: 'p2' });
  b.push({ ...b.next(), type: 'llm:response', model: TIER2, slotId: '2D', raw: 'r2' });
  b.push({
    ...b.next(),
    type: 'llm:usage',
    model: TIER2,
    usage: { promptTokens: 50, completionTokens: 10, reasoningTokens: 5, totalTokens: 65 },
    usdBilled: 0.0009,
    usdCounterfactual: 0.0009,
    latencyMs: 150,
  });
  b.push({
    ...b.next(),
    type: 'repair:propose',
    slotId: '2D',
    before: 'DOGS',
    after: 'DOGS',
    editDistance: 0,
    gate: 'crossing-check',
  });
  b.push({
    ...b.next(),
    type: 'repair:accept',
    slotId: '2D',
    before: 'DOGS',
    after: 'DOGS',
    editDistance: 0,
    tier: 2,
    producedBy: TIER2,
  });
  b.push({ ...b.next(), type: 'phase:end', phase: 'repair', durationMs: 300 });

  // Score.
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

const TRUTH = { '1A': 'CAT', '2D': 'DOGS' };
const FIXED_AT = new Date('2026-09-03T10:15:00Z');
const FIXED_GIT_COMMIT = 'f'.repeat(40);

/**
 * Every test routes `--out` through a temp directory (cleaned up in
 * `afterEach`) rather than the default `runs/<runId>.json`, so a test run
 * never writes into the real repo's `runs/` directory.
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
      slots: 2,
    },
    truth: TRUTH,
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
    for (const event of fullRunEvents()) recorder.handler(event);
    await recorder.written();

    const validate = compileRunRecordSchema();
    const record = recorder.record();
    expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
  });

  it('writes the record to the given --out path', async () => {
    const dir = tempDir();
    const out = join(dir, 'out.json');
    const recorder = createRunRecorder({ ...baseRecorderOptions(), out });
    for (const event of fullRunEvents()) recorder.handler(event);

    const written = await recorder.written();
    expect(written).toBe(out);
    const onDisk = JSON.parse(readFileSync(out, 'utf8')) as { runId: string };
    expect(onDisk.runId).toBe(recorder.record().runId);
  });

  it('counts search.backtracks, repair.accepted and calls.tier1.count as literals', async () => {
    const recorder = createRunRecorder(baseRecorderOptions());
    for (const event of fullRunEvents()) recorder.handler(event);
    await recorder.written();

    const record = recorder.record();
    expect(record.search.backtracks).toBe(2);
    expect(record.repair.accepted).toBe(1);
    expect(record.calls.tier1.count).toBe(2);
  });

  it('makes usdCounterfactual >= usdBilled when a tier has a cache hit, and equal when it does not', async () => {
    const recorder = createRunRecorder(baseRecorderOptions());
    for (const event of fullRunEvents()) recorder.handler(event);
    await recorder.written();

    const record = recorder.record();
    // tier1 saw one fresh call and one cache hit.
    expect(record.calls.tier1.usdCounterfactual).toBeGreaterThan(record.calls.tier1.usdBilled);
    expect(record.calls.tier1.cacheHits).toBe(1);
    // tier2 saw only a fresh call: the two figures coincide.
    expect(record.calls.tier2.usdCounterfactual).toBe(record.calls.tier2.usdBilled);
    expect(record.calls.tier2.cacheHits).toBe(0);
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
    for (const event of fullRunEvents()) recorder.handler(event);
    await recorder.written();

    const record = recorder.record();
    expect(record.puzzle.id).toBe('guardian-27000');
    expect(record.runId).toMatch(/^guardian-27000--[A-Za-z0-9._-]+--\d{8}T\d{6}Z--[0-9a-f]{8}$/);
  });
});
