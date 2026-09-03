import { readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { LRUCache } from 'lru-cache';

import { atomicWriteFile, resolveCacheDir } from '../util/fs.js';
import { log } from '../util/log.js';
import type { TokenUsage } from '../llm/types.js';
import type { PuzzleStyle } from '../puzzle/types.js';
import type { CandidateResponse, PromptKind } from './types.js';

/**
 * T12 (B23, B24): a two-layer candidate cache. `key` is always the B23 sha1
 * produced by `util/hash.cacheKey` - this module never builds a key itself.
 *
 * `keyFields` was the spec's original per-entry shape (self-describing via
 * the whole hashed object). The task text that governs this module instead
 * enumerates a flat, narrower set of fields, so this is what is stored; see
 * the PR's "Spec conflict" note.
 */
export interface CacheEntry {
  key: string;
  model: string;
  promptVersion: string;
  promptKind: PromptKind;
  clue: string;
  length: number;
  pattern: string;
  style: PuzzleStyle;
  sampleIndex: number;
  batchSize: number;
  /**
   * The model's parsed response for this key. A negative result (a known
   * dead end) is stored with `candidates: []`, in exactly the same shape as
   * a positive one, so a known dead end is never re-paid for. It is
   * distinguished from a cache miss only by the entry existing at all: `get`
   * returns `undefined` for a miss and a defined entry (negative or not) for
   * a hit.
   */
  response: CandidateResponse;
  usage: TokenUsage | null;
  latencyMs: number;
  /** ISO 8601. */
  createdAt: string;
}

export interface CacheStats {
  entries: number;
  bytes: number;
  /** True above 1 GB (B24). */
  overSizeWarning: boolean;
  byModel: Record<string, number>;
  byPromptVersion: Record<string, number>;
}

export interface CacheClearFilter {
  model?: string;
  promptVersion?: string;
}

export interface StatsOptions {
  /** Force a fresh directory walk instead of the memoised result. */
  refresh?: boolean;
}

export interface CandidateCache {
  /** Where this cache reads and writes; useful for `xw cache` to report. */
  readonly cacheDir: string;
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): Promise<void>;
  /**
   * Walks the disk cache lazily and memoises the result for the process
   * lifetime; pass `{ refresh: true }` to force a fresh walk.
   */
  stats(opts?: StatsOptions): Promise<CacheStats>;
  /** Deletes every entry matching `filter` (all entries when omitted); returns the count removed. */
  clear(filter?: CacheClearFilter): Promise<number>;
}

export interface CandidateCacheOptions {
  /**
   * An already-resolved cache directory, e.g. the caller's own
   * `resolveCacheDir({ flag, env })` (B24). Defaults to
   * `resolveCacheDir({ env, root })` below, which is the env-or-default half
   * of that precedence chain: the `--cache-dir` flag is a CLI concern the
   * caller resolves before reaching here.
   */
  cacheDir?: string;
  /** In-process LRU size; 2,000 by default. */
  lruSize?: number;
  /** Forwarded to `resolveCacheDir` when `cacheDir` is not given directly. */
  env?: NodeJS.ProcessEnv;
  /** Forwarded to `resolveCacheDir` when `cacheDir` is not given directly. */
  root?: string;
  /**
   * Injectable for tests: total on-disk bytes under the cache directory.
   * Defaults to summing real file sizes via `node:fs/promises`.
   */
  measureBytes?: (cacheDir: string) => Promise<number>;
  /**
   * Injectable for tests: reads one entry file as utf8 text, used both for a
   * `get` that falls through to disk and for the `stats`/`clear` walk. A spy
   * wrapping the default is how a test counts disk reads (Node's own
   * `fs/promises` module is not spyable: its ESM namespace is frozen).
   * Defaults to `node:fs/promises`' `readFile`, whose `ENOENT` rejection for
   * a missing file this module relies on.
   */
  readEntryText?: (path: string) => Promise<string>;
}

const DEFAULT_LRU_SIZE = 2000;
const ONE_GB = 1024 ** 3;

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function entryPath(cacheDir: string, key: string): string {
  return join(cacheDir, key.slice(0, 2), `${key}.json`);
}

interface DiskFile {
  path: string;
  key: string;
}

/** Every `<first2>/<sha1>.json` path under `cacheDir`; `[]` when it does not exist yet. */
async function walkFiles(cacheDir: string): Promise<DiskFile[]> {
  let shards: string[];
  try {
    shards = await readdir(cacheDir);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return [];
    throw err;
  }

  const files: DiskFile[] = [];
  for (const shard of shards) {
    const shardDir = join(cacheDir, shard);
    let names: string[];
    try {
      const shardStat = await stat(shardDir);
      if (!shardStat.isDirectory()) continue;
      names = await readdir(shardDir);
    } catch {
      // Removed or unreadable between the two calls above: skip it.
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      files.push({ path: join(shardDir, name), key: name.slice(0, -'.json'.length) });
    }
  }
  return files;
}

