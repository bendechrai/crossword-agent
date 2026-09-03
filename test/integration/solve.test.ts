import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExitCode, isCliError } from '../../src/cli/exit.js';
import type { GlobalOptions, SolveOptions as SolveCliOptions } from '../../src/cli/options.js';
import { solveCommand } from '../../src/cli/solve.js';
import type { SolveCommandOverrides } from '../../src/cli/solve.js';
import type { RunRecord } from '../../src/eval/types.js';
import { repoRoot } from '../../src/util/fs.js';

/**
 * T50 (B49). Runs `xw solve <fixture> --offline` (via `solveCommand`, the
 * exact code `xw solve` runs) against the committed cache at
 * `test/fixtures/cache/` for every fixture `scripts/fixtures-refresh.ts`
 * populated, with `globalThis.fetch` stubbed to throw for the duration so a
 * network fallback fails the test loudly instead of silently spending money.
 *
 * Two things are asserted per fixture, matching the plan's "both assertion
 * styles" decision: an accuracy **bound** read from the committed
 * `test/fixtures/runs/bounds.json` (so a real regression fails), and an
 * exact match of the accuracy block and every slot's filled answer against
 * the committed snapshot at `test/fixtures/runs/snapshots/<id>.json` (so an
 * unintended behaviour change shows up as a diff). `fixtures:refresh` is the
 * one sanctioned way to move either.
 *
 * Each fixture is replayed with the offline mode (`offline` or
 * `offline-lenient`) recorded in its own `bounds.json` entry
 * (`offlineMode`), not always strict `--offline`: `scripts/fixtures-refresh.ts`'s
 * module doc comment explains why a strict replay is not achievable for
 * every fixture and why `--offline-lenient` is an equally deterministic,
 * honestly-labelled fallback for the ones where it is not. The dedicated
 * "missing cache entry" test below always forces strict mode, since that is
 * what it is specifically proving.
 *
 * SEED, PER_PUZZLE_BUDGET_USD and WORDLIST_PATH below must match the
 * constants of the same name in `scripts/fixtures-refresh.ts`: the search's
 * tie-break/jitter PRNG, the profile's effective budget and the word list the
 * repair pass gates and fills with all have to match the population run bit
 * for bit for the offline replay to reproduce the same snapshot.
 */

const ROOT = repoRoot();
const CACHE_DIR = join(ROOT, 'test/fixtures/cache');
/**
 * The committed word list, pinned rather than left to default to
 * `data/wordlist/collaborative.txt`. That file is `.gitignore`d, is downloaded
 * by `npm run wordlist:fetch` from the moving head of an upstream repository,
 * and is therefore absent on a fresh checkout and different in content between
 * two machines that fetched it on different days - while `src/solver/repair.ts`
 * reads it for its plausibility gate, its distance-2 neighbour enumeration and
 * its final empty-slot fill. Leaving it ambient made this suite pass in the
 * worktree that had run `wordlist:fetch` and fail everywhere else, with slots
 * the repair pass could no longer fill coming back `null`.
 */
const WORDLIST_PATH = join(ROOT, 'test/fixtures/wordlist.txt');
const SEED = 42;
const PER_PUZZLE_BUDGET_USD = 0.4;
/** plan.md decision: the committed cache must stay under 20 MB. */
const MAX_CACHE_BYTES = 20 * 1024 * 1024;

interface FixtureSpec {
  id: string;
  /** See `scripts/fixtures-refresh.ts`'s `FixtureSpec.kind` doc comment. */
  kind: 'path' | 'library';
  path: string;
}

const FIXTURES: readonly FixtureSpec[] = [
  { id: 'nyt-1950-10-12', kind: 'path', path: 'puzzles/fixtures/nyt-1950-10-12.xd' },
  { id: 'nyt-1955-06-06', kind: 'path', path: 'puzzles/fixtures/nyt-1955-06-06.xd' },
  { id: 'nyt-1959-04-24', kind: 'path', path: 'puzzles/fixtures/nyt-1959-04-24.xd' },
  { id: 'nyt-1962-03-21', kind: 'path', path: 'puzzles/fixtures/nyt-1962-03-21.xd' },
  { id: 'synthetic-5x5', kind: 'library', path: 'test/fixtures/puzzles/synthetic-5x5.json' },
  { id: 'synthetic-7x7', kind: 'library', path: 'test/fixtures/puzzles/synthetic-7x7.json' },
];

type OfflineMode = 'strict' | 'lenient';

interface FixtureBound {
  profile: 'baseline';
  measuredLetters: number;
  measuredWords: number;
  minLetters: number;
  perfect: boolean;
  status: string;
  /** Which offline mode captured this fixture's committed snapshot - see the module doc comment. */
  offlineMode: OfflineMode;
}

type BoundsFile = Record<string, FixtureBound>;

const tmpDirs: string[] = [];

async function freshTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function loadBounds(): Promise<BoundsFile> {
  const raw = await readFile(join(ROOT, 'test/fixtures/runs/bounds.json'), 'utf8');
  return JSON.parse(raw) as BoundsFile;
}

