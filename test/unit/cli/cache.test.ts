import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CacheEntry } from '../../../src/candidates/cache.js';
import { openCandidateCache } from '../../../src/candidates/cache.js';
import {
  cacheClearCommand,
  cacheExportCommand,
  cacheImportCommand,
  cacheStatsCommand,
} from '../../../src/cli/cache.js';
import { ExitCode, isCliError } from '../../../src/cli/exit.js';
import type { GlobalOptions } from '../../../src/cli/options.js';
import type { InferenceLogRecord } from '../../../src/llm/types.js';

const GLOBAL: GlobalOptions = { color: false };

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crossword-cli-cache-'));
  temps.push(dir);
  return dir;
}

let lines: string[];

function makeEntry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    key: 'a'.repeat(40),
    model: 'nvidia/Nemotron-3_5-Lightning',
    promptVersion: '1',
    promptKind: 'seed',
    clue: 'Cry of surprise',
    length: 5,
    pattern: '?????',
    style: 'american',
    sampleIndex: 0,
    batchSize: 1,
    response: { clue_understood: 1, candidates: [{ answer: 'ALIEN', confidence: 0.9 }] },
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    latencyMs: 250,
    createdAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

function key(char: string): string {
  return char.repeat(40);
}

async function seedCache(
  dir: string,
  entries: ReadonlyArray<Partial<CacheEntry> & { key: string }>,
): Promise<void> {
  const cache = openCandidateCache({ cacheDir: dir });
  for (const entry of entries) {
    await cache.set(entry.key, makeEntry(entry));
  }
}

interface TreeFile {
  path: string;
  sha1: string;
}

function sha1Of(content: Buffer): string {
  return createHash('sha1').update(content).digest('hex');
}

/** Recursive listing of {relative POSIX path, sha1 of content}, sorted for comparison. */
function listTree(root: string, dir = root): TreeFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: TreeFile[] = [];
  for (const name of names) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push(...listTree(root, abs));
    } else {
      out.push({
        path: relative(root, abs).split(sep).join('/'),
        sha1: sha1Of(readFileSync(abs)),
      });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const TAR_BLOCK = 512;

/**
 * Builds a single-entry gzip tar with an arbitrary (possibly malicious) name,
 * independent of `src/cli/cache.ts`'s own writer, so acceptance 6 exercises
 * `cacheImportCommand`'s reader against an archive it did not produce itself.
 */
function maliciousTarGz(name: string, content: string): Buffer {
  const contentBuf = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(TAR_BLOCK, 0);
  header.write(name, 0, 'utf8');

  const writeOctal = (value: number, offset: number, length: number): void => {
    header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, 'ascii');
  };
  writeOctal(0o644, 100, 8);
  writeOctal(0, 108, 8);
  writeOctal(0, 116, 8);
  writeOctal(contentBuf.length, 124, 12);
  writeOctal(0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');

  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');

  const pad = (buf: Buffer): Buffer => {
    const rem = buf.length % TAR_BLOCK;
    return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(TAR_BLOCK - rem, 0)]);
  };

  return gzipSync(Buffer.concat([header, pad(contentBuf), Buffer.alloc(TAR_BLOCK * 2, 0)]));
}

function inferenceRecord(overrides: Partial<InferenceLogRecord> = {}): InferenceLogRecord {
  return {
    id: 'r1',
    ts: '2026-09-02T00:00:00.000Z',
    runId: 'run-1',
    puzzleId: 'p1',
    slotId: '1A',
    purpose: 'seed',
    promptKind: 'seed',
    tier: 1,
    model: 'nvidia/Nemotron-3_5-Lightning',
    promptVersion: '1',
    cacheKey: key('a'),
    cacheHit: false,
    batchSize: 1,
    batchIndex: null,
    sampleIndex: 0,
    request: null,
    rawResponse: null,
    parsed: null,
    parseError: null,
    httpStatus: 200,
    responseHeaders: {},
    attempt: 0,
    usage: null,
    usdBilled: 0,
    usdCounterfactual: 0,
    latencyMs: 0,
    error: null,
    ...overrides,
  };
}

