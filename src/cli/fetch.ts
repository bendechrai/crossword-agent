import { join } from 'node:path';

import { loadPuzzleWithSolution } from '../puzzle/loader.js';
import { upsertIndexRow, writeNormalised, type LibraryOptions } from '../puzzle/library.js';
import type { PuzzleIndexRow, PuzzleStyle } from '../puzzle/types.js';
import { getSource } from '../sources/registry.js';
import type { PuzzleRef, SourceAdapter, SourceDownload } from '../sources/types.js';
import { atomicWriteFile, resolvePuzzlesDir, toRepoRelativePosix } from '../util/fs.js';
import { isCliError, notFoundError } from './exit.js';
import type { FetchOptions, GlobalOptions } from './options.js';

/**
 * Series -> style (T60). Mirrors src/sources/guardian.ts's own SERIES_STYLE
 * table (spec: "Puzzle library and sources", `guardian` bullet) - duplicated
 * here rather than imported because that module is read-only for this task
 * and does not export it, and because this is the one place that builds the
 * loader context every source's puzzles flow through (fetchOne below, via
 * `puzzle/loader.ts`, never through `SourceAdapter.normalise`). Cryptic
 * family (cryptic, prize, quiptic, everyman, weekend) -> "cryptic"; quick
 * family (quick, speedy) -> "quick" (the PuzzleStyle union already has a
 * `quick` member, so no `american` stand-in mapping is needed).
 */
const GUARDIAN_SERIES_STYLE: Readonly<Record<string, PuzzleStyle>> = {
  cryptic: 'cryptic',
  prize: 'cryptic',
  quiptic: 'cryptic',
  everyman: 'cryptic',
  weekend: 'cryptic',
  quick: 'quick',
  speedy: 'quick',
};

/** Guardian puzzle ids from src/sources/guardian.ts's `list()`: `guardian-<series>-<id>`. */
const GUARDIAN_REF_ID_RE = /^guardian-([a-z]+)-\d+$/;
/** Guardian puzzle URLs from the same module: `.../crosswords/<series>/<id>.json`. */
const GUARDIAN_URL_RE = /\/crosswords\/([^/]+)\/\d+\.json$/;

/**
 * Derives the puzzle's style from a ref that came from the `guardian`
 * source, so it can be passed into the loader context (see `fetchOne`)
 * instead of every Guardian fetch landing as style `unknown` (T60). The
 * Guardian source's `PuzzleRef` carries no dedicated `series`/`style` field
 * of its own (frozen: src/sources/types.ts, src/sources/guardian.ts), only
 * the series folded into the ref's `id` and `url`; a series this table does
 * not recognise, or a ref from any other source, yields `undefined` so the
 * adapter falls back to its own default.
 */
function guardianStyleForRef(ref: PuzzleRef): PuzzleStyle | undefined {
  if (ref.source !== 'guardian') return undefined;
  const series = GUARDIAN_REF_ID_RE.exec(ref.id)?.[1] ?? GUARDIAN_URL_RE.exec(ref.url)?.[1];
  if (series === undefined) return undefined;
  return GUARDIAN_SERIES_STYLE[series];
}

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
 * library. `date`/`title` come straight off the ref; `style` is derived here
 * (see `guardianStyleForRef`, T60) since no `PuzzleRef` field carries it -
 * every puzzle adapter honours a `ctx.style` that is present and falls back
 * to its own default otherwise, so a non-Guardian ref (where the helper
 * returns `undefined`) is unaffected.
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
    style: guardianStyleForRef(ref),
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
