import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import type { CandidateCacheOptions } from '../candidates/cache.js';
import { openCandidateCache } from '../candidates/cache.js';
import type { InferenceLogRecord } from '../llm/types.js';
import { atomicWriteFile, resolveCacheDir, resolveInferenceLogDir } from '../util/fs.js';
import { usageError } from './exit.js';
import type { CacheClearOptions, GlobalOptions } from './options.js';

/**
 * T35: `xw cache stats|clear|export <file>|import <file>` (B24). Every
 * command resolves its own cache directory and opens its own
 * `CandidateCache` instance (T12's `stats()` is memoised for the process
 * lifetime and is not invalidated by `set`/`clear`, so a long-lived shared
 * instance across commands would risk stale numbers - a fresh instance per
 * command sidesteps that entirely).
 *
 * `overrides` lets tests point directly at a fixture directory (and, for
 * `stats`, inject the inference-log directory and disk-size function)
 * without going through real filesystem resolution, matching the
 * `libraryOptions` pattern in `src/cli/list.ts` and `src/cli/show.ts`. The
 * real CLI never passes it.
 */
export interface CacheCommandOverrides {
  cacheDir?: string;
  inferenceLogDir?: string;
  measureBytes?: CandidateCacheOptions['measureBytes'];
}

/**
 * `resolveCacheDir({ flag, env })` (B24): the `--cache-dir` flag takes the
 * already-resolved `global.cacheDir` (from commander), and the directory is
 * resolved fresh per command rather than threaded through as a raw string.
 */
