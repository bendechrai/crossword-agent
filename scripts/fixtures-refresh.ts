import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ExitCode, isCliError } from '../src/cli/exit.js';
import type { GlobalOptions, SolveOptions as SolveCliOptions } from '../src/cli/options.js';
import { solveCommand } from '../src/cli/solve.js';
import type { SolveCommandOverrides } from '../src/cli/solve.js';
import type { RunRecord } from '../src/eval/types.js';
import { atomicWriteFile, repoRoot, resolveCacheDir } from '../src/util/fs.js';
import { log, setLogLevel } from '../src/util/log.js';

/**
 * T50 (B49): a network task, run deliberately and once by its author, never
 * in CI and never by any other task. It solves every committed fixture
 * through `src/cli/solve.ts`'s real `solveCommand` (T45) - the exact code
 * path `xw solve` runs - under the `baseline` profile with the network on,
 * so every seed/re-ask/escalation/repair candidate response the fixtures
 * need lands in the committed cache at `test/fixtures/cache/`. The
 * committed snapshot (`test/fixtures/runs/snapshots/<id>.json`) and the
 * measured letter accuracy (`test/fixtures/runs/bounds.json`) both come
 * from an **offline replay** against that same cache, not from the live
 * run's own record - see "Why an offline verification pass" below. Each
 * fixture's `bounds.json` entry also records which offline mode its
 * snapshot was captured with (`offlineMode: "strict" | "lenient"`), and
 * `test/integration/solve.test.ts` replays with that same mode.
 *
 * Orchestrator note (binding, narrower than the plan.md task text): only the
 * `baseline` profile is run here (not `no-repair`/`tier1-only` too), the
 * fixture set is T48's four american `.xd` puzzles plus T0's two synthetic
 * grids (six fixtures, not four), and the accuracy bound each fixture's
 * integration test asserts is derived from what was actually measured here
 * (`max(measuredLetters - 0.05, 0.10)`), not the spec's illustrative 0.92 -
 * 1950s NYT clues on a cheap tier-1 model are not assumed to clear 0.92.
 *
 * Why an offline verification pass, and why a lenient fallback.
 * `solve()`'s repair phase explores proposed edits in a fixed, seeded order
 * (`src/solver/repair.ts`'s own doc comment: "row-major order, then
 * candidate letters in alphabetical order, so the pass is reproducible
 * without a PRNG"), but empirically - verified against this project's own
 * committed fixtures, not assumed - a *live* population run's own resulting
 * cache does not always contain every entry a later **strict** `--offline`
 * replay of the identical puzzle/profile/seed goes on to ask for: a live
 * run's exhaustive repair-phase exploration (every filled cell, every
 * candidate letter) is itself sensitive to which candidate answers happen
 * to already be in-memory (`CandidateService`'s per-run ledger, B43) at each
 * step, which a live run builds up against real network timing. Two
 * **offline** replays against a *fixed* cache, by contrast, are
 * deterministic (empirically verified repeatedly: identical cache, identical
 * seed, byte-identical `RunRecord.accuracy`/`perSlot` every time - an
 * offline request never races against network latency).
 *
 * So after each live pass, this script tries a **strict** offline replay
 * against the now-updated cache. A handful of extra live passes (up to
 * MAX_LIVE_ATTEMPTS) are given to close a genuine, closeable gap. For at
 * least one committed fixture (`synthetic-5x5`, a puzzle the search already
 * solves perfectly, so repair's entire exhaustive exploration is chasing
 * marginal, noisy score differences on cells that are already correct) this
 * was measured not to converge even after 7 extra live passes, always
 * missing the exact same single proposal - a live run's own repair
 * exploration apparently never revisits it, only a "clean" replay reaches
 * it. Since `src/solver/repair.ts` is frozen for this task (an editable fix
 * would belong to whichever task owns it), the fallback here is to accept
 * that gap the way `--offline-lenient` already does for any other missing
 * entry: after MAX_LIVE_ATTEMPTS, this script captures the committed
 * snapshot with `--offline-lenient` instead of strict `--offline`
 * (confirmed equally deterministic against a fixed cache - two lenient
 * replays produce byte-identical `RunRecord`s in every case tried). Most
 * fixtures converge under strict `--offline` well before the cap; the ones
 * that do not still get a reproducible, honestly-measured snapshot.
 *
 * A fixed `--seed` (SEED below) is used for every solve here, and
 * `test/integration/solve.test.ts` passes the same seed and the same
 * per-fixture offline mode, so its replay reproduces this run's exact
 * snapshot.
 */

const SEED = 42;
/** Matches the orchestrator note, not the spec's `bench --max-usd` default of 25. */
const PER_PUZZLE_BUDGET_USD = 0.4;
const TOTAL_BUDGET_USD = 3;
/** Extra live passes tried, beyond the first, before falling back to `--offline-lenient` (see module doc). */
const MAX_LIVE_ATTEMPTS = 2;

