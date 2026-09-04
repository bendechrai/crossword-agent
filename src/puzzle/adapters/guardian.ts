import { notFoundError } from '../../cli/exit.js';
import { warnOnce } from '../../util/log.js';
import { normaliseEnumeration } from '../enumeration.js';
import {
  assertNumberingMatches,
  buildSlots,
  computeNumbering,
  type SourceClue,
} from '../numbering.js';
import type { Cell, Direction, PuzzleStyle, PuzzleWithSolution, Slot } from '../types.js';
import type { PuzzleAdapter, PuzzleAdapterContext } from './index.js';

/**
 * T26: converts a Guardian crossword JSON payload (`crossword.entries[]`)
 * into a `PuzzleWithSolution` with `parsedBy: 'guardian-json'` (B17).
 *
 * The shape mirrored here (per the task text) is:
 *
 * ```
 * {
 *   "crossword": {
 *     "entries": [
 *       {
 *         "id": "1-across",
 *         "number": 1,
 *         "direction": "across" | "down",
 *         "position": { "x": <col>, "y": <row> },
 *         "length": 5,
 *         "clue": "...",
 *         "solution": "HELLO",
 *         "separatorLocations": { ",": [3] }
 *       },
 *       ...
 *     ],
 *     // optional; when absent the grid extent is derived from the entries
 *     "dimensions": { "cols": 7, "rows": 7 }
 *   }
 * }
 * ```
 *
 * `position` uses Guardian's `{x, y}` (col, row) convention. It is converted
 * to our `[row, col]` convention immediately, at this boundary, and never
 * carried further inward (B18).
 */

export interface GuardianPosition {
  x: number;
  y: number;
}

export interface GuardianEntry {
  id: string;
  number: number;
  direction: Direction;
  position: GuardianPosition;
  length: number;
  clue: string;
  solution: string;
  /** Separator character -> 0-based character offsets it falls after. */
  separatorLocations?: Record<string, number[]>;
}

export interface GuardianDimensions {
  cols: number;
  rows: number;
}

export interface GuardianCrossword {
  entries: GuardianEntry[];
  /** Optional; derived from the entries' extents when absent. */
  dimensions?: GuardianDimensions;
}

export interface GuardianPayload {
  crossword: GuardianCrossword;
}

