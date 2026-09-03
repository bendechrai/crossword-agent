/**
 * T24: `.puz`, `.ipuz` and `.jpz` through `@xwordly/xword-parser@1.1.0`.
 *
 * Package API actually used (verified by reading `dist/index.d.ts` and a
 * scratch parse of this task's own fixtures - the package's generic entry
 * point, not prose docs):
 *
 * - `parse(bytes, { filename })` auto-detects the format (content sniffing,
 *   boosted by the `filename` extension as a high-confidence hint) and
 *   returns one shared, already-validated `Puzzle` shape for all of iPUZ,
 *   PUZ, JPZ and XD: `{ title?, author?, date?, grid: { width, height,
 *   cells: Cell[][] }, clues: { across: Clue[], down: Clue[] } }` where
 *   `Cell = { solution?: string, number?: number, isBlack: boolean, ... }`
 *   and `Clue = { number: number, text: string }`. This is used instead of
 *   the per-format `parseIpuz`/`parsePuz`/`parseJpz` + `convert*ToUnified`
 *   pairs so one adapter body handles all three extensions this module owns,
 *   the same way `PuzzleAdapterContext` never tells `parse()` which format
 *   the bytes are.
 * - The package never validates `.puz` checksums (the header fields are read
 *   but not compared), so the hand-authored `.puz` fixture only needs a
 *   correct magic string and correct section lengths, not real checksums.
 * - An ipuz block cell's raw `solution` grid entry (conventionally `"#"`)
 *   still comes through as `cell.solution === "#"` on the unified `Cell`
 *   (the converter reads the raw solution grid by position, not the
 *   already-block-aware per-cell value) - `isBlack` is what actually marks a
 *   block, so this adapter always ignores `solution` on a black cell rather
 *   than trusting its content.
 * - ipuz clue keys must be the capitalised `"Across"`/`"Down"` - that is
 *   what the converter looks for; jpz `<clues><title>` text is matched
 *   case-insensitively for "across" and anything else is treated as down.
 * - Numbers on the unified `Cell`s come from the source format's own
 *   numbering (the PUZ path even recomputes one with the same across/down
 *   rule this repo's `numbering.ts` uses); B19 says to recompute regardless
 *   and use the source numbers only for the mismatch check, which is what
 *   this module does.
 *
 * `parsedBy` is always `"@xwordly/xword-parser"`: the package parses all
 * three formats this adapter is registered for.
 */

import { parse as xwordlyParse } from '@xwordly/xword-parser';
import type { Cell as XwordlyCell, Puzzle as XwordlyPuzzle } from '@xwordly/xword-parser';

import { notFoundError } from '../../cli/exit.js';
import { assertNumberingMatches, buildSlots, computeNumbering, type SourceClue } from '../numbering.js';
import type { Cell, PuzzleStyle, PuzzleWithSolution } from '../types.js';
import type { PuzzleAdapter, PuzzleAdapterContext } from './index.js';

/** Minimum run length for a slot number (B20); matches T7's default. */
const MIN_RUN = 2;

/** Unicode combining-mark range (U+0300-U+036F) stripped after NFD decomposition. */
const COMBINING_MARKS_RE = /[\u0300-\u036f]/g;

/**
 * `PuzzleAdapterContext` (frozen, owned by T0) has no `style` field, but this
 * task's decision text says style "comes from the caller (the source
 * adapter), defaulting to 'unknown'". We extend the context locally (an
 * addition, not an edit, to the frozen type) so a caller that knows the
 * puzzle's style - a future source adapter, or this module's own tests
 * standing in for one - can supply it. The frozen `loader.ts` never sets it
 * today, so a puzzle loaded through `xw solve <path>` still gets the
 * "unknown" default the decision describes; see the PR's deviations note.
 */
export interface XwordlyAdapterContext extends PuzzleAdapterContext {
  style?: PuzzleStyle;
}

function cellId(row: number, col: number): string {
  return `r${row}c${col}`;
}

/**
 * Uppercases and NFD-decomposes a raw solution letter, dropping combining
 * marks, so an accented source letter normalises to its plain ASCII form
 * before the A-Z check below (for example U+00C9, Latin capital E with
 * acute, normalises to plain "E").
 */
function normaliseSolutionLetter(raw: string): string {
  return raw.normalize('NFD').replace(COMBINING_MARKS_RE, '').toUpperCase();
}

interface GridExtract {
  blocks: boolean[][];
  solution: string[][];
  suppliedNumbers: (number | null)[][];
}

/**
 * Walks the unified grid once, deriving blocks, the uppercased A-Z solution
 * (block cells hold "", per B11/T16) and the source's own numbering (used
 * only for the B19 mismatch check). A cell whose normalised solution is not
 * exactly one A-Z letter is a load error naming the cell - rebus squares are
 * out of scope for v1 (a normalised length > 1) and get their own wording.
 */
