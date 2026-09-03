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
 * - The PUZ path's `unified.clues.across`/`unified.clues.down` are NOT
 *   trustworthy as-is: `dist/puz-*.mjs`'s `parseClues` assumes the file's
 *   flat clue-string section is pre-grouped "all across texts, then all down
 *   texts", but the real `.puz` spec interleaves them by number (across
 *   before down at a shared number). A spec-conformant file therefore gets
 *   every clue after the first mis-assigned by the package. `puzSourceClues`
 *   below reconstructs the true file order and re-zips it against this
 *   repo's own (already-verified-matching) numbering; see its own comment
 *   for the mechanism. Only `.puz` needs this - `.ipuz`/`.jpz` clues carry
 *   their own explicit numbers and are attributed correctly by the package.
 *
 * `parsedBy` is always `"@xwordly/xword-parser"`: the package parses all
 * three formats this adapter is registered for.
 */

import { parse as xwordlyParse } from '@xwordly/xword-parser';
import type { Cell as XwordlyCell, Puzzle as XwordlyPuzzle } from '@xwordly/xword-parser';

import { notFoundError } from '../../cli/exit.js';
import {
  assertNumberingMatches,
  buildSlots,
  computeNumbering,
  type Numbering,
  type SourceClue,
} from '../numbering.js';
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

/**
 * True when `bytes` starts with a standard AcrossLite `.puz` header: the
 * literal 11-byte magic string `"ACROSS&DOWN"` at offset 2 (checksum is the
 * first 2 bytes, magic immediately follows), matching every `.puz` this
 * adapter is ever handed (including a `.ipuz`/`.jpz` file misnamed `.puz`
 * would fail this check and fall through to the general path below, which is
 * the safer failure mode).
 */
function isPuzMagic(bytes: Buffer): boolean {
  return bytes.length >= 13 && bytes.subarray(2, 13).toString('latin1') === 'ACROSS&DOWN';
}

/**
 * `@xwordly/xword-parser`'s PUZ clue-string splitter (`dist/puz-*.mjs`,
 * `parseClues`) assumes the file's flat clue-string section is already
 * grouped as "every across text, in grid position order" followed by "every
 * down text, in grid position order" - it walks the same sorted-position
 * list twice (once filtering for across starts, once for down starts) and
 * pulls the next unconsumed string off the flat array each time. The real
 * AcrossLite `.puz` spec does not store clues that way: they are interleaved
 * by number, across before down at a shared number (1A,1D,2D,3A,3D,...), so
 * a spec-conformant file gets every clue after the first assigned to the
 * wrong slot.
 *
 * This is fixable without a bespoke `.puz` reader: `parseClues`'s two passes
 * only ever consume the flat array in file order and split it at a fixed
 * index (the across count) - they never reorder it - so concatenating the
 * package's own `across` and `down` arrays back together
 * (`[...across, ...down]`) exactly recovers the ORIGINAL file-order flat
 * clue-string list. Re-zipping that recovered list against this repo's own
 * `numbering.runs` - which `assertNumberingMatches` has already proven
 * matches the file's own numbering, and which is built in the identical
 * spec order (row-major by cell, across before down at a shared cell,
 * mirroring the PUZ format's own `assignClueNumbers`) - assigns every string
 * to the run it actually belongs to.
 */
function puzSourceClues(unified: XwordlyPuzzle, numbering: Numbering): SourceClue[] {
  const flatFileOrder = [...unified.clues.across, ...unified.clues.down].map((clue) => clue.text);
  const runsInFileOrder = numbering.runs;
  if (flatFileOrder.length !== runsInFileOrder.length) {
    throw notFoundError(
      `puz clue count ${flatFileOrder.length} does not match ${runsInFileOrder.length} numbered runs`,
    );
  }
  return runsInFileOrder.map((run, i) => ({
    number: run.number,
    direction: run.direction,
    text: flatFileOrder[i]!,
  }));
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

function toPuzzleWithSolution(
  unified: XwordlyPuzzle,
  ctx: XwordlyAdapterContext,
  bytes: Buffer,
): PuzzleWithSolution {
  const { blocks, solution, suppliedNumbers } = extractGrid(unified);

  // T7 (B19): the file's own numbering is only ever used for this mismatch
  // check; the numbering the solver uses is always recomputed below.
  const numbering = computeNumbering(blocks, { minRun: MIN_RUN });
  assertNumberingMatches(numbering, suppliedNumbers);

  // `.puz`'s clue-string section needs its own reconstruction (see
  // puzSourceClues's comment) because the package mis-splits it; `.ipuz`
  // and `.jpz` clues are already correctly attributed to across/down by the
  // package (each source clue carries its own explicit number).
  const sourceClues = isPuzMagic(bytes) ? puzSourceClues(unified, numbering) : sourceCluesFrom(unified);
  const slots = buildSlots(numbering, sourceClues, { minRun: MIN_RUN });
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
    return Promise.resolve(toPuzzleWithSolution(unified, ctx, bytes));
  },
};