export interface GuardianParseOptions {
  /**
   * `"cryptic"` for cryptic|prize|quiptic|everyman|weekend, `"quick"` for
   * quick|speedy - computed by the caller (the Guardian source adapter, T28)
   * from the series, never guessed here from the payload.
   */
  style: PuzzleStyle;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertGuardianPayload(value: unknown, origin: string | undefined): GuardianPayload {
  const name = origin ?? 'guardian payload';
  if (!isRecord(value) || !isRecord(value['crossword'])) {
    throw notFoundError(`${name}: expected a "crossword" object at the top level`);
  }
  const entries = value['crossword']['entries'];
  if (!Array.isArray(entries)) {
    throw notFoundError(`${name}: expected "crossword.entries" to be an array`);
  }
  return value as unknown as GuardianPayload;
}

/**
 * Derives the grid extent from `crossword.dimensions` when present, else
 * from the furthest cell any entry reaches.
 */
function resolveDimensions(crossword: GuardianCrossword): { width: number; height: number } {
  if (crossword.dimensions !== undefined) {
    return { width: crossword.dimensions.cols, height: crossword.dimensions.rows };
  }
  let maxRow = 0;
  let maxCol = 0;
  for (const entry of crossword.entries) {
    const endRow = entry.direction === 'down' ? entry.position.y + entry.length - 1 : entry.position.y;
    const endCol = entry.direction === 'across' ? entry.position.x + entry.length - 1 : entry.position.x;
    maxRow = Math.max(maxRow, endRow);
    maxCol = Math.max(maxCol, endCol);
  }
  return { width: maxCol + 1, height: maxRow + 1 };
}

/**
 * Builds the `(3,4)`-style enumeration implied by `separatorLocations`
 * (B21), or `undefined` when there are no separators to derive one from.
 * Guards against handing `normaliseEnumeration` an empty length list, which
 * would otherwise produce the meaningless `"()"` (B21/T7 note).
 */
function enumerationFromSeparators(entry: GuardianEntry): string | undefined {
  const positions = new Set<number>();
  if (entry.separatorLocations !== undefined) {
    for (const offsets of Object.values(entry.separatorLocations)) {
      for (const offset of offsets) positions.add(offset);
    }
  }
  if (positions.size === 0) return undefined;

  const sorted = [...positions].sort((a, b) => a - b);
  const lengths: number[] = [];
  let previous = 0;
  for (const position of sorted) {
    lengths.push(position - previous);
    previous = position;
  }
  lengths.push(entry.length - previous);

  if (lengths.length === 0) return undefined;
  return normaliseEnumeration(lengths);
}

function buildCells(blocks: boolean[][], numbers: (number | null)[][]): Cell[][] {
  return blocks.map((rowBlocks, row) =>
    rowBlocks.map((block, col) => {
      const number = numbers[row]?.[col] ?? null;
      return {
        row,
        col,
        block,
        ...(number === null ? {} : { number }),
      };
    }),
  );
}

/**
 * Reconciles each built slot's enumeration against `separatorLocations`:
 * when the clue text already carries a trailing group, that wins (B21
 * decision); a disagreement is warned once. When the clue has none, the
 * separator-derived value (if any) is used.
 */
function applySeparatorEnumeration(
  slots: Slot[],
  entriesByKey: Map<string, GuardianEntry>,
  puzzleId: string,
): Slot[] {
  return slots.map((slot) => {
    const entry = entriesByKey.get(`${slot.number}${slot.direction}`);
    if (entry === undefined) return slot;

    const separatorEnumeration = enumerationFromSeparators(entry);

    if (slot.enumeration !== undefined) {
      if (separatorEnumeration !== undefined && separatorEnumeration !== slot.enumeration) {
        warnOnce(
          `guardian-enumeration-mismatch:${puzzleId}:${entry.id}`,
          `guardian entry "${entry.id}": clue enumeration ${slot.enumeration} disagrees with ` +
            `separatorLocations-derived ${separatorEnumeration}; keeping the clue's value`,
        );
      }
      return slot;
    }

    if (separatorEnumeration !== undefined) {
      return { ...slot, enumeration: separatorEnumeration };
    }
    return slot;
  });
}

/**
 * Converts an already-parsed Guardian payload into a `PuzzleWithSolution`.
 * Exported separately from the `PuzzleAdapter.parse` entry point so a
 * caller that already knows the puzzle's style (the Guardian source
 * adapter, T28, from its series) can pass it directly instead of relying
 * on the extension-dispatch default of `"unknown"` (out of scope here:
 * series-to-style mapping is T28's).
 */
export function parseGuardianPayload(
  payload: unknown,
  ctx: PuzzleAdapterContext,
  opts: GuardianParseOptions,
): PuzzleWithSolution {
  const guardianPayload = assertGuardianPayload(payload, ctx.origin);
  const entries = guardianPayload.crossword.entries;
  const { width, height } = resolveDimensions(guardianPayload.crossword);

  const blocks: boolean[][] = Array.from({ length: height }, () => new Array<boolean>(width).fill(true));
  const letters: string[][] = Array.from({ length: height }, () => new Array<string>(width).fill(''));
  const supplied: (number | null)[][] = Array.from({ length: height }, () =>
    new Array<number | null>(width).fill(null),
  );

  for (const entry of entries) {
    if (entry.solution.length !== entry.length) {
      throw notFoundError(
        `guardian entry "${entry.id}": solution length ${entry.solution.length} does not match ` +
          `declared length ${entry.length}`,
      );
    }

    const startRow = entry.position.y;
    const startCol = entry.position.x;

    for (let i = 0; i < entry.length; i++) {
      const row = entry.direction === 'down' ? startRow + i : startRow;
      const col = entry.direction === 'across' ? startCol + i : startCol;
      const blockRow = blocks[row];
      if (blockRow !== undefined) blockRow[col] = false;
      const letterRow = letters[row];
      const letter = entry.solution[i];
      if (letterRow !== undefined && letter !== undefined) letterRow[col] = letter.toUpperCase();
    }

    const suppliedRow = supplied[startRow];
    if (suppliedRow !== undefined) suppliedRow[startCol] = entry.number;
  }

  const numbering = computeNumbering(blocks, { minRun: 2 });
  assertNumberingMatches(numbering, supplied);

  const sourceClues: SourceClue[] = entries.map(
    (entry): SourceClue => ({
      number: entry.number,
      direction: entry.direction,
      text: entry.clue,
    }),
  );
  const rawSlots = buildSlots(numbering, sourceClues, { minRun: 2 });

  const entriesByKey = new Map<string, GuardianEntry>();
  for (const entry of entries) entriesByKey.set(`${entry.number}${entry.direction}`, entry);

  const slots = applySeparatorEnumeration(rawSlots, entriesByKey, ctx.id);
  const cells = buildCells(blocks, numbering.numbers);

  return {
    id: ctx.id,
    source: ctx.source,
    ...(ctx.date !== undefined ? { date: ctx.date } : {}),
    ...(ctx.title !== undefined ? { title: ctx.title } : {}),
    style: opts.style,
    width,
    height,
    cells,
    slots,
    parsedBy: 'guardian-json',
    solution: letters,
  };
}

export const guardianAdapter: PuzzleAdapter = {
  name: 'guardian-json',
  extensions: ['json'],
  parse(bytes, ctx) {
    const payload: unknown = JSON.parse(bytes.toString('utf8'));
    // The extension-dispatch entry point (a bare `.json` file, e.g.
    // `xw solve <path>` or `xw fetch`, which routes every source through
    // src/puzzle/loader.ts rather than SourceAdapter.normalise) has no
    // series of its own to map to a style, so it honours `ctx.style` when
    // the caller already resolved one (T60: `xw fetch` derives it from the
    // Guardian source's series-bearing ref) and falls back to "unknown"
    // (T24 precedent) otherwise. A caller that both knows the series and
    // wants to skip the loader entirely can still call
    // `parseGuardianPayload` directly with the resolved style.
    return Promise.resolve(parseGuardianPayload(payload, ctx, { style: ctx.style ?? 'unknown' }));
  },
};