async function loadSnapshot(id: string): Promise<RunRecord> {
  const raw = await readFile(join(ROOT, 'test/fixtures/runs/snapshots', `${id}.json`), 'utf8');
  return JSON.parse(raw) as RunRecord;
}

async function sourceOf(jsonPath: string): Promise<string> {
  const raw = await readFile(jsonPath, 'utf8');
  return (JSON.parse(raw) as { source: string }).source;
}

/**
 * Resolves what `solveCommand` needs to find this fixture: a real path for
 * the four `.xd` fixtures, or a throwaway one-entry library directory for
 * the two synthetic `NormalisedPuzzleFile` fixtures (a bare `.json` path
 * dispatches through the Guardian adapter instead - see
 * `scripts/fixtures-refresh.ts`'s `FixtureSpec.kind` doc comment for why).
 */
async function targetFor(fixture: FixtureSpec): Promise<{ target: string; puzzlesDir?: string }> {
  const path = join(ROOT, fixture.path);
  if (fixture.kind === 'path') return { target: path };

  const source = await sourceOf(path);
  const libraryDir = await freshTmpDir('solve-it-library-');
  const destDir = join(libraryDir, source);
  await mkdir(destDir, { recursive: true });
  await cp(path, join(destDir, `${fixture.id}.json`));
  return { target: fixture.id, puzzlesDir: libraryDir };
}

async function runOffline(
  fixture: FixtureSpec,
  cacheDir: string,
  offlineMode: OfflineMode,
): Promise<RunRecord> {
  const { target, puzzlesDir } = await targetFor(fixture);
  const out = join(await freshTmpDir('solve-it-out-'), 'run.json');
  const overrides: SolveCommandOverrides = {
    cacheDir,
    wordlistPath: WORDLIST_PATH,
    inferenceLogDir: await freshTmpDir('solve-it-inflog-'),
    // solveCommand builds the real Nebius transport unconditionally (only
    // the candidate service's --offline flag decides whether it is ever
    // called), so construction still requires *a* key even offline. A
    // placeholder proves no real credential is needed for an offline run;
    // the stubbed globalThis.fetch above proves it is never actually used.
    env: { NEBIUS_API_KEY: 'offline-test-placeholder-key' },
    isTty: false,
  };
  if (puzzlesDir !== undefined) overrides.puzzlesDir = puzzlesDir;

  const opts: SolveCliOptions = {
    profile: 'baseline',
    budgetUsd: PER_PUZZLE_BUDGET_USD,
    seed: SEED,
    verbose: 0,
    watch: false,
    offline: offlineMode === 'strict',
    offlineLenient: offlineMode === 'lenient',
    trace: false,
    inferenceLog: false,
    out,
  };
  const global: GlobalOptions = { color: false };

  await solveCommand(target, opts, global, overrides);
  return JSON.parse(await readFile(out, 'utf8')) as RunRecord;
}

/** slotId -> what was actually filled in, for the per-slot half of the snapshot comparison. */
function perSlotFilled(record: RunRecord): Record<string, { filled: string | null; correct: boolean }> {
  const out: Record<string, { filled: string | null; correct: boolean }> = {};
  for (const slot of record.perSlot) out[slot.slotId] = { filled: slot.filled, correct: slot.correct };
  return out;
}

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out.sort();
}