function commandCacheDir(global: GlobalOptions, overrides: CacheCommandOverrides): string {
  if (overrides.cacheDir !== undefined) return overrides.cacheDir;
  return resolveCacheDir({ flag: global.cacheDir, env: process.env });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatPercent(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}

function sortedCounts(counts: Record<string, number>): Array<[string, number]> {
  return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
}

/**
 * The cache-hit rate of the most recent run, read from the raw inference log
 * (`logs/inference/*.jsonl`, T10) rather than from the disk cache itself: a
 * `CandidateCache` records no hit/miss history of its own, only the entries
 * it holds. Records are grouped by `runId` (calibration/smoke calls carry a
 * null `runId` and are excluded) and the group with the latest `ts` wins.
 * Best-effort: a missing or unreadable log directory, or a log with no
 * run-scoped records, yields `null` rather than throwing - `cache stats`
 * must still work on a machine that has never run `solve`.
 */
async function lastRunHitRate(
  inferenceLogDir: string,
): Promise<{ hits: number; total: number } | null> {
  let files: string[];
  try {
    files = (await readdir(inferenceLogDir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }

  const byRun = new Map<string, InferenceLogRecord[]>();
  let latestRunId: string | null = null;
  let latestTs = '';

  for (const file of files.sort()) {
    let text: string;
    try {
      text = await readFile(join(inferenceLogDir, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let record: InferenceLogRecord;
      try {
        record = JSON.parse(line) as InferenceLogRecord;
      } catch {
        continue;
      }
      if (record.runId === null) continue;
      const group = byRun.get(record.runId) ?? [];
      group.push(record);
      byRun.set(record.runId, group);
      if (record.ts > latestTs) {
        latestTs = record.ts;
        latestRunId = record.runId;
      }
    }
  }

  if (latestRunId === null) return null;
  const records = byRun.get(latestRunId) ?? [];
  const hits = records.filter((r) => r.cacheHit).length;
  return { hits, total: records.length };
}

/**
 * `stats` never loads entry bodies beyond what `CandidateCache.stats()`
 * itself reads (sizes and metadata only), so it stays fast on a large cache.
 */
export async function cacheStatsCommand(
  global: GlobalOptions,
  overrides: CacheCommandOverrides = {},
): Promise<void> {
  const cacheDir = commandCacheDir(global, overrides);
  const cache = openCandidateCache({ cacheDir, measureBytes: overrides.measureBytes });
  const stats = await cache.stats();

  console.log(`cache dir: ${cache.cacheDir}`);
  console.log(`entries: ${stats.entries}`);
  console.log(`bytes: ${stats.bytes}`);

  const inferenceLogDir = overrides.inferenceLogDir ?? resolveInferenceLogDir();
  const hitRate = await lastRunHitRate(inferenceLogDir);
  console.log(
    hitRate === null
      ? 'last-run hit rate: n/a (no run found in the inference log)'
      : `last-run hit rate: ${formatPercent(hitRate.total === 0 ? 0 : hitRate.hits / hitRate.total)} (${hitRate.hits}/${hitRate.total})`,
  );

  console.log('by model:');
  for (const [model, count] of sortedCounts(stats.byModel)) {
    console.log(`  ${model}: ${count}`);
  }

  console.log('by prompt version:');
  for (const [promptVersion, count] of sortedCounts(stats.byPromptVersion)) {
    console.log(`  ${promptVersion}: ${count}`);
  }

  if (stats.overSizeWarning) {
    console.log(`WARNING: cache directory exceeds 1 GB (${stats.bytes} bytes)`);
  }
}

/**
 * `src/cli/options.ts`'s `CacheClearOptions` (frozen; T35 may not edit it)
 * has no `yes` field and `src/cli/index.ts`'s `cache clear` subcommand (also
 * frozen) registers no `--yes` flag - see this PR's "Spec conflict" /
 * deviations note. `CacheClearInput` widens the type this module accepts so
 * the B24 confirmation gate below is implementable and testable now; wiring
 * an actual `--yes` flag through commander needs an edit to those two frozen
 * files that is outside this task's Owns list.
 */
export interface CacheClearInput extends CacheClearOptions {
  yes?: boolean;
}

/**
 * `clear` with neither `--model` nor `--prompt-version` requires `--yes`
 * (surfaced here as `opts.yes`, see `CacheClearInput`): clearing the whole
 * cache turns every later offline run into a network run.
 */
export async function cacheClearCommand(
  opts: CacheClearInput,
  global: GlobalOptions,
  overrides: CacheCommandOverrides = {},
): Promise<void> {
  const hasFilter = opts.model !== undefined || opts.promptVersion !== undefined;
  if (!hasFilter && opts.yes !== true) {
    throw usageError(
      'clearing the entire cache requires --yes: it turns every later offline run into a network run',
      'pass --yes to confirm, or --model / --prompt-version to filter',
    );
  }

  const cacheDir = commandCacheDir(global, overrides);
  const cache = openCandidateCache({ cacheDir });
  const removed = await cache.clear({ model: opts.model, promptVersion: opts.promptVersion });
  console.log(`removed ${removed} entr${removed === 1 ? 'y' : 'ies'}`);
}

const TAR_BLOCK = 512;

/** Writes `value` left-padded with zeros into an octal tar field of `fieldLength` bytes, NUL-terminated. */
function padOctal(value: number, fieldLength: number): string {
  return `${value.toString(8).padStart(fieldLength - 1, '0')}\0`;
}

function writeAsciiField(buf: Buffer, value: string, offset: number, length: number): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) {
    throw new Error(`tar field too long: "${value}" (${String(bytes.length)} > ${String(length)})`);
  }
  bytes.copy(buf, offset);
}

/** A minimal USTAR header for one regular-file entry (node:zlib handles compression, not framing). */
function tarHeader(name: string, size: number): Buffer {
  const buf = Buffer.alloc(TAR_BLOCK, 0);
  writeAsciiField(buf, name, 0, 100);
  writeAsciiField(buf, padOctal(0o644, 8), 100, 8); // mode
  writeAsciiField(buf, padOctal(0, 8), 108, 8); // uid
  writeAsciiField(buf, padOctal(0, 8), 116, 8); // gid
  writeAsciiField(buf, padOctal(size, 12), 124, 12); // size
  writeAsciiField(buf, padOctal(0, 12), 136, 12); // mtime
  buf.fill(0x20, 148, 156); // checksum placeholder: 8 spaces while summing
  buf[156] = 0x30; // typeflag '0': regular file
  writeAsciiField(buf, 'ustar\0', 257, 6); // magic
  writeAsciiField(buf, '00', 263, 2); // version

  let sum = 0;
  for (const b of buf) sum += b;
  writeAsciiField(buf, `${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return buf;
}

function padToBlock(buf: Buffer): Buffer {
  const rem = buf.length % TAR_BLOCK;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(TAR_BLOCK - rem, 0)]);
}

interface FileToArchive {
  /** POSIX-separated, relative to the cache directory. */
  relPath: string;
  absPath: string;
}

/** Every regular file under `dir`, recursively, in a deterministic (sorted) order. */
async function walkTree(root: string, dir: string, out: FileToArchive[]): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return;
    throw err;
  }

  for (const name of [...names].sort()) {
    const abs = join(dir, name);
    const st = await stat(abs);
    if (st.isDirectory()) {
      await walkTree(root, abs, out);
    } else if (st.isFile()) {
      out.push({ relPath: relative(root, abs).split(sep).join('/'), absPath: abs });
    }
  }
}

/**
 * `export` writes a tarball of the resolved cache directory. Export excludes
 * nothing (a negative entry is part of the cache and must ship): this walks
 * every file under `cacheDir` without inspecting its content.
 */
export async function cacheExportCommand(
  file: string,
  global: GlobalOptions,
  overrides: CacheCommandOverrides = {},
): Promise<void> {
  const cacheDir = commandCacheDir(global, overrides);
  const files: FileToArchive[] = [];
  await walkTree(cacheDir, cacheDir, files);

  const parts: Buffer[] = [];
  for (const entry of files) {
    const content = await readFile(entry.absPath);
    parts.push(tarHeader(entry.relPath, content.length));
    parts.push(padToBlock(content));
  }
  parts.push(Buffer.alloc(TAR_BLOCK * 2, 0)); // end-of-archive marker

  const tarball = gzipSync(Buffer.concat(parts));
  await atomicWriteFile(file, tarball);
  console.log(`exported ${String(files.length)} entr${files.length === 1 ? 'y' : 'ies'} to ${file}`);
}

interface TarEntry {
  name: string;
  content: Buffer;
}

function readAsciiField(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8').trim();
}

function readOctalField(buf: Buffer, offset: number, length: number): number {
  const raw = readAsciiField(buf, offset, length).trim();
  return raw === '' ? 0 : Number.parseInt(raw, 8);
}

/** Parses a raw (already-decompressed) USTAR byte stream back into regular-file entries. */
function parseTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + TAR_BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + TAR_BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive block

    const name = readAsciiField(header, 0, 100);
    const size = readOctalField(header, 124, 12);
    const typeflag = header[156];
    offset += TAR_BLOCK;

    const content = Buffer.from(buf.subarray(offset, offset + size));
    offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

    // '0' and the legacy NUL both mean "regular file"; anything else (a
    // directory entry, say) this writer never produces but a foreign tar
    // might, and it carries no cache content worth importing.
    if (typeflag === 0x30 || typeflag === 0) {
      entries.push({ name, content });
    }
  }

  return entries;
}

/** Refuses a tarball entry whose path would write outside the cache directory. */
function assertSafeRelativePath(name: string): void {
  if (name === '' || isAbsolute(name) || name.includes('\0')) {
    throw usageError(`tarball entry "${name}" has an invalid path`, 'refusing to import it');
  }
  if (name.split('/').some((segment) => segment === '..' || segment === '')) {
    throw usageError(
      `tarball entry "${name}" escapes the cache directory`,
      'refusing to import a path-traversal entry',
    );
  }
}

/**
 * `import` reads a tarball produced by `export` back into the resolved cache
 * directory. Every entry's path is validated before anything is written, so
 * a path-traversal entry (B24 acceptance: a `../` segment) is refused with
 * exit 2 and nothing from the tarball is written.
 */
export async function cacheImportCommand(
  file: string,
  global: GlobalOptions,
  overrides: CacheCommandOverrides = {},
): Promise<void> {
  const cacheDir = commandCacheDir(global, overrides);

  const gz = await readFile(file);
  let tarBuf: Buffer;
  try {
    tarBuf = gunzipSync(gz);
  } catch (err) {
    throw usageError(`"${file}" is not a valid gzip tarball: ${messageOf(err)}`);
  }

  const entries = parseTar(tarBuf);
  for (const entry of entries) assertSafeRelativePath(entry.name);

  for (const entry of entries) {
    await atomicWriteFile(join(cacheDir, ...entry.name.split('/')), entry.content);
  }

  console.log(`imported ${String(entries.length)} entr${entries.length === 1 ? 'y' : 'ies'} into ${cacheDir}`);
}
