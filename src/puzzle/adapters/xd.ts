import { notFoundError } from '../../cli/exit.js';
import { log } from '../../util/log.js';
import {
  assertNumberingMatches,
  buildSlots,
  computeNumbering,
  type Numbering,
  type RunSpec,
  type SourceClue,
} from '../numbering.js';
import type { Cell, Direction, PuzzleWithSolution } from '../types.js';
import type { PuzzleAdapter, PuzzleAdapterContext } from './index.js';

/**
 * T25: the `.xd` text format (Saul Pwanson's spec,
 * github.com/century-arcade/xd/blob/master/doc/xd-format.md).
 *
 * Implementation choice: a hand-written line parser rather than the
 * `xd-crossword-tools` package. The format is a small, precisely specified,
 * blank-line-delimited sequence of sections - metadata as `Key: Value`
 * pairs, a grid of letters and block characters, and clue lines of the shape
 * `A1. Clue text ~ ANSWER` - and the whole parser below (block splitting,
 * section classification, grid decoding, clue-line decoding) is well under
 * 150 lines. Pulling in a general-purpose corpus-conversion library and
 * adapting its output shape to `PuzzleWithSolution` would be more code to
 * read and trust for a format this regular. `parsedBy` is therefore
 * `'xd-hand'`, a value pre-authorised for this task as a one-line addition
 * to the `ParsedBy` union in `src/puzzle/types.ts` (see that file).
 *
 * Section layout (B19/B21/B42): each block of non-blank lines, separated by
 * one or more blank lines, is classified by its own shape (not by position):
 *   - any line of the shape `A1.`/`D12.` makes the whole block a clue block
 *     (there are normally two, an Across block then a Down block; both merge
 *     into one clue list). Classification is deliberately "any line" rather
 *     than "every line": under "every line" a single malformed clue line
 *     demoted the entire block to "unknown", which dropped every clue in it
 *     with nothing but a generic warning. One clue-shaped line is a strong
 *     enough signal, and any line in the block that is then not a well-formed
 *     clue is a load error naming that line;
 *   - every line is composed only of `[A-Za-z#.]` -> the grid. Per the xd
 *     spec, `#` is a block and a letter is a solution cell; `.` denotes an
 *     *empty* (unfilled) cell, which this loader does not support since it
 *     always produces a complete `PuzzleWithSolution` - a `.` in the grid is
 *     therefore a load error naming the cell, not silently treated as a
 *     block;
 *   - every line matches `Key: Value` -> metadata. `.xd` has no distinct
 *     "Notes" header; a free-text notes block is metadata-shaped only when
 *     it happens to look like `Key: Value` lines (in which case its keys are
 *     simply not among the four recognised ones and are dropped, same
 *     end-state as being ignored), otherwise it falls through to "unknown"
 *     and is ignored with a warning, exactly as B42's decision text says.
 *   - anything else -> an unrecognised section: ignored, with one warning.
 *
 * Nothing the file states about its own numbering, clue set or answers is
 * accepted without a check (B19): see `validateAgainstGrid` below for the
 * three checks and what each one catches.
 */

const MIN_RUN = 2;

/** The literal answer separator on a clue line (B42). */
const SEPARATOR = ' ~ ';

/**
 * A clue line. The text after `A1.` is deliberately captured with at most one
 * separating space consumed (`[ \t]?`, not `\s+`), so `A1.  ~ ANSWER` - a
 * clue with no visible text - still leaves the ` ~ ` separator in the
 * captured remainder instead of having its leading space eaten and looking
 * like a line with no separator at all.
 */
