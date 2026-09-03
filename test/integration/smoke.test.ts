import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

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
 *    same code `npm link` inside the Docker image points `xw` at) runs
 *    `fetch file` against a committed `.xd` fixture into a throwaway puzzles
 *    directory, then `solve` against the committed offline cache at
 *    `test/fixtures/cache/` (T50). This is deliberately a real subprocess of
 *    the actual CLI binary, not a call into `solveCommand`/`fetchCommand`
 *    directly (T50's `test/integration/solve.test.ts` already covers that,
 *    thoroughly, in-process) - the point here is to prove the packaged
 *    entry point itself (argument parsing, option wiring, exit codes) works,
 *    which a direct function call cannot.
 *
 * `--offline-lenient`, not strict `--offline`, for the solve step: T50's
 * `scripts/fixtures-refresh.ts` module doc comment (and every entry in the
 * committed `test/fixtures/runs/bounds.json`, all six `"offlineMode":
 * "lenient"`) documents a verified, structural gap - `src/llm/tierRouter.ts`
 * sends the reasoning-off parameter only for `purpose: 'seed'`, so any
 * `reask`/`escalate`/`repair` call on the reasoning-capable tier-1 model
 * burns its token budget on chain-of-thought, the JSON answer is never
 * written, and `CandidateService` never caches a parse failure. A strict
 * `--offline` replay of any committed fixture that reaches such a call
 * therefore cannot converge no matter what seed or budget is chosen; fixing
 * that is outside T51's ownership (`src/llm/tierRouter.ts` and
 * `src/candidates/service.ts` are neither owned nor read-write here). See
 * the deviations note in this task's PR description for the full citation.
 * `--offline-lenient` never touches the network either way
 * (`src/candidates/service.ts`: `offline = deps.offline || deps.offlineLenient`
 * gates the transport call itself, not just what a miss does), so "neither
 * check touches the network" still holds.
 *
 * The fetch step uses a committed `.ipuz` fixture, not one of the four
 * `puzzles/fixtures/*.xd` puzzles the task text names: `src/puzzle/adapters/
 * xd.ts` unconditionally sets `parsedBy: 'xd-hand'` (a value T25 added to the
 * `ParsedBy` union in `src/puzzle/types.ts` under its own pre-authorisation),
 * but `schemas/puzzle.schema.json` and `schemas/puzzle-index.schema.json`
 * were never updated to allow it - a gap already found and documented by
 * T29's reviewer in `docs/build-notes/wave-2.md` ("Blocking bug for real `xw
 * fetch xd`") and still unfixed. `xw fetch file` (or `xw fetch xd`) on any
 * real `.xd` puzzle therefore always fails
 * `writeNormalised`'s schema validation - reproduced directly against every
 * one of the four committed fixtures while writing this test. Both schema
 * files are frozen for T51 (`schemas/**`), so the fix (adding `"xd-hand"` to
 * both `parsedBy` enums) is left as a deviation rather than made here.
 * `test/fixtures/puzzles/synthetic-5x5.ipuz` parses through
 * `src/puzzle/adapters/xwordly.ts` instead, whose `parsedBy:
 * '@xwordly/xword-parser'` is a schema-valid value, and (verified by title
 * and per-slot clue text against the already-normalised
 * `test/fixtures/puzzles/synthetic-5x5.json`, T0/T50's own fixture) is the
 * same puzzle content T50's committed cache was populated against, so the
 * cache keys line up.
 */

const ROOT = repoRoot();
const NODE = process.execPath;
const XW_BIN = join(ROOT, 'bin/xw.js');
const CACHE_DIR = join(ROOT, 'test/fixtures/cache');
const FIXTURE_ID = 'synthetic-5x5';
const FIXTURE_PATH = join(ROOT, 'test/fixtures/puzzles', `${FIXTURE_ID}.ipuz`);
/** Matches `scripts/fixtures-refresh.ts` (T50): the exact combination its own committed cache was populated and verified against. */
const SEED = '42';
const BUDGET_USD = '0.4';
/** Never a real credential: --offline-lenient guarantees the transport is constructed but never called. */
const PLACEHOLDER_KEY = 'offline-smoke-placeholder-key';

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

describe('smoke: xw fetch file + xw solve --offline-lenient against the committed cache', () => {
  const tmpDirs: string[] = [];

  afterAll(async () => {
    await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it(
    'fetches a committed .ipuz fixture through the file source, solves it offline and prints a score block',
    async () => {
      const puzzlesDir = await mkdtemp(join(tmpdir(), 'xw-smoke-puzzles-'));
      tmpDirs.push(puzzlesDir);
      const runDir = await mkdtemp(join(tmpdir(), 'xw-smoke-run-'));
      tmpDirs.push(runDir);
      const runOut = join(runDir, 'run.json');

      const fetchResult = await run(NODE, [
        XW_BIN,
        'fetch',
        'file',
        '--path',
        FIXTURE_PATH,
        '--out',
        puzzlesDir,
      ]);
      expect(
        fetchResult.code,
        `xw fetch file failed:\nstdout:\n${fetchResult.stdout}\nstderr:\n${fetchResult.stderr}`,
      ).toBe(0);

      const solveResult = await run(
        NODE,
        [
          XW_BIN,
          '--cache-dir',
          CACHE_DIR,
          'solve',
          FIXTURE_ID,
          '--offline-lenient',
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
        `xw solve --offline-lenient failed:\nstdout:\n${solveResult.stdout}\nstderr:\n${solveResult.stderr}`,
      ).toBe(0);
      expect(solveResult.stdout).toMatch(/Score: letters=[0-9.]+ words=[0-9.]+/);
    },
    60_000,
  );
});