beforeEach(() => {
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('cacheStatsCommand (acceptance 1)', () => {
  it('prints the entry count, a byte total, and one line per distinct model', async () => {
    const dir = tempDir();
    await seedCache(dir, [
      { key: key('a'), model: 'model-a' },
      { key: key('b'), model: 'model-a', promptVersion: '2' },
      { key: key('c'), model: 'model-b' },
    ]);

    await cacheStatsCommand(GLOBAL, { cacheDir: dir, inferenceLogDir: join(dir, 'no-such-logs') });

    expect(lines).toContainEqual('entries: 3');
    expect(lines.some((l) => /^bytes: \d+$/.test(l))).toBe(true);
    expect(lines).toContainEqual('  model-a: 2');
    expect(lines).toContainEqual('  model-b: 1');
    expect(lines).toContainEqual('  1: 2');
    expect(lines).toContainEqual('  2: 1');
  });
});

describe('cacheStatsCommand (acceptance 2)', () => {
  it('warns when an injected size function reports over 1 GB', async () => {
    const dir = tempDir();
    await seedCache(dir, [{ key: key('a') }]);

    await cacheStatsCommand(GLOBAL, {
      cacheDir: dir,
      inferenceLogDir: join(dir, 'no-such-logs'),
      measureBytes: () => Promise.resolve(2 * 1024 ** 3),
    });

    expect(lines.some((l) => l.includes('WARNING') && l.includes('1 GB'))).toBe(true);
  });

  it('does not warn under the 1 GB threshold', async () => {
    const dir = tempDir();
    await seedCache(dir, [{ key: key('a') }]);

    await cacheStatsCommand(GLOBAL, {
      cacheDir: dir,
      inferenceLogDir: join(dir, 'no-such-logs'),
      measureBytes: () => Promise.resolve(1024),
    });

    expect(lines.some((l) => l.includes('WARNING'))).toBe(false);
  });
});

describe('cacheStatsCommand: last-run hit rate', () => {
  it('prints n/a when no inference log exists', async () => {
    const dir = tempDir();
    await seedCache(dir, [{ key: key('a') }]);

    await cacheStatsCommand(GLOBAL, { cacheDir: dir, inferenceLogDir: join(dir, 'no-such-logs') });

    expect(lines.some((l) => l.startsWith('last-run hit rate: n/a'))).toBe(true);
  });

  it('computes the hit rate of the most recent run only, ignoring an older run', async () => {
    const dir = tempDir();
    await seedCache(dir, [{ key: key('a') }]);
    const logDir = join(dir, 'logs');
    await mkdir(logDir, { recursive: true });

    const older = inferenceRecord({ id: 'o1', runId: 'run-0', ts: '2026-09-01T00:00:00.000Z', cacheHit: true });
    const hit = inferenceRecord({ id: 'r1', runId: 'run-1', ts: '2026-09-02T00:00:00.000Z', cacheHit: true });
    const miss = inferenceRecord({ id: 'r2', runId: 'run-1', ts: '2026-09-02T00:00:01.000Z', cacheHit: false });
    await writeFile(
      join(logDir, '2026-09-02.jsonl'),
      `${JSON.stringify(older)}\n${JSON.stringify(hit)}\n${JSON.stringify(miss)}\n`,
    );

    await cacheStatsCommand(GLOBAL, { cacheDir: dir, inferenceLogDir: logDir });

    expect(lines).toContainEqual('last-run hit rate: 50% (1/2)');
  });
});

describe('cacheClearCommand (acceptance 3)', () => {
  it('--model X removes only entries for model X; the others survive', async () => {
    const dir = tempDir();
    await seedCache(dir, [
      { key: key('a'), model: 'model-x' },
      { key: key('b'), model: 'model-x' },
      { key: key('c'), model: 'model-y' },
    ]);

    await cacheClearCommand({ model: 'model-x' }, GLOBAL, { cacheDir: dir });

    const verify = openCandidateCache({ cacheDir: dir });
    expect(await verify.get(key('a'))).toBeUndefined();
    expect(await verify.get(key('b'))).toBeUndefined();
    expect(await verify.get(key('c'))).toBeDefined();
  });
});

describe('cacheClearCommand (acceptance 4)', () => {
  it('with no filter and no --yes exits 2 without deleting anything', async () => {
    const dir = tempDir();
    await seedCache(dir, [{ key: key('a') }, { key: key('b') }]);

    await expect(cacheClearCommand({}, GLOBAL, { cacheDir: dir })).rejects.toSatisfy((err: unknown) => {
      return isCliError(err) && err.code === ExitCode.USAGE;
    });

    const verify = openCandidateCache({ cacheDir: dir });
    expect(await verify.get(key('a'))).toBeDefined();
    expect(await verify.get(key('b'))).toBeDefined();
  });

  it('with no filter and --yes clears everything', async () => {
    const dir = tempDir();
    await seedCache(dir, [{ key: key('a') }, { key: key('b') }]);

    await cacheClearCommand({ yes: true }, GLOBAL, { cacheDir: dir });

    const verify = openCandidateCache({ cacheDir: dir });
    expect(await verify.get(key('a'))).toBeUndefined();
    expect(await verify.get(key('b'))).toBeUndefined();
  });
});

describe('cacheExportCommand / cacheImportCommand (acceptance 5)', () => {
  it('round-trips a byte-identical file tree through a fresh directory', async () => {
    const srcDir = tempDir();
    const destDir = join(tempDir(), 'fresh');
    const tarPath = join(tempDir(), 'cache.tar.gz');

    await seedCache(srcDir, [
      { key: key('a'), model: 'model-x' },
      // A negative entry: export excludes nothing.
      { key: key('b'), model: 'model-y', response: { clue_understood: 1, candidates: [] } },
    ]);

    await cacheExportCommand(tarPath, GLOBAL, { cacheDir: srcDir });
    await cacheImportCommand(tarPath, GLOBAL, { cacheDir: destDir });

    expect(listTree(destDir)).toEqual(listTree(srcDir));
    expect(listTree(destDir).length).toBe(2);
  });
});

describe('cacheImportCommand (acceptance 6)', () => {
  it('refuses a tarball containing a path-traversal entry with exit 2', async () => {
    const destDir = tempDir();
    const tarPath = join(tempDir(), 'evil.tar.gz');
    const evil = maliciousTarGz('../evil.json', '{"pwned":true}');
    await writeFile(tarPath, evil);

    await expect(cacheImportCommand(tarPath, GLOBAL, { cacheDir: destDir })).rejects.toSatisfy(
      (err: unknown) => isCliError(err) && err.code === ExitCode.USAGE,
    );

    // Nothing from the tarball was written, and nothing escaped destDir's parent.
    expect(listTree(destDir)).toEqual([]);
    const escaped = join(destDir, '..', 'evil.json');
    await expect(readFile(escaped)).rejects.toThrow();
  });
});