const CLUE_LINE_RE = /^([AD])(\d+)\.[ \t]?(.*)$/;
/** The shape that makes a whole block a clue block (see the comment above). */
const CLUE_PREFIX_RE = /^[AD]\d+\./;
// `#` is a block, a letter is a solution cell, and `.` is a spec-legal
// "empty cell" that decodeGrid rejects (see the section-layout comment
// above) - it is included here so a grid line containing one is still
// classified as a grid block and gets that specific error, rather than
// falling through to "unrecognised section".
const GRID_CHAR_RE = /^[A-Za-z#.]+$/;
const METADATA_LINE_RE = /^([A-Za-z][A-Za-z0-9 _-]*):\s*(.*)$/;

/**
 * Metadata keys (case-insensitive) that map to a `Puzzle` field. `editor` is
 * listed in the task's decision text as mapping to a `Puzzle` field, but the
 * (frozen) `Puzzle` interface has no `editor` field to put it in - it is
 * recognised (so it is never mistaken for an "unknown" key) and then simply
 * has nowhere to go. See the deviations note in the PR.
 */
const METADATA_KEYS = new Set(['title', 'author', 'date', 'editor']);

type SectionKind = 'metadata' | 'grid' | 'clues' | 'unknown';

/**
 * One clue line as the file states it: the T7 `SourceClue` that goes on to
 * `buildSlots`, plus the two things the file also states and that are checked
 * rather than trusted - the answer the ` ~ ` separator introduced, and the
 * `A1`-style label used in error messages.
 */
interface XdClue {
  clue: SourceClue;
  answer: string;
  label: string;
}

/** Map key for a (number, direction) pair; matches `buildSlots`'s own key. */
function keyOf(number: number, direction: Direction): string {
  return `${String(number)}${direction}`;
}

/**
 * `A1` / `D12`: the label a `.xd` clue line carries. Error messages from this
 * adapter are about lines in a `.xd` file, so they use the file's own
 * notation rather than the `1A` slot-id form used elsewhere - it is what a
 * reader will grep the file for.
 */
function labelOf(number: number, direction: Direction): string {
  return `${direction === 'across' ? 'A' : 'D'}${String(number)}`;
}

/** Splits `text` into blocks of consecutive non-blank lines. */
function splitBlocks(text: string): string[][] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      if (current.length > 0) blocks.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

function classify(lines: readonly string[]): SectionKind {
  if (lines.some((l) => CLUE_PREFIX_RE.test(l))) return 'clues';
  if (lines.every((l) => GRID_CHAR_RE.test(l))) return 'grid';
  if (lines.every((l) => METADATA_LINE_RE.test(l))) return 'metadata';
  return 'unknown';
}

/**
 * Decodes one clue line. Everything from the *first* ` ~ ` onward is stripped
 * before the clue text is stored and before enumeration extraction (B42), so
 * an answer can never reach `Slot.clue`; the answer itself is read from after
 * the *last* ` ~ `, so a clue that itself contains the separator still yields
 * the real answer for the grid cross-check below (its visible text is
 * truncated at the first separator, which is what B42 asks for).
 */
function parseClueLine(line: string, origin: string): XdClue {
  const match = CLUE_LINE_RE.exec(line);
  if (match === null) {
    throw notFoundError(
      `.xd ${origin}: clue line is not of the form "A1. Clue text ~ ANSWER": "${line}"`,
    );
  }
  const [, dirChar = '', numberText = '', rest = ''] = match;
  const direction: Direction = dirChar === 'A' ? 'across' : 'down';
  const number = Number(numberText);
  const label = labelOf(number, direction);

  const firstSep = rest.indexOf(SEPARATOR);
  if (firstSep === -1) {
    throw notFoundError(`.xd ${origin}: clue ${label} has no "${SEPARATOR}" answer separator`);
  }
  const lastSep = rest.lastIndexOf(SEPARATOR);
  const text = rest.slice(0, firstSep).trim();
  const answer = rest.slice(lastSep + SEPARATOR.length).trim();

  return { clue: { number, direction, text }, answer, label };
}

interface ParsedXd {
  title?: string;
  author?: string;
  date?: string;
  gridLines: string[];
  clues: XdClue[];
}

/** Parses the raw `.xd` text into metadata, grid lines and clue lines. */
function parseXdText(text: string, origin: string): ParsedXd {
  const blocks = splitBlocks(text);

  const metadata: Partial<Record<'title' | 'author' | 'date' | 'editor', string>> = {};
  let gridLines: string[] | undefined;
  const clues: XdClue[] = [];

  for (const block of blocks) {
    const kind = classify(block);
    if (kind === 'metadata') {
      for (const line of block) {
        // Non-null by construction: `classify` returned 'metadata' only
        // because every line in the block matched this same expression.
        const match = METADATA_LINE_RE.exec(line);
        const key = (match?.[1] ?? '').trim().toLowerCase();
        const value = (match?.[2] ?? '').trim();
        if (METADATA_KEYS.has(key)) {
          metadata[key as 'title' | 'author' | 'date' | 'editor'] = value;
        }
        // Any other key is dropped (acceptance 5): not among the four
        // recognised metadata fields, so there is nowhere for it to go.
      }
    } else if (kind === 'grid') {
      if (gridLines === undefined) {
        gridLines = block;
      } else {
        log.warn(`.xd ${origin}: ignoring a second grid-shaped section`);
      }
    } else if (kind === 'clues') {
      for (const line of block) clues.push(parseClueLine(line, origin));
    } else {
      log.warn(`.xd ${origin}: ignoring an unrecognised section (starts "${block[0] ?? ''}")`);
    }
  }

  if (gridLines === undefined) {
    throw notFoundError(`.xd ${origin}: no grid section found`);
  }

  const result: ParsedXd = { gridLines, clues };
  if (metadata.title !== undefined) result.title = metadata.title;
  if (metadata.author !== undefined) result.author = metadata.author;
  if (metadata.date !== undefined) result.date = metadata.date;
  return result;
}

/** Decodes grid lines (`#` = block, a letter = that solution letter) into blocks and a solution grid. */
function decodeGrid(
  gridLines: readonly string[],
  origin: string,
): { blocks: boolean[][]; solution: string[][] } {
  const width = gridLines[0]?.length ?? 0;
  const blocks: boolean[][] = [];
  const solution: string[][] = [];

  for (let row = 0; row < gridLines.length; row++) {
    const line = gridLines[row] ?? '';
    if (line.length !== width) {
      throw notFoundError(
        `.xd ${origin}: grid row ${row} has length ${line.length}, expected ${width}`,
      );
    }
    const blockRow: boolean[] = [];
    const solutionRow: string[] = [];
    for (let col = 0; col < line.length; col++) {
      const ch = line[col] ?? '';
      if (ch === '#') {
        blockRow.push(true);
        solutionRow.push('');
        continue;
      }
      if (ch === '.') {
        throw notFoundError(
          `.xd ${origin}: unfilled cell (.) at r${row}c${col} is not supported; this loader requires a complete solution grid`,
        );
      }
      const upper = ch.toUpperCase();
      if (!/^[A-Z]$/.test(upper)) {
        throw notFoundError(`.xd ${origin}: invalid grid character at r${row}c${col}`);
      }
      blockRow.push(false);
      solutionRow.push(upper);
    }
    blocks.push(blockRow);
    solution.push(solutionRow);
  }

  return { blocks, solution };
}

/**
 * `.xd` carries no separate numbers grid, only the number attached to each
 * clue line. The set of distinct numbers the file's clues reference, taken
 * in ascending order, is what the file believes the sequence 1, 2, 3, ... to
 * be; zipping that against the cells the *computed* numbering assigned in
 * the same order (which is, by construction, exactly 1, 2, 3, ... in
 * row-major scan order) reconstructs an independent numbers grid to check
 * with `assertNumberingMatches` (B19).
 *
 * This is only the first half of the B19 check, and on its own it is weak:
 * it compares *sets*, so a clue misnumbered to a value that some other clue
 * still states (`A3` -> `A4` when `D4` exists) leaves the set intact and
 * slips through. `assertCluesMatchRuns` closes that hole.
 */
function suppliedNumbersFrom(
  numbering: Numbering,
  sourceClues: readonly SourceClue[],
): (number | null)[][] {
  const height = numbering.numbers.length;
  const width = numbering.numbers[0]?.length ?? 0;
  const supplied: (number | null)[][] = [];
  for (let r = 0; r < height; r++) supplied.push(new Array<number | null>(width).fill(null));

  const cellsInOrder: Array<[number, number]> = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if ((numbering.numbers[r]?.[c] ?? null) !== null) cellsInOrder.push([r, c]);
    }
  }

  const stated = Array.from(new Set(sourceClues.map((c) => c.number))).sort((a, b) => a - b);

  for (let i = 0; i < cellsInOrder.length; i++) {
    const cell = cellsInOrder[i];
    const number = stated[i];
    if (cell === undefined || number === undefined) continue;
    const [r, c] = cell;
    const row = supplied[r];
    if (row !== undefined) row[c] = number;
  }

  return supplied;
}

