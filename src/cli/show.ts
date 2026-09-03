import { loadConfig } from '../config.js';
import { loadPuzzleById, readNormalised, type LibraryOptions } from '../puzzle/library.js';
import type { Puzzle, Slot } from '../puzzle/types.js';
import { resolvePuzzlesDir } from '../util/fs.js';
import { ExitCode, isCliError, notFoundError } from './exit.js';
import type { GlobalOptions, ShowOptions } from './options.js';

/** Same precedence resolution as `list` (see src/cli/list.ts for the rationale). */
async function resolveLibraryOptions(global: GlobalOptions): Promise<LibraryOptions> {
  const { config } = await loadConfig({ path: global.config });
  return { puzzlesDir: resolvePuzzlesDir({ config: config.puzzlesDir }) };
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
 * T30: prints the numbered grid (blocks as `#`, letters as `.` unless
 * `--solution`) plus the across and down clue lists.
 *
 * Uses `loadPuzzleById` (never `readNormalised` directly) for the base
 * render, so the solution is only ever read into memory at all when
 * `--solution` is given; `readNormalised` is then used just for its
 * `solution` field. Unknown ids fail through `loadPuzzleById` -> the
 * library's own `notFoundError`, which this rethrows with a hint pointing at
 * `xw list`.
 *
 * `libraryOptions` lets tests point directly at a fixture `puzzlesDir`; see
 * `src/cli/list.ts` for the same pattern.
 */
export async function showCommand(
  id: string,
  opts: ShowOptions,
  global: GlobalOptions,
  libraryOptions?: LibraryOptions,
): Promise<void> {
  const lib = libraryOptions ?? (await resolveLibraryOptions(global));

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
  if (opts.solution) {
    const file = await readNormalised(id, lib);
    solution = file.solution;
  }

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