interface FixtureSpec {
  id: string;
  /**
   * How `solveCommand`'s target resolves (B16): a real path for the four
   * `.xd` fixtures (the extension-dispatch loader route), or `library` for
   * the two synthetic `NormalisedPuzzleFile` fixtures under
   * `test/fixtures/puzzles/` - a bare `.json` path would dispatch through
   * the Guardian adapter instead (`src/puzzle/adapters/index.ts`'s own doc
   * comment: a normalised file is read through `puzzle/library.ts`, not the
   * extension dispatcher), so those two are staged into a throwaway library
   * directory (`<tmp>/<source>/<id>.json`, matching the fixture's own
   * `source` field) and solved by id instead, exactly the pattern
   * `test/unit/cli/solve.test.ts` (T45) already uses for this fixture.
   */
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
  /** `max(measuredLetters - 0.05, 0.10)`: the floor the integration test asserts. */
  minLetters: number;
  perfect: boolean;
  status: string;
  /** Which offline mode captured the committed snapshot - see the module doc comment. */
  offlineMode: OfflineMode;
}

type BoundsFile = Record<string, FixtureBound>;

/** `test/fixtures/puzzles/<id>.json`'s own `source` field, read without importing the puzzle type. */
async function sourceOf(jsonPath: string): Promise<string> {
  const raw = await readFile(jsonPath, 'utf8');
  const parsed = JSON.parse(raw) as { source: string };
  return parsed.source;
}

/** What `solveCommand` needs to find one fixture: its target, and a library dir for the `library` kind. */
async function resolveTarget(
  fixture: FixtureSpec,
  root: string,
): Promise<{ target: string; puzzlesDir?: string }> {
  const path = join(root, fixture.path);
  if (fixture.kind === 'path') return { target: path };

  const source = await sourceOf(path);
  const libraryDir = await mkdtemp(join(tmpdir(), 'fixtures-refresh-library-'));
  const destDir = join(libraryDir, source);
  await mkdir(destDir, { recursive: true });
  await copyFile(path, join(destDir, `${fixture.id}.json`));
  return { target: fixture.id, puzzlesDir: libraryDir };
}

/**
 * One `solveCommand` call. An offline miss (strict mode only - lenient never
 * misses) is reported back rather than thrown, so the caller's fill loop can
 * act on it; any other failure (including a *live* call ending in error)
 * propagates, since only a strict-offline cache miss is an expected,
 * actionable outcome here.
 */
async function attemptSolve(
  target: string,
  puzzlesDir: string | undefined,
  cacheDir: string,
  out: string,
  mode: 'live' | OfflineMode,
): Promise<{ record: RunRecord } | { miss: string }> {
  const overrides: SolveCommandOverrides = { cacheDir, env: process.env, isTty: false };
  if (puzzlesDir !== undefined) overrides.puzzlesDir = puzzlesDir;

  const cliOptions: SolveCliOptions = {
    profile: 'baseline',
    budgetUsd: PER_PUZZLE_BUDGET_USD,
    seed: SEED,
    verbose: mode === 'live' ? 1 : 0,
    watch: false,
    offline: mode === 'strict',
    offlineLenient: mode === 'lenient',
    trace: false,
    inferenceLog: mode === 'live',
    out,
  };
  const global: GlobalOptions = { color: false };

  try {
    await solveCommand(target, cliOptions, global, overrides);
  } catch (e) {
    if (mode === 'strict' && isCliError(e) && e.code === ExitCode.OFFLINE_MISS) {
      return { miss: e.message };
    }
    throw e;
  }
  return { record: JSON.parse(await readFile(out, 'utf8')) as RunRecord };
}

/**
 * One fixture, start to finish: alternate live passes (network on, the
 * `baseline` profile, the per-puzzle budget cap and a fixed seed) with a
 * strict offline replay check against the same cache, up to
 * MAX_LIVE_ATTEMPTS times; falls back to an `--offline-lenient` capture if
 * strict replay never converges (see the module doc comment). Returns the
 * offline-verified record's measurements, which mode captured it, and the
 * live spend to add to the running total.
 */
