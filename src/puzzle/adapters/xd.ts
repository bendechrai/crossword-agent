import { notFoundError } from '../../cli/exit.js';
import { log } from '../../util/log.js';
import {
  assertNumberingMatches,
  buildSlots,
  computeNumbering,
  type Numbering,
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
 *   - every line matches `A1. text ~ ANSWER` -> a clue block (there are
 *     normally two, an Across block then a Down block; both merge into one
 *     clue list);
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
 */

const MIN_RUN = 2;

const CLUE_LINE_RE = /^([AD])(\d+)\.\s+(.*)$/;
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
  if (lines.every((l) => CLUE_LINE_RE.test(l))) return 'clues';
  if (lines.every((l) => GRID_CHAR_RE.test(l))) return 'grid';
  if (lines.every((l) => METADATA_LINE_RE.test(l))) return 'metadata';
  return 'unknown';
}

interface ParsedXd {
  title?: string;
  author?: string;
  date?: string;
  gridLines: string[];
  sourceClues: SourceClue[];
}

/** Parses the raw `.xd` text into metadata, grid lines and source clues. */
function parseXdText(text: string, origin: string): ParsedXd {
  const blocks = splitBlocks(text);

  const metadata: Partial<Record<'title' | 'author' | 'date' | 'editor', string>> = {};
  let gridLines: string[] | undefined;
  const sourceClues: SourceClue[] = [];

  for (const block of blocks) {
    const kind = classify(block);
    if (kind === 'metadata') {
      for (const line of block) {
        const match = METADATA_LINE_RE.exec(line);
        if (match === null) continue;
        const key = (match[1] ?? '').trim().toLowerCase();
        const value = (match[2] ?? '').trim();
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
      for (const line of block) {
        const match = CLUE_LINE_RE.exec(line);
        if (match === null) continue;
        const dirChar = match[1];
        const numberText = match[2];
        const rest = match[3] ?? '';
        if (dirChar === undefined || numberText === undefined) continue;
        const direction: Direction = dirChar === 'A' ? 'across' : 'down';
        const number = Number(numberText);

        // B42: strip everything from the ` ~ ` separator onward before the
        // clue text is stored, and before enumeration extraction - the
        // literal three-character substring, so a legitimate tilde in the
        // clue itself (not surrounded by exactly one space on each side)
        // is left untouched.
        const sepIndex = rest.indexOf(' ~ ');
        if (sepIndex === -1) {
          throw notFoundError(
            `.xd ${origin}: clue "${dirChar}${numberText}" has no " ~ " answer separator`,
          );
        }
        const clueText = rest.slice(0, sepIndex).trimEnd();
        sourceClues.push({ number, direction, text: clueText });
      }
    } else {
      log.warn(`.xd ${origin}: ignoring an unrecognised section (starts "${block[0] ?? ''}")`);
    }
  }

  if (gridLines === undefined) {
    throw notFoundError(`.xd ${origin}: no grid section found`);
  }

  const result: ParsedXd = { gridLines, sourceClues };
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
 * with `assertNumberingMatches` (B19). A file with a clue misnumbered
 * relative to the grid diverges at the first affected cell.
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

// Not `async`: everything here is synchronous (no file or network I/O), and
// an `async` function with no `await` is a lint error. The interface still
// wants a `Promise`, so the result is wrapped in one at the return below.
function parse(bytes: Buffer, ctx: PuzzleAdapterContext): Promise<PuzzleWithSolution> {
  const origin = ctx.origin ?? ctx.id;
  const text = bytes.toString('utf8');

  const parsed = parseXdText(text, origin);
  const { blocks, solution } = decodeGrid(parsed.gridLines, origin);

  const numbering = computeNumbering(blocks, { minRun: MIN_RUN });
  const supplied = suppliedNumbersFrom(numbering, parsed.sourceClues);
  assertNumberingMatches(numbering, supplied);

  const slots = buildSlots(numbering, parsed.sourceClues, { minRun: MIN_RUN });

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
