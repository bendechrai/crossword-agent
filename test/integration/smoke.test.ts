import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { RunRecord } from '../../src/eval/types.js';
import { repoRoot } from '../../src/util/fs.js';

/**
 * T51: two end-to-end smoke checks, both run by `npm test` (so CI runs them
 * too), neither touching the network.
 *
 * 1. The dist build smoke (B50, spec "Testing"): `npm run build` then
 *    `node dist/cli/index.js --version`, so a build-only breakage (the dev
 *    loop runs from `tsx` and would otherwise never notice one) is caught by
 *    the suite.
 * 2. The CLI end-to-end path: the real `xw` entry point (`bin/xw.js`, the
 *    same code `npm link` inside the Docker image points `xw` at). This is
 *    deliberately a real subprocess of the actual CLI binary, not a call
 *    into `solveCommand`/`fetchCommand` directly (T50's
 *    `test/integration/solve.test.ts` already covers that, thoroughly,
 *    in-process) - the point here is to prove the packaged entry point
 *    itself (argument parsing, option wiring, exit codes) works, which a
 *    direct function call cannot. Two independent sub-checks, deliberately
 *    not chained:
 *
 *    a. `xw fetch file` against a committed `.ipuz` fixture, proving the
 *       `file` source and the loader dispatch work end to end. Not one of
 *       the four `puzzles/fixtures/*.xd` puzzles the task text names:
 *       `src/puzzle/adapters/xd.ts` unconditionally sets `parsedBy:
 *       'xd-hand'` (a value T25 added to the `ParsedBy` union in
 *       `src/puzzle/types.ts` under its own pre-authorisation), but
 *       `schemas/puzzle.schema.json` and `schemas/puzzle-index.schema.json`
 *       were never updated to allow it - a gap already found and documented
 *       by T29's reviewer in `docs/build-notes/wave-2.md` ("Blocking bug for
 *       real `xw fetch xd`") and still unfixed. `xw fetch file` on any real
 *       `.xd` puzzle therefore always fails `writeNormalised`'s schema
 *       validation. Both schema files are frozen for T51 (`schemas/**`), so
 *       the fix (adding `"xd-hand"` to both `parsedBy` enums) is left as a
 *       deviation rather than made here. `test/fixtures/puzzles/
 *       synthetic-5x5.ipuz` is used instead: it parses through
 *       `src/puzzle/adapters/xwordly.ts`, whose `parsedBy:
 *       '@xwordly/xword-parser'` is a schema-valid value.
 *
 *    b. `xw solve` against the committed offline cache at
 *       `test/fixtures/cache/` (T50), run with strict `--offline` (a cache
 *       miss must be a hard failure, not a silently-accepted empty grid).
 *       This is deliberately NOT fed by step (a)'s fetch output: the
 *       `.ipuz` fetch normalises through `xwordly.ts` to `style: 'unknown'`
 *       and `title: 'synthetic-5x5.ipuz'` (T51's own PuzzleAdapterContext
 *       extension defaults style to `'unknown'` because the frozen
 *       `loader.ts` never supplies one), but every one of T50's 386
 *       committed cache entries was populated against
 *       `test/fixtures/puzzles/synthetic-5x5.json` - `style: 'american'`,
 *       `title: 'Synthetic five'` - and `src/util/hash.ts`'s
 *       `cacheKeyFields` hashes both `style` and `title` into the cache key
 *       (B23). Chaining fetch's `.ipuz` output into `solve --offline` is
 *       therefore a cache miss on the very first seed lookup, which
 *       `--offline-lenient` (not strict `--offline`) silently accepts as an
 *       empty domain - the check would then pass just the same with an
 *       empty or deleted cache directory (found in review). Instead, this
 *       step seeds its own puzzles dir directly with the "library" form
 *       (`<puzzlesDir>/<source>/<id>.json`, the same normalised shape
 *       `xw fetch` itself writes) by copying the already-normalised
 *       `test/fixtures/puzzles/synthetic-5x5.json` fixture - the exact
 *       content T50's cache was populated against - so every cache key
 *       lines up.
 *
 *       Profile: `no-repair`, not the default `baseline`. Reproduced in a
 *       throwaway container: with the puzzle above and `baseline` (repair
 *       enabled), strict `--offline` still fails - not on a seed miss, but
 *       partway through the repair phase, which scores an edit-distance
 *       proposal for slot 1A via a `purpose: 'repair'` (`promptKind:
 *       'constrained'`) call whose cache key (fully-fixed `pattern`, empty
 *       `rejected`) was never populated for that specific proposal, even
 *       though the seed-phase candidates for every slot - including 1A -
 *       are all cache hits and the grid the search phase builds from them
 *       is already the correct, complete solution. This is a real, narrow
 *       gap independent of the style/title bug above (`src/solver/
 *       repair.ts` and `src/candidates/service.ts` are neither owned nor
 *       read-write here; see the deviations note in this task's PR
 *       description). `no-repair` (one of T50's own three cached profiles,
 *       so its seed-phase cache entries are the same ones `baseline` and
 *       `tier1-only` share per B23's cache-key design) skips the repair
 *       phase entirely, so this step converges with a strict `--offline`,
 *       zero-network, exit 0 run.
 */

