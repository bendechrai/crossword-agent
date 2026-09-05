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
import { resolveProfile } from '../src/profiles/loader.js';

/**
 * T50 (B49), narrowed by T56: a network task, run deliberately and never in
 * CI and never by any other task. It solves every committed fixture through
 * `src/cli/solve.ts`'s real `solveCommand` (T45) - the exact code path `xw
 * solve` runs - under the `baseline` profile with the network on, so every
 * seed/re-ask/escalation/repair candidate response the fixtures need lands
 * in the committed cache at `test/fixtures/cache/`. The committed snapshot
 * (`test/fixtures/runs/snapshots/<id>.json`) and the measured letter
 * accuracy (`test/fixtures/runs/bounds.json`) both come from an **offline
 * replay** against that same cache, not from the live run's own record - see
 * "Why an offline verification pass" below. Each fixture's `bounds.json`
 * entry also records which offline mode its snapshot was captured with
 * (`offlineMode: "strict" | "lenient"`), and `test/integration/solve.test.ts`
 * replays with that same mode.
 *
 * T56 (no-distribution policy, superseding A3/B47 - see
 * docs/decisions/2026-09-03-spec-review.md's dated addendum): no real
 * crossword puzzle is committed to this repository in any form, including a
 * cache entry, snapshot or bound derived from one. The fixture set is
 * therefore T0's two synthetic grids only (`synthetic-5x5`,
 * `synthetic-7x7`), not the four real `.xd` puzzles T48 once committed under
 * `puzzles/fixtures/` (deleted by T56). The accuracy bound each fixture's
 * integration test asserts is derived from what was actually measured here
 * (`max(measuredLetters - 0.05, 0.10)`), not the spec's illustrative 0.92.
 *
 * Why a strict offline replay does not always converge, and why this script
 * takes only one live pass per fixture (T50 review finding 2 - the previous
 * revision of this comment attributed the gap to timing-sensitive
 * exploration order in `src/solver/repair.ts`; that diagnosis was wrong and
 * has been replaced with the verified one below).
 *
 * `src/llm/tierRouter.ts` (T49, B41) sends the reasoning-off parameter
 * (`reasoning_effort: "none"`) only when `req.purpose === 'seed'` - never for
 * `reask`, `escalate` or `repair`. On a reasoning-capable tier-1 model, every
 * non-seed call therefore leaves reasoning on: the model spends its whole
 * `sampling.maxTokens` budget on chain-of-thought, the JSON answer is never
 * written, and `src/llm/parser.ts` fails with "no JSON object found". This is
 * verified, not assumed: this worktree's own live inference log
 * (`logs/inference/2026-09-03.jsonl`, 3988 records) shows 2034 of 2039 tier-1
 * `repair` records and 74 of 74 tier-1 `reask` records with exactly that
 * signature (`reasoningTokens: 512`, `completionTokens: 1024`, `parseError:
 * "no JSON object found"`).
 *
 * `src/candidates/service.ts`'s `askSingle` only calls `cache.set` when the
 * parse produced a real `response` (`response !== null`); a parse failure is
 * never written to the cache in any shape (unlike a successfully parsed empty
 * candidate list, which *is* cached as a "known dead end", B23). So these
 * keys cannot exist in the committed cache no matter how many live passes are
 * made: a second or third live pass reissues the exact same request (same
 * clue, same model, same sampling parameters, same cache key) and gets the
 * exact same truncated, non-JSON reply every time, because nothing about the
 * request changed. An earlier revision of this script took up to three live
 * passes per fixture, re-spending real money on precisely this deterministic,
 * unfixable-by-retrying failure before falling back the same way a single
 * pass does; that retry loop has been removed, and this script now takes
 * exactly one live pass per fixture.
 *
 * The practical consequence: strict `--offline` replay of the committed cache
 * cannot converge for any fixture that reaches a `reask` or `repair` call on
 * a reasoning-capable tier-1 model, until either `tierRouter.ts` sends
 * reasoning-off for every tier-1 purpose (not just `seed`), or
 * `CandidateService` starts caching negative *parse* outcomes the way it
 * already caches negative *candidate* outcomes. Both changes are out of
 * scope here: `src/llm/tierRouter.ts` and `src/candidates/service.ts` are
 * outside this task's ownership (T50 reads, but must not edit, `src/solver/*`
 * and every other `src/**` module) and neither is touched by this script.
 *
 * So instead: one live pass populates whatever the cache can hold, a strict
 * offline replay is attempted against the result, and - since it will not
 * converge for a fixture that hits the gap above - the fallback below
 * captures the committed snapshot with `--offline-lenient` instead of strict
 * `--offline` (confirmed deterministic against a fixed cache: two lenient
 * replays produce byte-identical `RunRecord`s in every case tried). A
 * fixture that never reaches a non-seed tier-1 call converges under strict
 * `--offline` on the first check; the rest still get a reproducible,
 * honestly-measured snapshot via `--offline-lenient`.
 *
 * A fixed `--seed` (SEED below) is used for every solve here, and
 * `test/integration/solve.test.ts` passes the same seed, the same word list
 * and the same per-fixture offline mode, so its replay reproduces this run's
 * exact snapshot.
 *
 * Why the word list is pinned (WORDLIST_PATH below). `src/solver/repair.ts`
 * reads a word list for its plausibility gate, its distance-2 neighbour
 * enumeration and its final empty-slot fill, and by default that word list is
 * `data/wordlist/collaborative.txt`: `.gitignore`d, downloaded by `npm run
 * wordlist:fetch` from the *moving* head of an upstream repository, hence
 * absent on a fresh checkout and different in content between two machines
 * that fetched it on different days. It was the one input of an `--offline`
 * replay that the committed cache did not pin, and it is why the integration
 * suite passed in the worktree that had fetched it and failed on main, with
 * slots the repair pass could no longer fill coming back `null`. Both this
 * script and the integration test now pin the committed
 * `test/fixtures/wordlist.txt` through `SolveCommandOverrides.wordlistPath`.
 *
 * What "deterministic" does and does not cover. Two offline replays of the
 * same cache agree on every field that records a decision - the fill, the
 * accuracy block, the per-slot answers, the search and repair counters, and
 * which budget caps were hit. They do not agree on the fields that are
 * measurements of the run itself: `runId`, `timestamp`, `wallMs`,
 * `latencyMs` and `budgetHits[].atMs` are elapsed times and identifiers, they
 * feed no decision, and `test/integration/solve.test.ts` accordingly asserts
 * the accuracy block and the per-slot answers rather than the whole file.
 * `src/cli/solve.ts` uncaps `wallMs` for an offline replay so that no
 * decision can turn on one of these readings.
 *
 * Regenerating the snapshots without spending anything: set
 * `FIXTURES_REFRESH_OFFLINE_ONLY=1`. That skips the live pass entirely (and
 * the `NEBIUS_API_KEY` requirement with it) and re-captures every snapshot and
 * bound from the already-committed cache, which is exactly what is wanted
 * after a change that alters the deterministic replay path but not the set of
 * requests the cache has to answer. `usdBilled` is 0 for every fixture in that
 * mode, so the running spend total stays at 0.
 */