/** First cell (row-major) carrying each computed number, for error messages. */
function cellsByNumber(numbering: Numbering): Map<number, readonly [number, number]> {
  const cells = new Map<number, readonly [number, number]>();
  for (let row = 0; row < numbering.numbers.length; row++) {
    const numberRow = numbering.numbers[row] ?? [];
    for (let col = 0; col < numberRow.length; col++) {
      const number = numberRow[col] ?? null;
      if (number !== null && !cells.has(number)) cells.set(number, [row, col]);
    }
  }
  return cells;
}

/**
 * B19, second half: every clue the file states must name a run that actually
 * exists in the recomputed grid.
 *
 * Without this, `buildSlots` silently ignores a clue with no matching run
 * (B20 - it only walks runs), so a misnumbered clue simply vanishes: the
 * puzzle loads one slot short, with no error and no warning, whenever the
 * bad number happens to be stated elsewhere in the file too and so survives
 * the set comparison in `suppliedNumbersFrom`. Runs the clues *do* name are
 * returned so the answer cross-check below does not have to re-index them.
 */
function assertCluesMatchRuns(
  numbering: Numbering,
  clues: readonly XdClue[],
  origin: string,
): Map<string, RunSpec> {
  const runByKey = new Map<string, RunSpec>();
  for (const run of numbering.runs) runByKey.set(keyOf(run.number, run.direction), run);
  const numberedCells = cellsByNumber(numbering);

  const seen = new Set<string>();
  for (const { clue, label } of clues) {
    const key = keyOf(clue.number, clue.direction);
    if (seen.has(key)) {
      // Two clue lines for the same slot: `buildSlots` keeps whichever came
      // last, so the other one would be dropped without a word.
      throw notFoundError(`.xd ${origin}: clue ${label} is stated more than once`);
    }
    seen.add(key);
    if (runByKey.has(key)) continue;

    const cell = numberedCells.get(clue.number);
    const where =
      cell === undefined
        ? `no cell in the grid is numbered ${String(clue.number)}`
        : `the cell numbered ${String(clue.number)} is r${cell[0]}c${cell[1]}, which starts no ${clue.direction} run`;
    throw notFoundError(`.xd ${origin}: clue ${label} matches no run in the grid: ${where}`);
  }

  return runByKey;
}