async function refreshOne(
  fixture: FixtureSpec,
  root: string,
  cacheDir: string,
): Promise<{
  accuracy: RunRecord['accuracy'];
  status: RunRecord['status'];
  usdBilled: number;
  offlineMode: OfflineMode;
}> {
  const snapshotPath = join(root, 'test/fixtures/runs/snapshots', `${fixture.id}.json`);
  await mkdir(dirname(snapshotPath), { recursive: true });
  const liveOut = join(dirname(snapshotPath), `.${fixture.id}.live-scratch.json`);

  const { target, puzzlesDir } = await resolveTarget(fixture, root);

  let usdBilled = 0;
  let verified: RunRecord | null = null;
  let offlineMode: OfflineMode = 'strict';
  let lastMiss = '';

  for (let attempt = 0; attempt <= MAX_LIVE_ATTEMPTS; attempt += 1) {
    const live = await attemptSolve(target, puzzlesDir, cacheDir, liveOut, 'live');
    if (!('record' in live)) {
      throw new Error(`fixtures-refresh: "${fixture.id}": a live (non-offline) solve reported an offline miss - unreachable`);
    }
    usdBilled += live.record.calls.tier1.usdBilled + live.record.calls.tier2.usdBilled;

    const check = await attemptSolve(target, puzzlesDir, cacheDir, snapshotPath, 'strict');
    if ('record' in check) {
      verified = check.record;
      break;
    }
    lastMiss = check.miss;

    log.warn(
      `  [${fixture.id}] strict offline replay still misses a cache entry after live pass ${String(attempt + 1)}: ` +
        `${check.miss} - making another live pass to fill the gap`,
    );
  }

  if (verified === null) {
    log.warn(
      `  [${fixture.id}] strict offline replay did not converge after ${String(MAX_LIVE_ATTEMPTS + 1)} live passes ` +
        `(last miss: ${lastMiss}); capturing the committed snapshot with --offline-lenient instead (see module doc comment).`,
    );
    const lenient = await attemptSolve(target, puzzlesDir, cacheDir, snapshotPath, 'lenient');
    if (!('record' in lenient)) {
      throw new Error(`fixtures-refresh: "${fixture.id}": --offline-lenient reported a miss - unreachable`);
    }
    verified = lenient.record;
    offlineMode = 'lenient';
  }

  await rm(liveOut, { force: true });

  if (verified.status === 'error') {
    log.warn(`  [${fixture.id}] offline-verified run ended in error: ${verified.error ?? 'unknown'}`);
  }
  return { accuracy: verified.accuracy, status: verified.status, usdBilled, offlineMode };
}

async function main(): Promise<void> {
  setLogLevel('info');

  if (process.env.NEBIUS_API_KEY === undefined || process.env.NEBIUS_API_KEY.trim() === '') {
    throw new Error(
      'fixtures-refresh: NEBIUS_API_KEY is not set. This is a NETWORK task (T50) and refuses to ' +
        'fabricate cache entries; set NEBIUS_API_KEY (see .env.example) and rerun.',
    );
  }

  const root = repoRoot();
  const cacheDir = resolveCacheDir({ flag: 'test/fixtures/cache', root });

  // Optional operator escape hatch: FIXTURES_REFRESH_ONLY=id1,id2 restricts
  // this run to a subset of FIXTURES, for a cheap validation pass or to
  // redo a single fixture without re-spending on the rest. Unset runs all.
  const only = process.env.FIXTURES_REFRESH_ONLY;
  const selected =
    only === undefined || only.trim() === ''
      ? FIXTURES
      : FIXTURES.filter((f) => only.split(',').includes(f.id));

  log.info(
    `fixtures-refresh: solving ${String(selected.length)} fixtures under the "baseline" profile, ` +
      `budget-usd ${String(PER_PUZZLE_BUDGET_USD)}/puzzle, total cap ${String(TOTAL_BUDGET_USD)} USD. ` +
      `Cache dir: ${cacheDir}`,
  );
  log.warn(
    'fixtures-refresh: promptVersion is frozen at "1" for v1 (B49) - a future bump invalidates ' +
      'every entry in this cache and must land with a regenerated cache in the same commit.',
  );

  // Start from whatever bounds.json already has on disk (e.g. from an
  // earlier full run) so a partial FIXTURES_REFRESH_ONLY re-run only
  // touches the entries it actually re-measures.
  const boundsPath = join(root, 'test/fixtures/runs/bounds.json');
  const bounds: BoundsFile = await readFile(boundsPath, 'utf8')
    .then((raw) => JSON.parse(raw) as BoundsFile)
    .catch(() => ({}));
  let totalUsdBilled = 0;

  for (const fixture of selected) {
    if (totalUsdBilled >= TOTAL_BUDGET_USD) {
      log.warn(
        `fixtures-refresh: stopping before "${fixture.id}" - cumulative spend ` +
          `${totalUsdBilled.toFixed(4)} USD has reached the ${String(TOTAL_BUDGET_USD)} USD cap.`,
      );
      break;
    }

    log.info(`fixtures-refresh: solving "${fixture.id}"...`);
    const { accuracy, status, usdBilled, offlineMode } = await refreshOne(fixture, root, cacheDir);
    totalUsdBilled += usdBilled;

    const minLetters = Math.max(accuracy.letters - 0.05, 0.1);
    bounds[fixture.id] = {
      profile: 'baseline',
      measuredLetters: accuracy.letters,
      measuredWords: accuracy.words,
      minLetters,
      perfect: accuracy.perfect,
      status,
      offlineMode,
    };

    log.info(
      `fixtures-refresh: "${fixture.id}" status=${status} letters=${accuracy.letters.toFixed(4)} ` +
        `words=${accuracy.words.toFixed(4)} offlineMode=${offlineMode} spend=${usdBilled.toFixed(4)} USD ` +
        `(total ${totalUsdBilled.toFixed(4)} USD)`,
    );
  }

  await atomicWriteFile(boundsPath, `${JSON.stringify(bounds, null, 2)}\n`);
  log.info(`fixtures-refresh: wrote ${boundsPath}`);
  log.info(`fixtures-refresh: total measured spend ${totalUsdBilled.toFixed(4)} USD.`);
}

await main();