const SEED = 42;
/** Matches the orchestrator note, not the spec's `bench --max-usd` default of 25. */
const PER_PUZZLE_BUDGET_USD = 0.4;
const TOTAL_BUDGET_USD = 3;
/** Relative to the repo root; see the module doc comment for why this is pinned. */
const WORDLIST_PATH = 'test/fixtures/wordlist.txt';
/** Never sent anywhere: an offline pass makes no call at all (see `attemptSolve`). */
const OFFLINE_PLACEHOLDER_KEY = 'offline-replay-placeholder-key';

interface FixtureSpec {
  id: string;
  /**
   * How `solveCommand`'s target resolves (B16). Both fixtures are `library`:
   * the two synthetic `NormalisedPuzzleFile` fixtures under
   * `test/fixtures/puzzles/` - a bare `.json` path would dispatch through
   * the Guardian adapter instead (`src/puzzle/adapters/index.ts`'s own doc
   * comment: a normalised file is read through `puzzle/library.ts`, not the
   * extension dispatcher), so each is staged into a throwaway library
   * directory (`<tmp>/<source>/<id>.json`, matching the fixture's own
   * `source` field) and solved by id instead, exactly the pattern
   * `test/unit/cli/solve.test.ts` (T45) already uses for this fixture. The
   * `'path'` variant (a real file-path target, once used for the four real
   * `.xd` fixtures T56 removed) is kept in the union rather than deleted,
   * since `resolveTarget` below still handles it correctly for any future
   * fixture that is a real file rather than a library entry.
   */
  kind: 'path' | 'library';
  path: string;
}

