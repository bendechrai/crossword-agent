import chalk, { Chalk, type ChalkInstance } from 'chalk';

import { isVisibleAt } from '../events/levels.js';
import type {
  CostSummaryEvent,
  GridFinalEvent,
  GridInitEvent,
  Level,
  ScoreFinalEvent,
  SolverEvent,
} from '../events/types.js';

export interface ConsoleRendererOptions {
  /**
   * Forces color on/off regardless of chalk's own auto-detection. Leave
   * undefined to use chalk's detection (which already respects `NO_COLOR`
   * and non-TTY streams).
   */
  color?: boolean;
  /** Terminal width; 80 when `process.stdout.columns` is undefined (B31). */
  columns?: number;
  /**
   * The puzzle's ground-truth letters, used only to render the level-0 diff
   * block. Not read from any event: no event payload carries the solution,
   * so a caller that wants the diff line must supply it directly. Omit it
   * and the final block still prints the grid, score and cost, just without
   * a per-cell diff.
   */
  solution?: ReadonlyArray<ReadonlyArray<string | null>>;
}

type PerTier = CostSummaryEvent['perTier'];
type Accuracy = ScoreFinalEvent['accuracy'];
export type Blocks = GridInitEvent['blocks'];
export type FinalLetters = GridFinalEvent['letters'];

/** Fields every `SolverEvent` carries, excluded from the generic key=value dump. */
const EVENT_BASE_KEYS = new Set(['type', 'runId', 'seq', 'tMs']);

/**
 * Which event types carry a `slotId` (some as `string`, some as
 * `string | null`). Content extraction only - never used to decide whether a
 * line is shown; that decision is `isVisibleAt` alone.
 */
function slotIdOf(event: SolverEvent): string | null {
  switch (event.type) {
    case 'slot:ask':
    case 'slot:candidates':
    case 'search:assign':
    case 'slot:reask':
    case 'slot:escalate':
    case 'repair:accept':
    case 'pattern:built':
    case 'candidate:reject':
    case 'domain:filtered':
    case 'search:forwardcheck':
    case 'search:wipeout':
    case 'search:unassign':
    case 'search:backtrack':
    case 'ac3:reduce':
    case 'ac3:wipeout':
    case 'ac3:arc':
    case 'repair:propose':
    case 'repair:reject':
    case 'llm:request':
    case 'llm:response':
    case 'cache:lookup':
      return event.slotId;
    default:
      return null;
  }
}

/** Matches any ASCII control character, including \n, \r and \t. */
const CONTROL_CHAR_RE = /[\x00-\x1f]/;

/**
 * A string containing a control character (most importantly \n or \r) would
 * otherwise split one printed event across several physical lines, breaking
 * the "one line per accepted event" contract and desynchronising the
 * '+<ms> #<seq>' prefix from every physical line but the first. JSON.stringify
 * renders such a string as a single-line, double-quoted literal with \n, \r
 * etc. as two-character escape sequences; a string with no control
 * characters is left bare, matching prior output exactly.
 */
function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return CONTROL_CHAR_RE.test(value) ? JSON.stringify(value) : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Every field beyond the shared `EventBase` ones, as `key=value` pairs. */
function detailOf(event: SolverEvent): string {
  const rest = { ...event } as unknown as Record<string, unknown>;
  const entries: string[] = [];
  for (const key of Object.keys(rest)) {
    if (EVENT_BASE_KEYS.has(key)) continue;
    entries.push(`${key}=${formatValue(rest[key])}`);
  }
  return entries.join(' ');
}

/**
 * Renders the final grid as one string per row: `#` for a block, `.` for an
 * empty cell, the uppercased letter otherwise. Pure and exported so other
 * renderers (T39's WatchRenderer) can reuse it read-only rather than
 * duplicating the logic.
 */
export function formatGridLines(blocks: Blocks | null, letters: FinalLetters | null): string[] {
  if (blocks === null || letters === null) return ['(grid unavailable)'];
  const out: string[] = [];
  for (let row = 0; row < blocks.length; row++) {
    const blockRow: readonly boolean[] = blocks[row] ?? [];
    const letterRow: ReadonlyArray<string | null> = letters[row] ?? [];
    let text = '';
    for (let col = 0; col < blockRow.length; col++) {
      if (blockRow[col] === true) {
        text += '#';
        continue;
      }
      const letter = letterRow[col] ?? null;
      text += letter === null ? '.' : letter.toUpperCase();
    }
    out.push(text);
  }
  return out;
}

/**
 * Renders the diff against the solution: a header naming the wrong and empty
 * cell counts, then one line per wrong cell (expected vs. got, got painted
 * red) and one line per empty cell. Pure and exported per docs/plan.md T39
 * ("the diff overlay reuses T14's diff formatting by importing it
 * (read-only)") so the two renderers cannot disagree.
 */
