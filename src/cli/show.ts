import { loadConfig } from '../config.js';
import { findRun, latestRun } from '../eval/runs.js';
import type { RunRecord, PerSlotRecord } from '../eval/types.js';
import { loadPuzzleById, readNormalised, type LibraryOptions } from '../puzzle/library.js';
import type { Puzzle, Slot } from '../puzzle/types.js';
import { resolveRunsDir, resolvePuzzlesDir } from '../util/fs.js';
import { log } from '../util/log.js';
import { ExitCode, isCliError, notFoundError, usageError } from './exit.js';
import type { GlobalOptions, ShowOptions } from './options.js';

/**
 * T59: `puzzlesDir` lets tests point directly at a fixture library (same
 * pattern as the plain `LibraryOptions` T30 used to take); `runsDir` lets
 * them point at a fixture runs directory instead of the real resolver below.
 */
export interface ShowCommandOverrides extends LibraryOptions {
  runsDir?: string;
}

/** Same precedence resolution as `list` (see src/cli/list.ts for the rationale). */
async function resolveLibraryOptions(global: GlobalOptions): Promise<LibraryOptions> {
  const { config } = await loadConfig({ path: global.config });
  return { puzzlesDir: resolvePuzzlesDir({ config: config.puzzlesDir }) };
}

/**
 * T59: the runs directory `--run` reads from is the same one `xw solve`
 * writes a run record to by default (`src/eval/runRecorder.ts`'s
 * `resolveOutPath`, used whenever `solve`'s own `--out` is not given): just
 * `resolveRunsDir({ env })`, matching `src/cli/solve.ts`'s own call for its
 * `.events.jsonl` trace path. Deliberately not `{ config: config.runsDir }`:
 * `solve`'s default run-record write path does not consult that config field
 * either (`RunRecorder`'s `resolveOutPath` calls `resolveRunsDir()` with no
 * options at all), so reading it here would silently point at a different
 * directory than the one `solve` actually wrote to whenever a `config.json`
 * set `runsDir`. `show --run`'s own `--out` is not consulted (there is none;
 * `solve --out` names one run file, not a directory).
 */
function resolveShowRunsDir(overrides?: ShowCommandOverrides): string {
  return overrides?.runsDir ?? resolveRunsDir({ env: process.env });
}

function printGrid(puzzle: Puzzle, solution: string[][] | null): void {
  for (const row of puzzle.cells) {
    const line = row
      .map((cell) => {
        if (cell.block) return '#';
        if (solution === null) return '.';
        const letter = solution[cell.row]?.[cell.col];
        return letter !== undefined && letter !== '' ? letter : '.';
      })
      .join(' ');
    console.log(line);
  }
}

function printClueList(label: string, slots: readonly Slot[]): void {
  console.log(`${label}:`);
  const sorted = [...slots].sort((a, b) => a.number - b.number);
  for (const slot of sorted) {
    console.log(`  ${slot.number}. ${slot.clue}`);
  }
}

/**
 * T59: reconstructs a `printGrid`-shaped letters matrix from a run record's
 * `perSlot` filled answers, placed along each slot's own `cells` (so an
 * irregular or unchecked grid is handled the same way the loader already
 * handles it - `Slot.cells` is the source of truth, not row/col plus
 * direction plus length). A slot with no record, or `filled: null` (an
 * unfilled slot in a partial run), leaves its cells untouched, which
 * `printGrid` already renders as a blank cell - the same "" it uses for a
 * missing `--solution` letter, so no new empty-cell glyph is invented.
 *
 * Across slots are placed first, then down: a crossing letter the two
 * disagree on (never expected - both come from one grid, per the task's own
 * baked-in decision - but a corrupted or hand-edited run record could do it)
 * keeps the across letter and logs one warning rather than silently picking
 * whichever slot happened to be iterated last.
 */
function buildRunLetters(puzzle: Puzzle, perSlot: readonly PerSlotRecord[]): string[][] {
  const bySlotId = new Map(perSlot.map((rec) => [rec.slotId, rec] as const));
  const byCell = new Map<string, string>();
  let warnedDisagreement = false;

  const orderedSlots = [...puzzle.slots].sort((a, b) => {
    if (a.direction === b.direction) return 0;
    return a.direction === 'across' ? -1 : 1;
  });

  for (const slot of orderedSlots) {
    const record = bySlotId.get(slot.id);
    if (record === undefined || record.filled === null) continue;
    const filled = record.filled.toUpperCase();

    slot.cells.forEach(([row, col], i) => {
      const letter = filled[i] ?? '';
      const key = `${row}:${col}`;
      const existing = byCell.get(key);
      if (existing !== undefined && existing !== letter && slot.direction === 'down') {
        if (!warnedDisagreement) {
          warnedDisagreement = true;
          log.warn(
            `show --run: crossing disagreement at r${row}c${col} between across and down answers; keeping the across letter`,
          );
        }
        return;
      }
      byCell.set(key, letter);
    });
  }

  return Array.from({ length: puzzle.height }, (_unusedRowElement, row) =>
    Array.from({ length: puzzle.width }, (_unusedColElement, col) => byCell.get(`${row}:${col}`) ?? ''),
  );
}

