import { loadConfig } from '../config.js';
import { readIndex, type LibraryOptions } from '../puzzle/library.js';
import type { PuzzleIndexRow } from '../puzzle/types.js';
import { resolvePuzzlesDir } from '../util/fs.js';
import type { GlobalOptions, ListOptions } from './options.js';

/** B33: the message printed on a genuinely empty index (not a filtered-to-empty result). */
const EMPTY_LIBRARY_MESSAGE = 'no puzzles yet - try: xw fetch xd --limit 5';

const COLUMNS = ['id', 'source', 'date', 'size', 'style', 'slots', 'best letters', 'last run'] as const;

/** No single cell is ever wider than this, regardless of table width. */
const MAX_CELL_WIDTH = 24;
const COLUMN_GAP = '  ';

/** The table is capped to this many columns; see `fitWidths`. */
const TABLE_WIDTH = 80;

/** A shrunk free-text column never goes narrower than this. */
const MIN_FREE_TEXT_WIDTH = 8;

/**
 * Columns free-form enough to truncate when the table would otherwise exceed
 * `TABLE_WIDTH`, in shrink priority order (used as a tiebreak when two
 * columns are equally wide).
 */
const FREE_TEXT_COLUMNS = ['id', 'style', 'source'] as const;

/**
 * `--config` > `$CROSSWORD_CONFIG` (via `loadConfig`) resolves the config
 * file, whose `puzzlesDir` (if any) then flows into `resolvePuzzlesDir`'s own
 * precedence (flag > env > config > default). `list`/`show` have no
 * `--puzzles-dir` flag of their own, so `flag` is always absent here.
 */
async function resolveLibraryOptions(global: GlobalOptions): Promise<LibraryOptions> {
  const { config } = await loadConfig({ path: global.config });
  return { puzzlesDir: resolvePuzzlesDir({ config: config.puzzlesDir }) };
}

function matchesFilters(row: PuzzleIndexRow, opts: ListOptions): boolean {
  if (opts.source !== undefined && row.source !== opts.source) return false;
  if (opts.style !== undefined && row.style !== opts.style) return false;
  if (opts.solved && row.bestLetterAccuracy !== 1) return false;
  return true;
}

function truncate(value: string): string {
  return value.length > MAX_CELL_WIDTH ? `${value.slice(0, MAX_CELL_WIDTH - 3)}...` : value;
}

function formatSize(row: PuzzleIndexRow): string {
  return `${row.width}x${row.height}`;
}

function formatAccuracy(value: number | null): string {
  return value === null ? '-' : `${Math.round(value * 100)}%`;
}

/** Renders only the date portion of an ISO timestamp, so the column stays narrow. */
function formatIsoDate(value: string | null): string {
  return value === null ? '-' : (value.slice(0, 10) || '-');
}

function rowCells(row: PuzzleIndexRow): string[] {
  return [
    row.id,
    row.source,
    row.date ?? '-',
    formatSize(row),
    row.style,
    String(row.slotCount),
    formatAccuracy(row.bestLetterAccuracy),
    formatIsoDate(row.lastRunAt),
  ].map(truncate);
}

function computeWidths(header: readonly string[], rows: readonly string[][]): number[] {
  return header.map((heading, i) => {
    let max = heading.length;
    for (const row of rows) {
      const value = row[i] ?? '';
      if (value.length > max) max = value.length;
    }
    return max;
  });
}

function tableWidth(widths: readonly number[]): number {
  return widths.reduce((sum, w) => sum + w, 0) + COLUMN_GAP.length * Math.max(widths.length - 1, 0);
}

/**
 * Shrinks the free-text columns (id, then style, then source; see
 * `FREE_TEXT_COLUMNS`) one character at a time, always picking whichever of
 * those is currently widest, until the table fits `TABLE_WIDTH` columns or
 * every free-text column has hit `MIN_FREE_TEXT_WIDTH`. Other columns (date,
 * size, slots, best letters, last run) are never shrunk since their content
 * is already narrow and fixed-format.
 */
function fitWidths(header: readonly string[], widths: readonly number[]): number[] {
  const fitted = [...widths];
  const shrinkable = FREE_TEXT_COLUMNS.map((name) => header.indexOf(name)).filter((i) => i >= 0);

  while (tableWidth(fitted) > TABLE_WIDTH) {
    const candidates = shrinkable.filter((i) => (fitted[i] ?? 0) > MIN_FREE_TEXT_WIDTH);
    if (candidates.length === 0) break;
    const widest = candidates.reduce((a, b) => ((fitted[b] ?? 0) > (fitted[a] ?? 0) ? b : a));
    fitted[widest] = (fitted[widest] ?? 0) - 1;
  }

  return fitted;
}

function truncateTo(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

function formatLine(cells: readonly string[], widths: readonly number[]): string {
  return cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(COLUMN_GAP).trimEnd();
}

function printTable(rows: readonly PuzzleIndexRow[]): void {
  const header: string[] = [...COLUMNS];
  const dataRows = rows.map(rowCells);
  const widths = fitWidths(header, computeWidths(header, dataRows));
  const fittedRows = dataRows.map((row) => row.map((cell, i) => truncateTo(cell, widths[i] ?? cell.length)));
  console.log(formatLine(header, widths));
  for (const row of fittedRows) console.log(formatLine(row, widths));
}

/**
 * T30: reads only the index, so it works offline. B33: an empty index prints
 * `no puzzles yet - try: xw fetch xd --limit 5` and exits 0, `--json` prints
 * `[]`, and null metrics render as `-`.
 *
 * `libraryOptions` lets tests point directly at a fixture `puzzlesDir`
 * without going through a config file; the real CLI never passes it, so it
 * always falls back to `resolveLibraryOptions(global)`.
 */
export async function listCommand(
  opts: ListOptions,
  global: GlobalOptions,
  libraryOptions?: LibraryOptions,
): Promise<void> {
  const lib = libraryOptions ?? (await resolveLibraryOptions(global));
  const rows = await readIndex(lib);
  const filtered = rows.filter((row) => matchesFilters(row, opts));

  if (opts.json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  // B33's empty case is about the index itself being empty, not a filter
  // narrowing a non-empty index down to zero rows.
  if (rows.length === 0) {
    console.log(EMPTY_LIBRARY_MESSAGE);
    return;
  }

  printTable(filtered);
}