describe('integration: xw solve --offline against the committed fixture cache', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // B6/plan.md decision: the integration suite proves zero network activity
    // by stubbing globalThis.fetch with a throwing function for the duration.
    fetchSpy = vi.fn(() => {
      throw new Error('network access attempted during an --offline integration test');
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('stays under the 20 MB budget (plan.md decision)', async () => {
    const files = await walkFiles(CACHE_DIR);
    expect(files.length).toBeGreaterThan(0);

    let total = 0;
    for (const file of files) total += (await stat(file)).size;

    expect(total).toBeLessThan(MAX_CACHE_BYTES);
  });

  for (const fixture of FIXTURES) {
    it(
      `"${fixture.id}": solves offline within its measured accuracy bound and matches the committed snapshot`,
      async () => {
        const bounds = await loadBounds();
        const bound = bounds[fixture.id];
        expect(bound, `no bounds.json entry for "${fixture.id}" - run npm run fixtures:refresh`).toBeDefined();

        const record = await runOffline(fixture, CACHE_DIR, bound!.offlineMode);

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(record.accuracy.letters).toBeGreaterThanOrEqual(bound!.minLetters);

        const snapshot = await loadSnapshot(fixture.id);
        expect(record.accuracy).toEqual(snapshot.accuracy);
        expect(perSlotFilled(record)).toEqual(perSlotFilled(snapshot));
      },
      30_000,
    );
  }

  /**
   * Extracts the sha1 cache key from an OFFLINE_MISS message
   * (`src/candidates/service.ts`'s `offlineMiss`: `... (cache key <key>)`).
   */
  function missKeyOf(e: unknown): string {
    expect(isCliError(e), `expected a CliError, got: ${String(e)}`).toBe(true);
    if (!isCliError(e)) throw e;
    expect(e.code).toBe(ExitCode.OFFLINE_MISS);
    expect(e.message).toMatch(/cache key/);
    const match = /cache key ([0-9a-f]+)\)/.exec(e.message);
    expect(match, `OFFLINE_MISS message did not name a cache key: "${e.message}"`).not.toBeNull();
    return match![1]!;
  }

  /** A strict --offline run against `cacheDir`; `null` when it succeeds (no miss). */
  async function tryStrict(fixture: FixtureSpec, cacheDir: string): Promise<string | null> {
    try {
      await runOffline(fixture, cacheDir, 'strict');
      return null;
    } catch (e) {
      return missKeyOf(e);
    }
  }

  /**
   * Runs `fixture` with `--offline-lenient` (never misses) and `inferenceLog:
   * true`, then returns the `cacheKey` of the first record with `cacheHit:
   * true` it wrote - a key genuinely served out of `cacheDir`, not one that
   * happens to be absent. `--offline-lenient` still exercises the exact same
   * cache-lookup code path as `--offline` (`src/candidates/service.ts`'s
   * `lookup`); only what happens on a miss differs.
   */
  async function firstCacheHitKey(fixture: FixtureSpec, cacheDir: string): Promise<string> {
    const inferenceLogDir = await freshTmpDir('solve-it-inflog-hit-');
    const { target, puzzlesDir } = await targetFor(fixture);
    const out = join(await freshTmpDir('solve-it-out-hit-'), 'run.json');
    const overrides: SolveCommandOverrides = {
      cacheDir,
      wordlistPath: WORDLIST_PATH,
      inferenceLogDir,
      env: { NEBIUS_API_KEY: 'offline-test-placeholder-key' },
      isTty: false,
    };
    if (puzzlesDir !== undefined) overrides.puzzlesDir = puzzlesDir;

    const opts: SolveCliOptions = {
      profile: 'baseline',
      budgetUsd: PER_PUZZLE_BUDGET_USD,
      seed: SEED,
      verbose: 0,
      watch: false,
      offline: false,
      offlineLenient: true,
      trace: false,
      inferenceLog: true,
      out,
    };
    const global: GlobalOptions = { color: false };
    await solveCommand(target, opts, global, overrides);

    const logFiles = (await readdir(inferenceLogDir)).filter((name) => name.endsWith('.jsonl')).sort();
    expect(logFiles.length, `no inference log written to ${inferenceLogDir}`).toBeGreaterThan(0);
    const lines = (await readFile(join(inferenceLogDir, logFiles[0]!), 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '');
    for (const line of lines) {
      const record = JSON.parse(line) as { cacheHit: boolean; cacheKey: string };
      if (record.cacheHit) return record.cacheKey;
    }
    throw new Error(
      `firstCacheHitKey: no cache-hit record for "${fixture.id}" against the intact committed cache - ` +
        'cannot pick a genuinely-served key to delete',
    );
  }

  it(
    'a genuinely cached entry, once deleted, fails strict --offline with exit code 4 naming exactly that key ' +
      '(T50 review finding 1: a strict replay of the INTACT cache already misses on an uncached repair/reask ' +
      'entry for every fixture - see scripts/fixtures-refresh.ts module doc - so this test must prove the ' +
      'deleted key specifically, not merely that some miss occurs)',
    async () => {
      // Baseline: what strict --offline against the INTACT committed cache
      // already misses on for each fixture, with no file deleted. Expected
      // to be non-null for every fixture today (see the doc comment above);
      // recorded per fixture, not asserted, so this test does not itself
      // depend on that being true forever.
      const baselineByFixture = new Map<string, string | null>();
      for (const fixture of FIXTURES) {
        baselineByFixture.set(fixture.id, await tryStrict(fixture, CACHE_DIR));
      }

      const chosen = FIXTURES[0]!;
      const chosenBaselineKey = baselineByFixture.get(chosen.id) ?? null;

      const hitKey = await firstCacheHitKey(chosen, CACHE_DIR);
      // Sanity: the key we are about to delete is not simply the fixture's
      // pre-existing baseline miss under another name.
      expect(hitKey).not.toBe(chosenBaselineKey);

      const brokenCache = await freshTmpDir('solve-it-broken-cache-');
      await cp(CACHE_DIR, brokenCache, { recursive: true });
      const entryFile = join(brokenCache, hitKey.slice(0, 2), `${hitKey}.json`);
      await stat(entryFile); // sanity: it really was on disk before deletion
      await rm(entryFile);

      const brokenKey = await tryStrict(chosen, brokenCache);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(brokenKey, `expected "${chosen.id}" to miss on the deleted key ${hitKey} once it is gone`).not.toBeNull();
      expect(brokenKey).toBe(hitKey);
      expect(brokenKey).not.toBe(chosenBaselineKey);
    },
    120_000,
  );
});
