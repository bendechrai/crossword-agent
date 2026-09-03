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
 * SEED and PER_PUZZLE_BUDGET_USD below must match the constants of the same
 * name in `scripts/fixtures-refresh.ts`: the search's tie-break/jitter PRNG
 * and the profile's effective budget both have to match the population run
 * bit for bit for the offline replay to reproduce the same snapshot.
 */

const ROOT = repoRoot();
const CACHE_DIR = join(ROOT, 'test/fixtures/cache');
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

  it(
    'a missing cache entry fails with exit code 4 (OFFLINE_MISS), naming the cache key, not a hang or a network call',
    async () => {
      const brokenCache = await freshTmpDir('solve-it-broken-cache-');
      await cp(CACHE_DIR, brokenCache, { recursive: true });
      const files = await walkFiles(brokenCache);
      expect(files.length).toBeGreaterThan(0);

      // The deleted file necessarily belongs to exactly one fixture's clue
      // set (cache keys are content-addressed over prompt-visible fields,
      // including the clue text, which differs per puzzle) - which fixture
      // is not known ahead of time, so every fixture is tried and at least
      // one of them is asserted to hit the now-missing key.
      await rm(files[0]!);

      const misses: unknown[] = [];
      for (const fixture of FIXTURES) {
        try {
          // Always strict here, regardless of the fixture's own recorded
          // offlineMode: this test is specifically proving strict-mode miss
          // detection, not replaying a committed snapshot.
          await runOffline(fixture, brokenCache, 'strict');
        } catch (e) {
          misses.push(e);
        }
      }

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(misses.length).toBeGreaterThanOrEqual(1);
      for (const miss of misses) {
        expect(isCliError(miss)).toBe(true);
        if (!isCliError(miss)) continue;
        expect(miss.code).toBe(ExitCode.OFFLINE_MISS);
        expect(miss.message).toMatch(/cache key/);
      }
    },
    60_000,
  );
});