function extractGrid(unified: XwordlyPuzzle): GridExtract {
  const { width, height, cells } = unified.grid;
  const blocks: boolean[][] = [];
  const solution: string[][] = [];
  const suppliedNumbers: (number | null)[][] = [];

  for (let row = 0; row < height; row++) {
    const cellRow: ReadonlyArray<XwordlyCell> = cells[row] ?? [];
    const blockRow: boolean[] = [];
    const solutionRow: string[] = [];
    const numberRow: (number | null)[] = [];

    for (let col = 0; col < width; col++) {
      const cell: XwordlyCell | undefined = cellRow[col];
      const isBlack = cell?.isBlack ?? true;
      blockRow.push(isBlack);
      numberRow.push(cell?.number ?? null);

      if (isBlack) {
        solutionRow.push('');
        continue;
      }

      const raw = cell?.solution;
      if (raw === undefined || raw.length === 0) {
        throw notFoundError(`missing solution letter at ${cellId(row, col)}`);
      }

      const normalised = normaliseSolutionLetter(raw);
      if (normalised.length > 1) {
        throw notFoundError(
          `rebus square at ${cellId(row, col)} is out of scope for v1: solution "${raw}"`,
        );
      }
      if (!/^[A-Z]$/.test(normalised)) {
        throw notFoundError(
          `solution letter "${raw}" at ${cellId(row, col)} is not A-Z after normalisation`,
        );
      }
      solutionRow.push(normalised);
    }

    blocks.push(blockRow);
    solution.push(solutionRow);
    suppliedNumbers.push(numberRow);
  }

  return { blocks, solution, suppliedNumbers };
}

function sourceCluesFrom(unified: XwordlyPuzzle): SourceClue[] {
  const across: SourceClue[] = unified.clues.across.map((clue) => ({
    number: clue.number,
    direction: 'across',
    text: clue.text,
  }));
  const down: SourceClue[] = unified.clues.down.map((clue) => ({
    number: clue.number,
    direction: 'down',
    text: clue.text,
  }));
  return [...across, ...down];
}

function buildCells(
  blocks: ReadonlyArray<ReadonlyArray<boolean>>,
  numbers: ReadonlyArray<ReadonlyArray<number | null>>,
): Cell[][] {
  return blocks.map((row, rowIdx) =>
    row.map((block, colIdx) => {
      const number = numbers[rowIdx]?.[colIdx] ?? null;
      return {
        row: rowIdx,
        col: colIdx,
        block,
        ...(number === null ? {} : { number }),
      };
    }),
  );
}

function toPuzzleWithSolution(unified: XwordlyPuzzle, ctx: XwordlyAdapterContext): PuzzleWithSolution {
  const { blocks, solution, suppliedNumbers } = extractGrid(unified);

  // T7 (B19): the file's own numbering is only ever used for this mismatch
  // check; the numbering the solver uses is always recomputed below.
  const numbering = computeNumbering(blocks, { minRun: MIN_RUN });
  assertNumberingMatches(numbering, suppliedNumbers);

  const slots = buildSlots(numbering, sourceCluesFrom(unified), { minRun: MIN_RUN });
  const cells = buildCells(blocks, numbering.numbers);

  const title = ctx.title ?? unified.title;
  const author = unified.author;
  const date = ctx.date ?? unified.date;

  return {
    id: ctx.id,
    source: ctx.source,
    style: ctx.style ?? 'unknown',
    width: unified.grid.width,
    height: unified.grid.height,
    cells,
    slots,
    parsedBy: '@xwordly/xword-parser',
    solution,
    ...(date === undefined ? {} : { date }),
    ...(title === undefined ? {} : { title }),
    ...(author === undefined ? {} : { author }),
  };
}

export const xwordlyAdapter: PuzzleAdapter = {
  name: '@xwordly/xword-parser',
  extensions: ['puz', 'ipuz', 'jpz'],
  // The underlying package is fully synchronous; no `await` inside this
  // function, so it stays a plain function returning `Promise.resolve(...)`
  // rather than `async` (which `@typescript-eslint/require-await` flags).
  parse(bytes: Buffer, ctx: XwordlyAdapterContext): Promise<PuzzleWithSolution> {
    let unified: XwordlyPuzzle;
    try {
      unified = xwordlyParse(bytes, ctx.origin === undefined ? {} : { filename: ctx.origin });
    } catch (err) {
      throw notFoundError(
        `failed to parse puzzle "${ctx.origin ?? ctx.id}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return Promise.resolve(toPuzzleWithSolution(unified, ctx));
  },
};
