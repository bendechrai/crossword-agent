import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { notFoundError, usageError } from '../cli/exit.js';
import type { PuzzleExt, PuzzleWithSolution } from '../puzzle/types.js';
import type {
  FetchLike,
  PuzzleRef,
  SourceAdapter,
  SourceDownload,
  SourceListOptions,
} from './types.js';

export interface FileSourceOptions {
  /** Injected so tests stay offline; used only for http(s) refs. */
  fetch?: FetchLike;
}

/** T22: imports a local path or a URL to a single .puz/.ipuz/.jpz/.xd. */
const ACCEPTED_EXTS: ReadonlyArray<PuzzleExt> = ['puz', 'ipuz', 'jpz', 'xd', 'json'];

function isAcceptedExt(value: string): value is PuzzleExt {
  return (ACCEPTED_EXTS as ReadonlyArray<string>).includes(value);
}

function acceptedExtsMessage(): string {
  return `accepted extensions are ${ACCEPTED_EXTS.join(', ')}`;
}

/** Sanitise a basename (extension already stripped) into `[A-Za-z0-9._-]+`. */
function sanitiseId(stem: string): string {
  const cleaned = stem.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'file';
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Builds the ref for a single file, given its basename (with extension,
 * unsanitised - this is what lands in `title`) and the url/path it came
 * from. Shared by the local-path and http(s) branches of `list`.
 */
function refFromName(name: string, url: string): PuzzleRef {
  const ext = extname(name).replace(/^\./, '').toLowerCase();
  if (!isAcceptedExt(ext)) {
    // A URL with no recognisable extension lands here too (ext === ""): a
    // usage error naming the accepted set, never a guess.
    const what = ext.length > 0 ? `"${ext}"` : `"${name}"`;
    throw usageError(`unsupported puzzle extension ${what}: ${acceptedExtsMessage()}`);
  }
  const stem = basename(name, extname(name));
  return {
    id: sanitiseId(stem),
    source: 'file',
    url,
    ext,
    title: name,
  };
}

function refFromUrl(raw: string): PuzzleRef {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw usageError(`not a valid URL: ${raw}`);
  }
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  const lastSegment = segments[segments.length - 1] ?? '';
  const name = decodeURIComponent(lastSegment);
  // The url on the ref is the original, untransformed input, so `download`
  // fetches exactly what the caller gave us.
  return refFromName(name, raw);
}

function listFile(opts: SourceListOptions): Promise<PuzzleRef[]> {
  try {
    const target = opts.path;
    if (target === undefined || target.length === 0) {
      throw usageError('the file source needs a local path or URL to import (--path)');
    }
    const ref = isHttpUrl(target) ? refFromUrl(target) : refFromName(basename(target), target);
    return Promise.resolve([ref]);
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
}

async function downloadFile(
  ref: PuzzleRef,
  fetchImpl: FetchLike | undefined,
): Promise<SourceDownload> {
  if (isHttpUrl(ref.url)) {
    const doFetch = fetchImpl ?? globalThis.fetch;
    const res = await doFetch(ref.url);
    if (!res.ok) {
      throw notFoundError(`failed to fetch ${ref.url}: HTTP ${res.status}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    return { bytes, ext: ref.ext };
  }
  try {
    const bytes = await readFile(ref.url);
    return { bytes, ext: ref.ext };
  } catch (e) {
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw notFoundError(`file not found: ${ref.url}`);
    }
    throw e;
  }
}

/**
 * T22: imports a local path or a URL to a single .puz/.ipuz/.jpz/.xd.
 *
 * `normalise` is intentionally not implemented here: parsing bytes into a
 * `PuzzleWithSolution` is T24/T25's job (out of scope for this adapter), and
 * the actual dispatch the CLI uses runs through `src/puzzle/loader.ts`
 * (extension -> `puzzle/adapters/*`), never through this hook.
 */
export function createFileSource(opts: FileSourceOptions = {}): SourceAdapter {
  const fetchImpl = opts.fetch;
  return {
    id: 'file',
    list: (listOpts) => listFile(listOpts),
    download: (ref) => downloadFile(ref, fetchImpl),
    normalise: (): Promise<PuzzleWithSolution> =>
      Promise.reject(
        new Error(
          'src/sources/file.ts: normalise() is not used by this adapter - puzzles are ' +
            'parsed via src/puzzle/loader.ts, not via SourceAdapter.normalise',
        ),
      ),
  };
}

/** The instance the registry holds. */
export const fileSource: SourceAdapter = createFileSource();
