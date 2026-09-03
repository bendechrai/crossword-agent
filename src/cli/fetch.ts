import { join } from 'node:path';

import { loadPuzzleWithSolution } from '../puzzle/loader.js';
import { upsertIndexRow, writeNormalised, type LibraryOptions } from '../puzzle/library.js';
import type { PuzzleIndexRow } from '../puzzle/types.js';
import { getSource } from '../sources/registry.js';
import type { PuzzleRef, SourceAdapter, SourceDownload } from '../sources/types.js';
import { atomicWriteFile, resolvePuzzlesDir, toRepoRelativePosix } from '../util/fs.js';
import { isCliError, notFoundError } from './exit.js';
import type { FetchOptions, GlobalOptions } from './options.js';

/**
 * Runs one ref's download through the adapter, wrapping any non-`CliError`
 * (for example a raw network exception from an injected `fetch`) into a
 * `CliError` (T22/T28 already map a non-ok HTTP response to `NOT_FOUND`;
 * this catches the transport-level failures below that, such as DNS or
 * connection errors, which never reach the `res.ok` check).
 */
async function downloadRef(adapter: SourceAdapter, ref: PuzzleRef): Promise<SourceDownload> {
  try {
    return await adapter.download(ref);
  } catch (error) {
    if (isCliError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw notFoundError(`network error fetching "${ref.id}" from source "${ref.source}": ${message}`);
  }
}

/**
 * Downloads, writes, parses and indexes a single ref. The original bytes are
 * always written before parsing is attempted, so a parse bug never loses the
 * download (a decision baked into T29): if `loadPuzzleWithSolution` throws,
 * the file already on disk survives the failure and the caller's catch just
 * reports it.
 *
 * Parsing goes through `puzzle/loader.ts` (extension -> `puzzle/adapters/*`),
 * never through `SourceAdapter.normalise` - T22 and T27's own adapters leave
 * that hook unimplemented for exactly this reason, and this is the single
 * dispatch point every source's puzzles flow through on their way into the
 * library.
 */
async function fetchOne(
  adapter: SourceAdapter,
  ref: PuzzleRef,
  outDir: string,
  libraryOptions: LibraryOptions,
): Promise<void> {
  const download = await downloadRef(adapter, ref);
  const originalPath = join(outDir, ref.source, `${ref.id}.${download.ext}`);
  await atomicWriteFile(originalPath, download.bytes);

  const parsed = await loadPuzzleWithSolution(originalPath, {
    id: ref.id,
    source: ref.source,
    origin: ref.url,
    date: ref.date,
    title: ref.title,
  });

  const file = await writeNormalised(parsed, libraryOptions);
  const normalisedPath = join(outDir, file.source, `${file.id}.json`);

  const row: PuzzleIndexRow = {
    id: file.id,
    source: file.source,
    date: file.date ?? null,
    title: file.title ?? null,
    style: file.style,
    width: file.width,
    height: file.height,
    slotCount: file.slots.length,
    files: {
      original: toRepoRelativePosix(originalPath),
      normalised: toRepoRelativePosix(normalisedPath),
    },
    schemaVersion: 1,
    parsedBy: file.parsedBy,
    addedAt: new Date().toISOString(),
    bestLetterAccuracy: null,
    lastRunAt: null,
  };
  await upsertIndexRow(row, libraryOptions);

  console.log(`fetched ${file.id}  ${file.width}x${file.height}  ${file.style}  ${file.slots.length} slots`);
}

function printErrorLine(ref: PuzzleRef, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error ${ref.id}: ${message}`);
}

/**
 * T29: `xw fetch <source>`. Resolves the adapter from the registry, calls
 * `list()` with the flags, then downloads, writes, parses and indexes each
 * ref in turn - sequentially, not in parallel, so the Guardian 1 rps ceiling
 * (enforced inside that adapter) is trivially respected and the printed
 * progress lines stay in ref order.
 *
 * A parse failure on one ref prints an error line and moves on to the rest
 * (partial success is still useful); the command still exits 3 at the end
 * if anything failed. `list()` returning no refs at all is also exit 3,
 * with a message naming the source.
 *
 * `--out` (always present; commander defaults it to `puzzles/`) is the only
 * thing that decides the puzzles directory root here, so it always wins
 * over both `$CROSSWORD_PUZZLES_DIR` and a config file's `puzzlesDir` (see
 * `src/util/fs.ts`'s `resolveDir` precedence) - `global.config` therefore
 * has nothing left to contribute to this resolution, unlike `list`/`show`,
 * which have no `--out` flag of their own.
 */
export async function fetchCommand(source: string, opts: FetchOptions, _global: GlobalOptions): Promise<void> {
  const adapter = getSource(source);
  const outDir = resolvePuzzlesDir({ flag: opts.out });
  const libraryOptions: LibraryOptions = { puzzlesDir: outDir };

  const refs = await adapter.list({
    series: opts.series,
    date: opts.date,
    from: opts.from,
    to: opts.to,
    limit: opts.limit,
    path: opts.path,
  });

  if (refs.length === 0) {
    throw notFoundError(`source "${source}" returned no puzzles for the given options`);
  }

  let failures = 0;
  for (const ref of refs) {
    try {
      await fetchOne(adapter, ref, outDir, libraryOptions);
    } catch (error) {
      failures += 1;
      printErrorLine(ref, error);
    }
  }

  if (failures > 0) {
    throw notFoundError(
      `fetch from "${source}" finished with ${failures} of ${refs.length} puzzle(s) failing; see the error line(s) above`,
    );
  }
}
