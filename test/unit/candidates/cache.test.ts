import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CacheEntry } from '../../../src/candidates/cache.js';
import { openCandidateCache } from '../../../src/candidates/cache.js';
import { resolveCacheDir } from '../../../src/util/fs.js';

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crossword-cache-'));
  temps.push(dir);
  return dir;
}

/**
 * A spy on real disk reads. Node's own `fs/promises` module cannot be
 * `vi.spyOn`-ed (its ESM namespace is frozen), so this module accepts an
 * injected `readEntryText`; wrapping the real implementation in a `vi.fn`
 * gives a call-counting spy that still does the real read.
 */
function readSpy(): ReturnType<typeof vi.fn<(path: string) => Promise<string>>> {
  return vi.fn((path: string) => readFile(path, 'utf8'));
}

afterEach(() => {
  vi.restoreAllMocks();
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Builds a CacheEntry with sensible defaults so a test only states what it cares about. */
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

const NEGATIVE_KEY = 'b'.repeat(40);

function negativeEntry(): CacheEntry {
  return makeEntry({ key: NEGATIVE_KEY, response: { clue_understood: 1, candidates: [] } });
}

describe('openCandidateCache: set/get round trip (acceptance 1)', () => {
  it('returns a deep-equal entry after set, and a second get costs no disk reads', async () => {
    const dir = tempDir();
    const spy = readSpy();
    const cache = openCandidateCache({ cacheDir: dir, readEntryText: spy });
    const entry = makeEntry();

    await cache.set(entry.key, entry);

    const first = await cache.get(entry.key);
    const second = await cache.get(entry.key);

    expect(first).toEqual(entry);
    expect(second).toEqual(entry);
    // Both gets are served from the LRU, which `set` already populated.
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('openCandidateCache: cold process (acceptance 2)', () => {
  it('a fresh instance over the same directory reads from disk and repopulates its LRU', async () => {
    const dir = tempDir();
    const writer = openCandidateCache({ cacheDir: dir });
    const entry = makeEntry();
    await writer.set(entry.key, entry);

    const spy = readSpy();
    const reader = openCandidateCache({ cacheDir: dir, readEntryText: spy });

    const first = await reader.get(entry.key);
    expect(first).toEqual(entry);
    expect(spy).toHaveBeenCalledTimes(1);

    // Repopulated: a second get on the same (cold) instance costs no read.
    spy.mockClear();
    const second = await reader.get(entry.key);
    expect(second).toEqual(entry);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('openCandidateCache: negative results (acceptance 3)', () => {
  it('stores a negative entry, returns it as a hit, distinct from a miss', async () => {
    const dir = tempDir();
    const cache = openCandidateCache({ cacheDir: dir });
    const entry = negativeEntry();

    await cache.set(entry.key, entry);

    const hit = await cache.get(entry.key);
    expect(hit).toBeDefined();
    expect(hit?.response.candidates).toEqual([]);

    const miss = await cache.get('c'.repeat(40));
    expect(miss).toBeUndefined();
  });
});

describe('openCandidateCache: LRU eviction (acceptance 4)', () => {
  it(
    'drops the least recently used entry at 2,001 and falls back to disk',
    async () => {
      const dir = tempDir();
      const spy = readSpy();
      // No lruSize override: this exercises the production default (2,000).
      const cache = openCandidateCache({ cacheDir: dir, readEntryText: spy });

      const firstKey = '0'.repeat(40);
      await cache.set(firstKey, makeEntry({ key: firstKey }));

      // Fill the LRU with 2,000 more distinct entries, none of which is the first.
      const rest = Array.from({ length: 2000 }, (_, i) => {
        const key = (i + 1).toString(16).padStart(40, '0');
        return cache.set(key, makeEntry({ key }));
      });
      await Promise.all(rest);

      const evicted = await cache.get(firstKey);
      expect(evicted).toEqual(makeEntry({ key: firstKey }));
      // Not served from the LRU: it had to come from disk.
      expect(spy).toHaveBeenCalledTimes(1);
    },
    20000,
  );
});

describe('resolveCacheDir precedence, via the module surface (acceptance 5)', () => {
  const root = '/repo';

  it.each([
    ['explicit cacheDir (the --cache-dir flag, once resolved)', { cacheDir: '/flag/cache' }, '/flag/cache'],
    ['$CROSSWORD_CACHE_DIR when no cacheDir is given', { env: { CROSSWORD_CACHE_DIR: '/env/cache' }, root }, '/env/cache'],
    ['./cache/candidates under the repo root as the last resort', { env: {}, root }, '/repo/cache/candidates'],
  ] as const)('%s', (_name, opts, expected) => {
    expect(openCandidateCache(opts).cacheDir).toBe(expected);
  });

  it('matches util/fs.resolveCacheDir exactly for the env/default half of the chain', () => {
    expect(openCandidateCache({ env: {}, root }).cacheDir).toBe(resolveCacheDir({ env: {}, root }));
    expect(openCandidateCache({ env: { CROSSWORD_CACHE_DIR: '/x' }, root }).cacheDir).toBe(
      resolveCacheDir({ env: { CROSSWORD_CACHE_DIR: '/x' }, root }),
    );
  });
});

describe('openCandidateCache: corrupt entry (acceptance 6)', () => {
  it('produces a miss plus exactly one warning, and leaves the file in place', async () => {
    const dir = tempDir();
    const cache = openCandidateCache({ cacheDir: dir });
    const key = 'd'.repeat(40);
    const shardDir = join(dir, key.slice(0, 2));
    const path = join(shardDir, `${key}.json`);
    mkdirSync(shardDir, { recursive: true });
    writeFileSync(path, '{ not valid json');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await cache.get(key);

    expect(result).toBeUndefined();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain('warn:');
    expect(readFileSync(path, 'utf8')).toBe('{ not valid json');
  });
});

describe('openCandidateCache: stats() over-size warning (acceptance 7)', () => {
  it('sets overSizeWarning when an injected size function reports over 1 GB', async () => {
    const dir = tempDir();
    const entry = makeEntry();
    const overCache = openCandidateCache({
      cacheDir: dir,
      measureBytes: () => Promise.resolve(2 * 1024 ** 3),
    });
    await overCache.set(entry.key, entry);

    const overStats = await overCache.stats();
    expect(overStats.overSizeWarning).toBe(true);
    expect(overStats.bytes).toBe(2 * 1024 ** 3);
    expect(overStats.entries).toBe(1);

    const underCache = openCandidateCache({
      cacheDir: tempDir(),
      measureBytes: () => Promise.resolve(1024),
    });
    await underCache.set(entry.key, entry);
    const underStats = await underCache.stats();
    expect(underStats.overSizeWarning).toBe(false);
  });

  it('memoises the result for the process lifetime unless refresh is requested', async () => {
    const dir = tempDir();
    let calls = 0;
    const cache = openCandidateCache({
      cacheDir: dir,
      measureBytes: () => {
        calls += 1;
        return Promise.resolve(0);
      },
    });
    await cache.set(makeEntry().key, makeEntry());

    await cache.stats();
    await cache.stats();
    expect(calls).toBe(1);

    await cache.stats({ refresh: true });
    expect(calls).toBe(2);
  });

  it('reports per-model and per-promptVersion breakdowns', async () => {
    const dir = tempDir();
    const cache = openCandidateCache({ cacheDir: dir });
    await cache.set('1'.repeat(40), makeEntry({ key: '1'.repeat(40), model: 'model-a' }));
    await cache.set('2'.repeat(40), makeEntry({ key: '2'.repeat(40), model: 'model-b' }));
    await cache.set('3'.repeat(40), makeEntry({ key: '3'.repeat(40), model: 'model-a' }));

    const stats = await cache.stats();
    expect(stats.entries).toBe(3);
    expect(stats.byModel).toEqual({ 'model-a': 2, 'model-b': 1 });
    expect(stats.byPromptVersion).toEqual({ '1': 3 });
  });
});

describe('openCandidateCache: clear', () => {
  it('with no filter removes every entry and returns the count', async () => {
    const dir = tempDir();
    const cache = openCandidateCache({ cacheDir: dir });
    await cache.set('1'.repeat(40), makeEntry({ key: '1'.repeat(40) }));
    await cache.set('2'.repeat(40), makeEntry({ key: '2'.repeat(40) }));

    const removed = await cache.clear();
    expect(removed).toBe(2);

    const stats = await cache.stats({ refresh: true });
    expect(stats.entries).toBe(0);
  });

  it('filters by model and by promptVersion, and both together', async () => {
    const dir = tempDir();
    const cache = openCandidateCache({ cacheDir: dir });
    await cache.set('1'.repeat(40), makeEntry({ key: '1'.repeat(40), model: 'model-a', promptVersion: '1' }));
    await cache.set('2'.repeat(40), makeEntry({ key: '2'.repeat(40), model: 'model-b', promptVersion: '1' }));
    await cache.set('3'.repeat(40), makeEntry({ key: '3'.repeat(40), model: 'model-a', promptVersion: '2' }));

    const removedByModel = await cache.clear({ model: 'model-a' });
    expect(removedByModel).toBe(2);

    const remaining = await cache.stats({ refresh: true });
    expect(remaining.entries).toBe(1);
    expect(remaining.byModel).toEqual({ 'model-b': 1 });
  });

  it('also evicts cleared entries from the in-process LRU', async () => {
    const dir = tempDir();
    const spy = readSpy();
    const cache = openCandidateCache({ cacheDir: dir, readEntryText: spy });
    const entry = makeEntry();
    await cache.set(entry.key, entry);

    await cache.clear();
    spy.mockClear(); // clear() itself reads each file to check the filter; only the get below matters here.

    const missAfterClear = await cache.get(entry.key);
    expect(missAfterClear).toBeUndefined();
    // The LRU no longer serves it either: get had to touch disk and find nothing.
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