export function formatDiffLines(
  blocks: Blocks | null,
  letters: FinalLetters | null,
  solution: ReadonlyArray<ReadonlyArray<string | null>> | null,
  paint: ChalkInstance,
): string[] {
  if (blocks === null || letters === null) return ['Diff: grid unavailable'];
  if (solution === null) return ['Diff: no solution supplied'];

  const wrong: Array<{ row: number; col: number; expected: string; got: string }> = [];
  const empty: Array<{ row: number; col: number }> = [];

  for (let row = 0; row < blocks.length; row++) {
    const blockRow: readonly boolean[] = blocks[row] ?? [];
    const letterRow: ReadonlyArray<string | null> = letters[row] ?? [];
    const solutionRow: ReadonlyArray<string | null> = solution[row] ?? [];
    for (let col = 0; col < blockRow.length; col++) {
      if (blockRow[col] === true) continue;
      const got = letterRow[col] ?? null;
      if (got === null) {
        empty.push({ row, col });
        continue;
      }
      const expected = (solutionRow[col] ?? '').toUpperCase();
      const gotUpper = got.toUpperCase();
      if (gotUpper !== expected) {
        wrong.push({ row, col, expected, got: gotUpper });
      }
    }
  }

  const header = `Diff: ${wrong.length} wrong, ${empty.length} empty`;
  const wrongLines = wrong.map(
    (w) => `  r${w.row}c${w.col} expected ${w.expected} got ${paint.red(w.got)}`,
  );
  const emptyLines = empty.map((e) => `  r${e.row}c${e.col} empty`);
  return [header, ...wrongLines, ...emptyLines];
}

/**
 * T14: one line per accepted event, prefixed with elapsed ms and slot id.
 * Level 0 additionally prints the final grid, the diff against the solution
 * and the score and cost blocks. Filtering is driven by MIN_LEVEL, never by a
 * switch in the renderer.
 */
export class ConsoleRenderer {
  private readonly level: Level;
  private readonly stream: NodeJS.WritableStream;
  private readonly columns: number;
  private readonly paint: ChalkInstance;
  private readonly solution: ReadonlyArray<ReadonlyArray<string | null>> | null;

  private blocks: Blocks | null = null;
  private finalLetters: FinalLetters | null = null;
  private accuracy: Accuracy | null = null;
  private costPerTier: PerTier | null = null;

  constructor(level: Level, stream: NodeJS.WritableStream, opts: ConsoleRendererOptions = {}) {
    this.level = level;
    this.stream = stream;
    this.columns = opts.columns ?? process.stdout.columns ?? 80;
    this.solution = opts.solution ?? null;

    // chalk's own detection (NO_COLOR, non-TTY, FORCE_COLOR) is `chalk.level`;
    // the explicit option overrides it either way (B31).
    const colorLevel = opts.color === undefined ? chalk.level : opts.color ? 1 : 0;
    this.paint = new Chalk({ level: colorLevel });
  }

  handle(event: SolverEvent): void {
    this.captureState(event);

    if (isVisibleAt(event.type, this.level)) {
      this.printEventLine(event);
    }

    if (event.type === 'run:end' && this.level === 0) {
      this.printFinalBlock();
    }
  }

  private captureState(event: SolverEvent): void {
    switch (event.type) {
      case 'grid:init':
        this.blocks = event.blocks;
        return;
      case 'grid:final':
        this.finalLetters = event.letters;
        return;
      case 'score:final':
        this.accuracy = event.accuracy;
        return;
      case 'cost:summary':
        this.costPerTier = event.perTier;
        return;
      default:
        return;
    }
  }

  private printEventLine(event: SolverEvent): void {
    const slotId = slotIdOf(event);
    const prefix = `+${event.tMs}ms #${event.seq}${slotId !== null ? ` [${slotId}]` : ''}`;
    const detail = detailOf(event);
    const line = `${prefix} ${event.type}${detail.length > 0 ? ` ${detail}` : ''}`;
    this.write(this.truncate(line));
  }

  private truncate(line: string): string {
    if (line.length <= this.columns) return line;
    if (this.columns <= 3) return line.slice(0, this.columns);
    return `${line.slice(0, this.columns - 3)}...`;
  }

  private write(line: string): void {
    this.stream.write(`${line}\n`);
  }

  private printFinalBlock(): void {
    const lines: string[] = ['', 'Final grid:', ...this.gridLines(), '', ...this.diffLines(), '', this.scoreLine(), this.costLine()];
    this.stream.write(`${lines.join('\n')}\n`);
  }

  private gridLines(): string[] {
    return formatGridLines(this.blocks, this.finalLetters);
  }

  private diffLines(): string[] {
    return formatDiffLines(this.blocks, this.finalLetters, this.solution, this.paint);
  }

  private scoreLine(): string {
    if (this.accuracy === null) return 'Score: unavailable';
    const a = this.accuracy;
    return `Score: letters=${a.letters.toFixed(3)} words=${a.words.toFixed(3)} perfect=${String(a.perfect)} emptyCells=${a.emptyCells}`;
  }

  private costLine(): string {
    if (this.costPerTier === null) return 'Cost: unavailable';
    const t1 = this.costPerTier.tier1;
    const t2 = this.costPerTier.tier2;
    return (
      `Cost: tier1 calls=${t1.calls} billed=$${t1.usdBilled.toFixed(4)} counterfactual=$${t1.usdCounterfactual.toFixed(4)}` +
      ` | tier2 calls=${t2.calls} billed=$${t2.usdBilled.toFixed(4)} counterfactual=$${t2.usdCounterfactual.toFixed(4)}`
    );
  }
}