async function defaultMeasureBytes(cacheDir: string): Promise<number> {
  const files = await walkFiles(cacheDir);
  let total = 0;
  for (const file of files) {
    try {
      total += (await stat(file.path)).size;
    } catch {
      // Removed concurrently: does not count.
    }
  }
  return total;
}

/** Reads and parses one entry file; a corrupt file warns once and reads as `undefined`. */
async function readEntryFile(
  readEntryText: (path: string) => Promise<string>,
  path: string,
): Promise<CacheEntry | undefined> {
  let raw: string;
  try {
    raw = await readEntryText(path);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return JSON.parse(raw) as CacheEntry;
  } catch {
    // Left in place, not deleted (task decision): a corrupt file might still
    // be worth a human's attention, and deleting it would hide the evidence.
    log.warn(`candidate cache: corrupt entry at ${path}, treating as a miss`);
    return undefined;
  }
}

/**
 * An in-process LRU (2,000 entries by default) over a disk cache at
 * `<cacheDir>/<first2>/<sha1>.json`. Disk writes are atomic (tmp + rename)
 * through `util/fs`, so a killed process never leaves a half-written entry.
 * There is no eviction on disk in v1 - only `clear` removes files.
 */
export function openCandidateCache(opts: CandidateCacheOptions = {}): CandidateCache {
  const cacheDir = opts.cacheDir ?? resolveCacheDir({ env: opts.env, root: opts.root });
  const lru = new LRUCache<string, CacheEntry>({ max: opts.lruSize ?? DEFAULT_LRU_SIZE });
  const measureBytes = opts.measureBytes ?? defaultMeasureBytes;
  const readEntryText = opts.readEntryText ?? ((path: string) => readFile(path, 'utf8'));

  /** Memoised for the process lifetime (task decision); `refresh: true` recomputes. */
  let memoisedStats: CacheStats | undefined;

  return {
    cacheDir,

    async get(key: string): Promise<CacheEntry | undefined> {
      const hit = lru.get(key);
      if (hit !== undefined) return hit;

      const entry = await readEntryFile(readEntryText, entryPath(cacheDir, key));
      if (entry !== undefined) lru.set(key, entry);
      return entry;
    },

    async set(key: string, entry: CacheEntry): Promise<void> {
      await atomicWriteFile(entryPath(cacheDir, key), JSON.stringify(entry));
      lru.set(key, entry);
    },

    async stats(statsOpts?: StatsOptions): Promise<CacheStats> {
      if (memoisedStats !== undefined && statsOpts?.refresh !== true) return memoisedStats;

      const files = await walkFiles(cacheDir);
      const byModel: Record<string, number> = {};
      const byPromptVersion: Record<string, number> = {};
      let entries = 0;
      for (const file of files) {
        let raw: string;
        try {
          raw = await readEntryText(file.path);
        } catch {
          continue;
        }
        let entry: CacheEntry;
        try {
          entry = JSON.parse(raw) as CacheEntry;
        } catch {
          // A corrupt file counts toward bytes (below) but not toward the
          // entry breakdowns, since it has no readable model/promptVersion.
          continue;
        }
        entries += 1;
        byModel[entry.model] = (byModel[entry.model] ?? 0) + 1;
        byPromptVersion[entry.promptVersion] = (byPromptVersion[entry.promptVersion] ?? 0) + 1;
      }

      const bytes = await measureBytes(cacheDir);
      const result: CacheStats = {
        entries,
        bytes,
        overSizeWarning: bytes > ONE_GB,
        byModel,
        byPromptVersion,
      };
      memoisedStats = result;
      return result;
    },

    async clear(filter?: CacheClearFilter): Promise<number> {
      const hasFilter = filter?.model !== undefined || filter?.promptVersion !== undefined;
      const files = await walkFiles(cacheDir);
      let removed = 0;
      for (const file of files) {
        // An empty filter (the common "clear everything" case) never needs
        // to know what a file holds, so it skips the read entirely.
        let entry: CacheEntry | undefined;
        if (hasFilter) {
          try {
            entry = JSON.parse(await readEntryText(file.path)) as CacheEntry;
          } catch {
            entry = undefined;
          }
        }

        if (filter?.model !== undefined && entry?.model !== filter.model) continue;
        if (filter?.promptVersion !== undefined && entry?.promptVersion !== filter.promptVersion) {
          continue;
        }

        await unlink(file.path);
        lru.delete(file.key);
        removed += 1;
      }
      return removed;
    },
  };
}