const FIXTURES: readonly FixtureSpec[] = [
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
  const overrides: SolveCommandOverrides = {
    cacheDir,
    // The live pass and the offline verification pass must see the same word
    // list, or the cache is populated for one repair path and replayed on
    // another; see the module doc comment.
    wordlistPath: join(repoRoot(), WORDLIST_PATH),
    // `solveCommand` builds the Nebius transport unconditionally (only the
    // candidate service's offline flag decides whether it is ever called), so
    // construction still needs *a* key. An offline pass therefore gets a
    // placeholder when the environment has none, which is what lets
    // FIXTURES_REFRESH_OFFLINE_ONLY run with no credential at all; a live pass
    // gets the real environment and nothing else.
    env:
      mode === 'live'
        ? process.env
        : { ...process.env, NEBIUS_API_KEY: process.env.NEBIUS_API_KEY ?? OFFLINE_PLACEHOLDER_KEY },
    isTty: false,
  };
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
 * One fixture, start to finish: a single live pass (network on, the
 * `baseline` profile, the per-puzzle budget cap and a fixed seed), then a
 * strict offline replay check against the resulting cache; falls back to an
 * `--offline-lenient` capture if strict replay does not converge (see the
 * module doc comment for the verified, non-retryable reason a second live
 * pass would not help). Returns the offline-verified record's measurements,
 * which mode captured it, and the live spend to add to the running total.
 */
async function refreshOne(
  fixture: FixtureSpec,
  root: string,
  cacheDir: string,
  offlineOnly: boolean,
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
  if (!offlineOnly) {
    const live = await attemptSolve(target, puzzlesDir, cacheDir, liveOut, 'live');
    if (!('record' in live)) {
      throw new Error(`fixtures-refresh: "${fixture.id}": a live (non-offline) solve reported an offline miss - unreachable`);
    }
    usdBilled = live.record.calls.tier1.usdBilled + live.record.calls.tier2.usdBilled;
    await rm(liveOut, { force: true });
  }

  let verified: RunRecord;
  let offlineMode: OfflineMode;

  const check = await attemptSolve(target, puzzlesDir, cacheDir, snapshotPath, 'strict');
  if ('record' in check) {
    verified = check.record;
    offlineMode = 'strict';
  } else {
    log.warn(
      `  [${fixture.id}] strict offline replay misses a cache entry: ${check.miss} - a second live pass would ` +
        'not close this gap (see module doc comment: it is a deterministic uncached parse failure, not a ' +
        'timing-sensitive exploration order), so capturing the committed snapshot with --offline-lenient instead.',
    );
    const lenient = await attemptSolve(target, puzzlesDir, cacheDir, snapshotPath, 'lenient');
    if (!('record' in lenient)) {
      throw new Error(`fixtures-refresh: "${fixture.id}": --offline-lenient reported a miss - unreachable`);
    }
    verified = lenient.record;
    offlineMode = 'lenient';
  }

  if (verified.status === 'error') {
    log.warn(`  [${fixture.id}] offline-verified run ended in error: ${verified.error ?? 'unknown'}`);
  }
  return { accuracy: verified.accuracy, status: verified.status, usdBilled, offlineMode };
}

async function main(): Promise<void> {
  setLogLevel('info');

  // See the module doc comment: the offline-only mode re-captures snapshots
  // and bounds from the already-committed cache and never calls a provider,
  // so it neither needs a key nor is allowed to be blocked by the absence of
  // one.
  const offlineOnly = (process.env.FIXTURES_REFRESH_OFFLINE_ONLY ?? '').trim() !== '';

  if (
    !offlineOnly &&
    (process.env.NEBIUS_API_KEY === undefined || process.env.NEBIUS_API_KEY.trim() === '')
  ) {
    throw new Error(
      'fixtures-refresh: NEBIUS_API_KEY is not set. This is a NETWORK task (T50) and refuses to ' +
        'fabricate cache entries; set NEBIUS_API_KEY (see .env.example) and rerun, or set ' +
        'FIXTURES_REFRESH_OFFLINE_ONLY=1 to re-capture snapshots from the committed cache alone.',
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
      `Cache dir: ${cacheDir}. Word list: ${WORDLIST_PATH}`,
  );
  if (offlineOnly) {
    log.info(
      'fixtures-refresh: FIXTURES_REFRESH_OFFLINE_ONLY is set - no live pass, no provider call and ' +
        'no spend; snapshots and bounds are re-captured from the committed cache alone.',
    );
  }
  const resolved = await resolveProfile({ profile: 'baseline' });
  log.warn(
    `fixtures-refresh: baseline profile has promptVersion "${resolved.profile.promptVersion}"; ` +
      'changing it invalidates every entry in this cache and must land with a regenerated cache in the same commit.',
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
    const { accuracy, status, usdBilled, offlineMode } = await refreshOne(
      fixture,
      root,
      cacheDir,
      offlineOnly,
    );
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
