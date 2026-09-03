import AdmZip from 'adm-zip';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { notFoundError } from '../cli/exit.js';
import type { PuzzleWithSolution } from '../puzzle/types.js';
import type {
  PuzzleRef,
  SourceAdapter,
  SourceDownload,
  SourceListOptions,
} from './types.js';

export interface XdSourceOptions {
  /** Local directory or zip; `./corpora/xd-puzzles.zip` by default. */
  path?: string;
}

export const XD_DEFAULT_PATH = 'corpora/xd-puzzles.zip';

/**
 * T27: reads a local directory or a `.zip` of the xd corpus. No network at
 * any point - the corpus is expected to already be on disk (see README for
 * how to obtain one).
 */

const XD_EXT_RE = /\.xd$/i;
const ISO_DATE_RE = /(\d{4}-\d{2}-\d{2})/;

/** Internal scheme used to encode "a lazily-read entry inside this zip" into `PuzzleRef.url`. */
const ZIP_SCHEME = 'zip:';
const ZIP_SEPARATOR = '::';

interface XdEntry {
  /** POSIX-separated, relative to the corpus root (directory or zip) - used for id/date/title. */
  relPath: string;
  date: string | null;
}

/** Turns `foo/1963-05-01-title.xd` into the file's own name, extension stripped, case-insensitively. */
function stemOf(relPath: string): string {
  const name = relPath.split('/').pop() ?? relPath;
  return name.replace(XD_EXT_RE, '');
}

/** Sanitises a stem into `[A-Za-z0-9._-]+`, matching the id shape the other adapters use. */
function sanitiseId(stem: string): string {
  const cleaned = stem.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'xd';
}

function dateFromPath(relPath: string): string | null {
  const match = ISO_DATE_RE.exec(relPath);
  return match?.[1] ?? null;
}

function toPosix(path: string): string {
  return path.split('\\').join('/');
}

function resolveTarget(opts: SourceListOptions, ctorPath: string | undefined): string {
  const chosen = opts.path ?? ctorPath ?? XD_DEFAULT_PATH;
  return resolve(chosen);
}

function assertTargetExists(target: string, opts: SourceListOptions): void {
  if (existsSync(target)) return;
  const given = opts.path !== undefined ? `"${opts.path}"` : 'the default path';
  throw notFoundError(
    `xd corpus not found at ${given} (resolved to "${target}"); the default is ` +
      `"${XD_DEFAULT_PATH}" - see README for how to download the xd corpus (this is not a fetch)`,
  );
}

// --------------------------------------------------------------------------
// Directory-backed corpus.
// --------------------------------------------------------------------------

function walkXdFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (XD_EXT_RE.test(entry.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

function listDirEntries(root: string): Array<XdEntry & { url: string }> {
  return walkXdFiles(root).map((absPath) => {
    const relPath = toPosix(relative(root, absPath));
    return { relPath, date: dateFromPath(relPath), url: absPath };
  });
}

// --------------------------------------------------------------------------
// Zip-backed corpus. Entries are listed via the zip's central directory
// (cheap) and only decompressed, by name, when `download` actually needs the
// bytes - the archive is never expanded to disk.
// --------------------------------------------------------------------------

function zipUrl(zipAbsPath: string, entryName: string): string {
  return `${ZIP_SCHEME}${zipAbsPath}${ZIP_SEPARATOR}${entryName}`;
}

function parseZipUrl(url: string): { zipPath: string; entryName: string } | null {
  if (!url.startsWith(ZIP_SCHEME)) return null;
  const rest = url.slice(ZIP_SCHEME.length);
  const idx = rest.lastIndexOf(ZIP_SEPARATOR);
  if (idx === -1) return null;
  return { zipPath: rest.slice(0, idx), entryName: rest.slice(idx + ZIP_SEPARATOR.length) };
}

function listZipEntries(zipAbsPath: string): Array<XdEntry & { url: string }> {
  const zip = new AdmZip(zipAbsPath);
  const out: Array<XdEntry & { url: string }> = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (!XD_EXT_RE.test(entry.entryName)) continue;
    const relPath = toPosix(entry.entryName);
    out.push({ relPath, date: dateFromPath(relPath), url: zipUrl(zipAbsPath, entry.entryName) });
  }
  return out;
}

// --------------------------------------------------------------------------
// list() / download()
// --------------------------------------------------------------------------

function passesDateFilter(date: string | null, opts: SourceListOptions): boolean {
  const hasFilter = opts.date !== undefined || opts.from !== undefined || opts.to !== undefined;
  if (!hasFilter) return true;
  if (date === null) return false;
  if (opts.date !== undefined) return date === opts.date;
  if (opts.from !== undefined && date < opts.from) return false;
  if (opts.to !== undefined && date > opts.to) return false;
  return true;
}

function toRef(entry: XdEntry & { url: string }): PuzzleRef {
  const ref: PuzzleRef = {
    id: `xd-${sanitiseId(stemOf(entry.relPath))}`,
    source: 'xd',
    url: entry.url,
    ext: 'xd',
    title: entry.relPath.split('/').pop() ?? entry.relPath,
  };
  if (entry.date !== null) ref.date = entry.date;
  return ref;
}

function listXd(opts: SourceListOptions, ctorPath: string | undefined): Promise<PuzzleRef[]> {
  try {
    const target = resolveTarget(opts, ctorPath);
    assertTargetExists(target, opts);

    const isDir = statSync(target).isDirectory();
    const entries = isDir ? listDirEntries(target) : listZipEntries(target);
    if (entries.length === 0) {
      throw notFoundError(`no .xd entries found in xd corpus at "${target}"`);
    }

    const filtered = entries
      .filter((entry) => passesDateFilter(entry.date, opts))
      .sort((a, b) => a.relPath.localeCompare(b.relPath));

    const limit = opts.limit ?? 1;
    return Promise.resolve(filtered.slice(0, limit).map(toRef));
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
}

async function downloadXd(ref: PuzzleRef): Promise<SourceDownload> {
  const zipRef = parseZipUrl(ref.url);
  if (zipRef !== null) {
    const zip = new AdmZip(zipRef.zipPath);
    const entry = zip.getEntry(zipRef.entryName);
    if (entry === null) {
      throw notFoundError(`xd corpus entry "${zipRef.entryName}" not found in ${zipRef.zipPath}`);
    }
    return { bytes: entry.getData(), ext: 'xd' };
  }
  try {
    const bytes = await readFile(ref.url);
    return { bytes, ext: 'xd' };
  } catch (e) {
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw notFoundError(`xd corpus entry not found: ${ref.url}`);
    }
    throw e;
  }
}

/**
 * `normalise` is intentionally not implemented here: parsing bytes into a
 * `PuzzleWithSolution` is T25's job (out of scope for this adapter), and the
 * dispatch the CLI actually uses runs through `src/puzzle/loader.ts`
 * (extension -> `puzzle/adapters/*`), never through this hook.
 */
export function createXdSource(opts: XdSourceOptions = {}): SourceAdapter {
  const ctorPath = opts.path;
  return {
    id: 'xd',
    list: (listOpts) => listXd(listOpts, ctorPath),
    download: (ref) => downloadXd(ref),
    normalise: (): Promise<PuzzleWithSolution> =>
      Promise.reject(
        new Error(
          'src/sources/xd.ts: normalise() is not used by this adapter - puzzles are ' +
            'parsed via src/puzzle/loader.ts, not via SourceAdapter.normalise',
        ),
      ),
  };
}

/** The instance the registry holds. */
export const xdSource: SourceAdapter = createXdSource();
