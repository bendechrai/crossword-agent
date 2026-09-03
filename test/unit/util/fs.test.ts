import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  atomicWriteFile,
  ensureDir,
  repoRoot,
  resolveCacheDir,
  resolveInferenceLogDir,
  resolvePuzzlesDir,
  resolveRunsDir,
  toRepoRelativePosix,
} from '../../../src/util/fs.js';

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crossword-fs-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('repoRoot', () => {
  it('finds the directory holding package.json', () => {
    const root = repoRoot();
    expect(() => readFileSync(join(root, 'package.json'), 'utf8')).not.toThrow();
  });
});

describe('atomicWriteFile', () => {
  it('writes the file and leaves no temp file behind', async () => {
    const dir = tempDir();
    const target = join(dir, 'out.json');
    await atomicWriteFile(target, '{"a":1}');
    expect(readFileSync(target, 'utf8')).toBe('{"a":1}');
    expect(readdirSync(dir)).toEqual(['out.json']);
  });

  it('creates missing parent directories', async () => {
    const dir = tempDir();
    const target = join(dir, 'deep', 'deeper', 'out.txt');
    await atomicWriteFile(target, 'hello');
    expect(readFileSync(target, 'utf8')).toBe('hello');
  });

  it('replaces an existing file', async () => {
    const dir = tempDir();
    const target = join(dir, 'out.txt');
    writeFileSync(target, 'old');
    await atomicWriteFile(target, 'new');
    expect(readFileSync(target, 'utf8')).toBe('new');
  });
});

describe('ensureDir', () => {
  it('is idempotent', () => {
    const dir = join(tempDir(), 'a', 'b');
    ensureDir(dir);
    ensureDir(dir);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('toRepoRelativePosix', () => {
  it('makes a path under the root relative and POSIX-separated', () => {
    expect(toRepoRelativePosix('/repo/puzzles/xd/a.json', '/repo')).toBe('puzzles/xd/a.json');
  });

  it('leaves a path outside the root alone', () => {
    expect(toRepoRelativePosix('/elsewhere/a.json', '/repo')).toBe('/elsewhere/a.json');
  });

  it('resolves a relative path against the root first', () => {
    expect(toRepoRelativePosix('puzzles/a.json', '/repo')).toBe('puzzles/a.json');
  });
});

describe('directory resolution (B24)', () => {
  const root = '/repo';

  it('prefers the flag over the environment and the config', () => {
    expect(
      resolveCacheDir({
        flag: '/flag/cache',
        config: '/config/cache',
        env: { CROSSWORD_CACHE_DIR: '/env/cache' },
        root,
      }),
    ).toBe('/flag/cache');
  });

  it('prefers the environment over the config', () => {
    expect(
      resolveCacheDir({ config: '/config/cache', env: { CROSSWORD_CACHE_DIR: '/env/cache' }, root }),
    ).toBe('/env/cache');
  });

  it('falls back to ./cache/candidates under the repo root', () => {
    expect(resolveCacheDir({ env: {}, root })).toBe('/repo/cache/candidates');
  });

  it('resolves a relative override against the repo root', () => {
    expect(resolveCacheDir({ flag: 'tmp/cache', env: {}, root })).toBe('/repo/tmp/cache');
  });

  it('has the documented defaults for the other directories', () => {
    expect(resolveRunsDir({ env: {}, root })).toBe('/repo/runs');
    expect(resolvePuzzlesDir({ env: {}, root })).toBe('/repo/puzzles');
    expect(resolveInferenceLogDir({ env: {}, root })).toBe('/repo/logs/inference');
  });
});
