import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the repository root is. Walks up from this module until it finds the
 * directory holding `package.json`, so it is correct whether the code is
 * running from `src/` through tsx or from `dist/`.
 */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      // No package.json above us: fall back to the working directory rather
      // than throwing, so a vendored copy still runs.
      return process.cwd();
    }
    dir = parent;
  }
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * Write through a temp file in the same directory plus an atomic rename, so a
 * reader never sees a half-written file and a crash never truncates one.
 */
export async function atomicWriteFile(path: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(path);
  ensureDir(dir);
  const tmp = join(dir, `.${randomBytes(8).toString('hex')}.tmp`);
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** A repo-relative POSIX path, which is the form the puzzle index stores (B34). */
export function toRepoRelativePosix(path: string, root = repoRoot()): string {
  const abs = isAbsolute(path) ? path : resolve(root, path);
  const rel = abs.startsWith(root + sep) ? abs.slice(root.length + 1) : abs;
  return rel.split(sep).join('/');
}

export interface DirResolution {
  /** An explicit CLI flag: the highest precedence. */
  flag?: string | undefined;
  /** A value from the config file, which sits below the environment. */
  config?: string | undefined;
  env?: NodeJS.ProcessEnv;
  root?: string;
}

function resolveDir(
  opts: DirResolution | undefined,
  envVar: string,
  fallback: string,
): string {
  const root = opts?.root ?? repoRoot();
  const env = opts?.env ?? process.env;
  const chosen = opts?.flag ?? env[envVar] ?? opts?.config ?? fallback;
  return isAbsolute(chosen) ? chosen : resolve(root, chosen);
}

/** B24: `--cache-dir` > `$CROSSWORD_CACHE_DIR` > `./cache/candidates`. */
export function resolveCacheDir(opts?: DirResolution): string {
  return resolveDir(opts, 'CROSSWORD_CACHE_DIR', 'cache/candidates');
}

export function resolveRunsDir(opts?: DirResolution): string {
  return resolveDir(opts, 'CROSSWORD_RUNS_DIR', 'runs');
}

export function resolvePuzzlesDir(opts?: DirResolution): string {
  return resolveDir(opts, 'CROSSWORD_PUZZLES_DIR', 'puzzles');
}

export function resolveInferenceLogDir(opts?: DirResolution): string {
  return resolveDir(opts, 'CROSSWORD_INFERENCE_LOG_DIR', 'logs/inference');
}