const ROOT = repoRoot();
const NODE = process.execPath;
const XW_BIN = join(ROOT, 'bin/xw.js');
const CACHE_DIR = join(ROOT, 'test/fixtures/cache');
const FETCH_FIXTURE_ID = 'synthetic-5x5';
const FETCH_FIXTURE_PATH = join(ROOT, 'test/fixtures/puzzles', `${FETCH_FIXTURE_ID}.ipuz`);
/** The already-normalised "library" fixture T50's committed cache was populated against. */
const LIBRARY_FIXTURE_PATH = join(ROOT, 'test/fixtures/puzzles/synthetic-5x5.json');
const LIBRARY_SOURCE = 'synthetic';
const LIBRARY_ID = 'synthetic-5x5';
/** Matches `scripts/fixtures-refresh.ts` (T50): the exact combination its own committed cache was populated and verified against. */
const SEED = '42';
const BUDGET_USD = '0.4';
/** Never a real credential: strict --offline guarantees the transport is constructed but never called. */
const PLACEHOLDER_KEY = 'offline-smoke-placeholder-key';
/** Anything below this is not a real solve; T50's own bound for this fixture is far higher. */
const MIN_LETTERS_ACCURACY = 0.99;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe('smoke: dist build (B50)', () => {
  it(
    '`npm run build` then `node dist/cli/index.js --version` prints the package version',
    async () => {
      const build = await run('npm', ['run', 'build']);
      expect(build.code, `npm run build failed:\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`).toBe(0);

      const versioned = await run(NODE, [join(ROOT, 'dist/cli/index.js'), '--version']);
      expect(
        versioned.code,
        `node dist/cli/index.js --version failed:\nstdout:\n${versioned.stdout}\nstderr:\n${versioned.stderr}`,
      ).toBe(0);

      const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { version: string };
      expect(versioned.stdout.trim()).toBe(pkg.version);
    },
    180_000,
  );
});

describe('smoke: xw fetch file (end-to-end file source)', () => {
  const tmpDirs: string[] = [];

  afterAll(async () => {
    await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it(
    'fetches a committed .ipuz fixture through the file source and exits 0',
    async () => {
      const puzzlesDir = await mkdtemp(join(tmpdir(), 'xw-smoke-fetch-'));
      tmpDirs.push(puzzlesDir);

      const fetchResult = await run(NODE, [
        XW_BIN,
        'fetch',
        'file',
        '--path',
        FETCH_FIXTURE_PATH,
        '--out',
        puzzlesDir,
      ]);
      expect(
        fetchResult.code,
        `xw fetch file failed:\nstdout:\n${fetchResult.stdout}\nstderr:\n${fetchResult.stderr}`,
      ).toBe(0);
    },
    30_000,
  );
});

describe('smoke: xw solve --offline against the committed cache', () => {
  const tmpDirs: string[] = [];

  afterAll(async () => {
    await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it(
    'solves a puzzle matching the committed cache keys, offline, and prints a real score block',
    async () => {
      const puzzlesDir = await mkdtemp(join(tmpdir(), 'xw-smoke-solve-'));
      tmpDirs.push(puzzlesDir);
      const runDir = await mkdtemp(join(tmpdir(), 'xw-smoke-run-'));
      tmpDirs.push(runDir);
      const runOut = join(runDir, 'run.json');

      // Seed the puzzles dir directly with the normalised "library" form
      // (<puzzlesDir>/<source>/<id>.json) rather than going through `xw
      // fetch`, so the puzzle's style/title exactly match what T50's cache
      // was populated against (see the module doc comment above).
      const sourceDir = join(puzzlesDir, LIBRARY_SOURCE);
      await mkdir(sourceDir, { recursive: true });
      await copyFile(LIBRARY_FIXTURE_PATH, join(sourceDir, `${LIBRARY_ID}.json`));

      const solveResult = await run(
        NODE,
        [
          XW_BIN,
          '--cache-dir',
          CACHE_DIR,
          'solve',
          LIBRARY_ID,
          '--offline',
          '--profile',
          'no-repair',
          '--seed',
          SEED,
          '--budget-usd',
          BUDGET_USD,
          '--no-inference-log',
          '--out',
          runOut,
        ],
        {
          env: {
            ...process.env,
            CROSSWORD_PUZZLES_DIR: puzzlesDir,
            NEBIUS_API_KEY: PLACEHOLDER_KEY,
          },
        },
      );
      expect(
        solveResult.code,
        `xw solve --offline failed:\nstdout:\n${solveResult.stdout}\nstderr:\n${solveResult.stderr}`,
      ).toBe(0);

      // Tightened per review: a regex that only checks the shape of the
      // "Score:" line accepts an empty run (letters=0.000 words=0.000) just
      // as happily as a real one, which is exactly what made this check
      // pass vacuously against an empty or deleted cache directory. Require
      // an actual accuracy number, not just the line's presence.
      const scoreMatch = /Score: letters=([0-9.]+) words=([0-9.]+)/.exec(solveResult.stdout);
      expect(scoreMatch, `no Score line in stdout:\n${solveResult.stdout}`).not.toBeNull();
      expect(Number(scoreMatch?.[1])).toBeGreaterThanOrEqual(MIN_LETTERS_ACCURACY);
      expect(Number(scoreMatch?.[2])).toBeGreaterThanOrEqual(MIN_LETTERS_ACCURACY);

      // Belt and braces: assert the same off the written run record, not
      // just stdout text, and require the run to have actually completed
      // ('ok'), not merely exited 0 with a 'partial' offline-miss grid.
      const record = JSON.parse(await readFile(runOut, 'utf8')) as RunRecord;
      expect(record.status).toBe('ok');
      expect(record.accuracy.letters).toBeGreaterThanOrEqual(MIN_LETTERS_ACCURACY);
      expect(record.accuracy.emptyCells).toBe(0);
    },
    60_000,
  );
});