/** Answer text reduced to the alphabet the solution grid can hold. */
function normaliseAnswer(answer: string): string {
  return answer.toUpperCase().replace(/[^A-Z]/g, '');
}

/**
 * The answer after ` ~ ` is stripped from the clue text (B42) but it is not
 * therefore worthless: it is a second, independent statement of what the grid
 * says, and a file whose two statements disagree is corrupt. Checking it
 * costs nothing and catches an off-by-one grid, a clue attached to the wrong
 * run, and a truncated answer column - all of which would otherwise load
 * silently, because nothing else in this adapter ever reads the answer.
 */
function assertAnswersMatchGrid(
  runByKey: ReadonlyMap<string, RunSpec>,
  clues: readonly XdClue[],
  solution: readonly (readonly string[])[],
  origin: string,
): void {
  for (const { clue, answer, label } of clues) {
    const run = runByKey.get(keyOf(clue.number, clue.direction));
    // Unreachable: assertCluesMatchRuns has already rejected any clue with
    // no run. Kept as a type narrowing rather than a non-null assertion.
    if (run === undefined) continue;

    const stated = normaliseAnswer(answer);
    if (stated.length === 0) continue;

    const inGrid = run.cells.map(([row, col]) => solution[row]?.[col] ?? '').join('');
    if (stated === inGrid) continue;

    if (stated.length !== inGrid.length) {
      throw notFoundError(
        `.xd ${origin}: clue ${label} states a ${String(stated.length)}-letter answer but its ` +
          `run at r${run.row}c${run.col} is ${String(inGrid.length)} cells long`,
      );
    }
    let index = 0;
    while (index < stated.length && stated[index] === inGrid[index]) index++;
    const cell = run.cells[index] ?? [run.row, run.col];
    throw notFoundError(
      `.xd ${origin}: clue ${label}'s answer disagrees with the grid at r${cell[0]}c${cell[1]}: ` +
        `the grid has "${inGrid[index] ?? ''}", the answer has "${stated[index] ?? ''}"`,
    );
  }
}