/** The header line `--run` prepends: `Run <runId> (<timestamp>, profile <name>): letters <x.xxx> words <x.xxx> perfect <yes|no>`. */
function formatRunHeader(record: RunRecord): string {
  const letters = record.accuracy.letters.toFixed(3);
  const words = record.accuracy.words.toFixed(3);
  const perfect = record.accuracy.perfect ? 'yes' : 'no';
  return `Run ${record.runId} (${record.timestamp}, profile ${record.profile.name}): letters ${letters} words ${words} perfect ${perfect}`;
}

/**
 * T59: resolves `--run`'s value (`true` for "latest", a string for a run id
 * or a unique prefix) to the `RunRecord` to render, or throws the CliError
 * the task specifies. `findRun` does not know which puzzle it was asked
 * from (see its own doc comment), so the "run belongs to a different
 * puzzle" USAGE error - the one case that needs both ids - is checked here,
 * once `findRun` has already resolved a unique record.
 */
async function resolveRunRecord(id: string, runOpt: true | string, runsDir: string): Promise<RunRecord> {
  if (runOpt === true) {
    const record = await latestRun(runsDir, id);
    if (record === null) {
      throw notFoundError(`no run found for puzzle "${id}"`, `run \`xw solve ${id}\``);
    }
    return record;
  }

  const record = await findRun(runsDir, runOpt);
  if (record.puzzle.id !== id) {
    throw usageError(
      `run "${record.runId}" is a run of puzzle "${record.puzzle.id}", not "${id}"`,
    );
  }
  return record;
}

/**
 * T30/T59: prints the numbered grid (blocks as `#`, letters as `.` unless
 * `--solution` or `--run`) plus the across and down clue lists; `--run`
 * prepends one header line naming the run and its accuracy (see
 * `formatRunHeader`).
 *
 * Uses `loadPuzzleById` (never `readNormalised` directly) for the base
 * render, so the solution is only ever read into memory at all when
 * `--solution` is given; `readNormalised` is then used just for its
 * `solution` field. Unknown ids fail through `loadPuzzleById` -> the
 * library's own `notFoundError`, which this rethrows with a hint pointing at
 * `xw list`.
 *
 * `overrides` lets tests point directly at a fixture `puzzlesDir` and
 * `runsDir`; see `src/cli/list.ts` for the same `puzzlesDir` pattern.
 */
export async function showCommand(
  id: string,
  opts: ShowOptions,
  global: GlobalOptions,
  overrides?: ShowCommandOverrides,
): Promise<void> {
  const runOpt = opts.run;
  if (opts.solution && runOpt !== undefined && runOpt !== false) {
    throw usageError('--run cannot be combined with --solution');
  }

  const lib = overrides ?? (await resolveLibraryOptions(global));

  let puzzle: Puzzle;
  try {
    puzzle = await loadPuzzleById(id, lib);
  } catch (error) {
    if (isCliError(error) && error.code === ExitCode.NOT_FOUND) {
      throw notFoundError(`no puzzle found for id "${id}"`, 'run `xw list` to see available puzzles');
    }
    throw error;
  }

  let solution: string[][] | null = null;
  let header: string | null = null;
  if (opts.solution) {
    const file = await readNormalised(id, lib);
    solution = file.solution;
  } else if (runOpt !== undefined && runOpt !== false) {
    const runsDir = resolveShowRunsDir(overrides);
    const record = await resolveRunRecord(id, runOpt, runsDir);
    solution = buildRunLetters(puzzle, record.perSlot);
    header = formatRunHeader(record);
  }

  if (header !== null) console.log(header);
  printGrid(puzzle, solution);
  console.log('');
  printClueList(
    'Across',
    puzzle.slots.filter((s) => s.direction === 'across'),
  );
  console.log('');
  printClueList(
    'Down',
    puzzle.slots.filter((s) => s.direction === 'down'),
  );
}