/**
 * A run with no clue is not an error - B20 says such a run is simply not a
 * slot - but it is a silent hole in the puzzle, so name the runs that got
 * dropped once rather than leaving the caller to count slots.
 */
function warnUncluedRuns(numbering: Numbering, clues: readonly XdClue[], origin: string): void {
  const clued = new Set(clues.map(({ clue }) => keyOf(clue.number, clue.direction)));
  const unclued = numbering.runs.filter((run) => !clued.has(keyOf(run.number, run.direction)));
  if (unclued.length === 0) return;
  const names = unclued.map((run) => labelOf(run.number, run.direction)).join(', ');
  log.warn(`.xd ${origin}: ${String(unclued.length)} run(s) have no clue and are not slots: ${names}`);
}

/**
 * Every check the file's own claims are put through, in the order that gives
 * the most specific message first (B19): the numbering zip names the first
 * divergent *cell*, so it runs before the per-clue checks, which name a
 * clue.
 */
function validateAgainstGrid(
  numbering: Numbering,
  parsed: ParsedXd,
  solution: readonly (readonly string[])[],
  origin: string,
): void {
  const sourceClues = parsed.clues.map(({ clue }) => clue);
  assertNumberingMatches(numbering, suppliedNumbersFrom(numbering, sourceClues));
  const runByKey = assertCluesMatchRuns(numbering, parsed.clues, origin);
  assertAnswersMatchGrid(runByKey, parsed.clues, solution, origin);
  warnUncluedRuns(numbering, parsed.clues, origin);
}

// Not `async`: everything here is synchronous (no file or network I/O), and
// an `async` function with no `await` is a lint error. The interface still
// wants a `Promise`, so the result is wrapped in one at the return below.
function parse(bytes: Buffer, ctx: PuzzleAdapterContext): Promise<PuzzleWithSolution> {
  const origin = ctx.origin ?? ctx.id;
  const text = bytes.toString('utf8');

  const parsed = parseXdText(text, origin);
  const { blocks, solution } = decodeGrid(parsed.gridLines, origin);

  const numbering = computeNumbering(blocks, { minRun: MIN_RUN });
  validateAgainstGrid(numbering, parsed, solution, origin);

  const slots = buildSlots(
    numbering,
    parsed.clues.map(({ clue }) => clue),
    { minRun: MIN_RUN },
  );

  const height = blocks.length;
  const width = blocks[0]?.length ?? 0;
  const cells: Cell[][] = [];
  for (let row = 0; row < height; row++) {
    const rowCells: Cell[] = [];
    for (let col = 0; col < width; col++) {
      const block = blocks[row]?.[col] ?? false;
      const number = numbering.numbers[row]?.[col] ?? null;
      rowCells.push(number === null ? { row, col, block } : { row, col, block, number });
    }
    cells.push(rowCells);
  }

  const puzzle: PuzzleWithSolution = {
    id: ctx.id,
    source: ctx.source,
    // The xd corpus this loader reads (see docs/crossword-sources.md) is the
    // pre-1965 NYT puzzles used for the licence-clean fixtures (A3); `.xd`
    // carries no format-level style signal of its own (only Title/Author/
    // Date/Editor metadata map to Puzzle fields), so American is the correct
    // fixed default here rather than a guess.
    style: 'american',
    width,
    height,
    cells,
    slots,
    parsedBy: 'xd-hand',
    solution,
  };
  const title = parsed.title ?? ctx.title;
  if (title !== undefined) puzzle.title = title;
  if (parsed.author !== undefined) puzzle.author = parsed.author;
  const date = parsed.date ?? ctx.date;
  if (date !== undefined) puzzle.date = date;

  return Promise.resolve(puzzle);
}

export const xdAdapter: PuzzleAdapter = {
  name: 'xd-hand',
  extensions: ['xd'],
  parse,
};
