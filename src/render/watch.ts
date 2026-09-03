import { Chalk, type ChalkInstance } from 'chalk';
import logUpdate from 'log-update';

import {
  ConsoleRenderer,
  formatDiffLines,
  formatGridLines,
  type Blocks,
  type FinalLetters,
} from './console.js';
import type { GridInitEvent, Level, SolverEvent, SolverEventType } from '../events/types.js';
import type { ProducedByTier } from '../eval/types.js';

export interface WatchRendererOptions {
  /** Forces color on/off. Leave undefined to auto-detect from `env` (B31). */
  color?: boolean;
  /** Terminal width; 80 when `process.stdout.columns` is undefined (B31). */
  columns?: number;
  /** Injected so the TTY rules (B31) can be tested without a terminal. */
  isTty?: boolean;
  /** Injected so `CI`/`TERM`/`NO_COLOR` can be tested without touching the real environment. */
  env?: NodeJS.ProcessEnv;
  /**
   * Frame sink, called with one fully-rendered frame per redraw. Defaults to
   * `log-update`'s default export. Tests inject a plain collector so frames
   * can be asserted on as an array of strings ("Decisions baked in").
   */
  logUpdate?: (frame: string) => void;
  /**
   * T45: called by `finish()` once the live session is over, so the CLI can
   * release `log-update`'s held-open frame (`logUpdate.done()`) before
   * writing anything else to the stream - otherwise later output (the score
   * and cost block, the next shell prompt) can overwrite or corrupt the last
   * frame. Defaults to the real `log-update`'s own `done()`; tests inject a
   * collector so the call can be asserted without a real frame ever having
   * been drawn. A no-op in the B31 fallback branch, since no live frame was
   * ever opened there.
   */
  done?: () => void;
  /** Where the B31 fallback's one explanatory line is written. Defaults to `process.stderr`. */
  stderr?: NodeJS.WritableStream;
  /** Where the B31 `ConsoleRenderer(0)` fallback writes. Defaults to `process.stdout`. */
  stdout?: NodeJS.WritableStream;
  /**
   * Ground-truth letters for the `score:final` diff overlay. Same shape and
   * meaning as `ConsoleRendererOptions.solution` (T14); not read from any
   * event.
   */
  solution?: ReadonlyArray<ReadonlyArray<string | null>>;
}

type SlotDef = GridInitEvent['slots'][number];

interface CellMeta {
  tier: ProducedByTier;
  producedBy: string;
  confidence: number;
}

/** The B31 fallback always renders at level 0 (spec: "falls back to ConsoleRenderer(0)"). */
const FALLBACK_LEVEL: Level = 0;

/**
 * Event types that cause a full-frame redraw: the four named by docs/plan.md
 * T39 (`search:assign`, `search:unassign`, `repair:accept`, `progress`) plus
 * three the WatchRenderer needs to satisfy its own contract: `grid:init` (so
 * the very first frame already has the right dimensions, before any
 * assignment), `score:final` (so the diff overlay appears as soon as scoring
 * happens - "On score:final it overlays the diff") and `run:end` (so the
 * session's last frame reflects `grid:final`'s authoritative letters, which
 * in general can arrive after `score:final`). Every other event type still
 * updates internal state through `captureState` but does not, on its own,
 * cost a redraw.
 */
const REDRAW_TRIGGERS: ReadonlySet<SolverEventType> = new Set<SolverEventType>([
  'grid:init',
  'search:assign',
  'search:unassign',
  'repair:accept',
  'progress',
  'score:final',
  'grid:final',
  'run:end',
]);

function cellsOf(slot: SlotDef): Array<{ row: number; col: number }> {
  const cells: Array<{ row: number; col: number }> = [];
  for (let i = 0; i < slot.length; i++) {
    cells.push(
      slot.direction === 'across'
        ? { row: slot.row, col: slot.col + i }
        : { row: slot.row + i, col: slot.col },
    );
  }
  return cells;
}

/** Tier 1 cyan, tier 2 magenta, word-list fallback grey (B32). */
function tierPaint(paint: ChalkInstance, meta: CellMeta): (text: string) => string {
  if (meta.producedBy === 'wordlist' || meta.tier === 'wordlist') return paint.gray;
  return meta.tier === 1 ? paint.cyan : paint.magenta;
}

/** Bold at 0.5 and above, normal at 0.25 and above, dim below. */
function confidenceBand(paint: ChalkInstance, confidence: number, text: string): string {
  if (confidence >= 0.5) return paint.bold(text);
  if (confidence >= 0.25) return text;
  return paint.dim(text);
}

/**
 * T39: `log-update` full-frame redraw driven by the accumulated event
 * history. The grid comes from `grid:init` (B32) plus `search:assign` /
 * `search:unassign` / `repair:accept`, never from the grid model or the
 * domain store - the renderer holds only display state. Once `grid:final`
 * arrives its letters replace the accumulated ones and are rendered through
 * `formatGridLines`/`formatDiffLines` (imported read-only from T14's
 * `src/render/console.ts`), so the two renderers cannot disagree on the
 * final grid or the diff. TTY detection is B31: honoured only when
 * `isTty && !CI && TERM !== 'dumb'`; otherwise one line goes to stderr and
 * every event is handed to a `ConsoleRenderer(0)` instead.
 */
export class WatchRenderer {
  private readonly draw: (frame: string) => void;
  /** What `finish()` calls; null in the B31 fallback branch, where no live frame was ever opened. */
  private readonly finishDraw: (() => void) | null;
  private readonly paint: ChalkInstance;
  private readonly columns: number;
  private readonly solution: ReadonlyArray<ReadonlyArray<string | null>> | null;
  private readonly fallback: ConsoleRenderer | null;

  private blocks: Blocks | null = null;
  private slots: Map<string, SlotDef> = new Map();
  /** "row,col" -> the slot ids whose cells cover that position. */
  private coverage: Map<string, string[]> = new Map();
  private letters: Array<Array<string | null>> = [];
  private cellMeta: Array<Array<CellMeta | null>> = [];
  private slotAnswers: Map<string, string> = new Map();
  private slotMeta: Map<string, CellMeta> = new Map();

  /** Set once `grid:final` arrives; authoritative from then on. */
  private finalLetters: FinalLetters | null = null;
  private scored = false;

  private phase = 'seed';
  private assigned = 0;
  private total = 0;
  private backtracks = 0;
  private usd = 0;

  constructor(opts: WatchRendererOptions = {}) {
    const env = opts.env ?? process.env;
    const isTty = opts.isTty ?? process.stdout.isTTY === true;
    const ci = env.CI !== undefined && env.CI !== '';
    const dumbTerm = env.TERM === 'dumb';
    const useWatch = isTty && !ci && !dumbTerm;

    const noColorEnv = env.NO_COLOR !== undefined && env.NO_COLOR !== '';
    const colorLevel: 0 | 1 = opts.color === undefined ? (noColorEnv ? 0 : 1) : opts.color ? 1 : 0;
    this.paint = new Chalk({ level: colorLevel });
    this.columns = opts.columns ?? process.stdout.columns ?? 80;
    this.solution = opts.solution ?? null;
    const injectedDraw = opts.logUpdate;
    this.draw = injectedDraw ?? ((frame: string) => { logUpdate(frame); });

    if (useWatch) {
      this.fallback = null;
      this.finishDraw = opts.done ?? ((): void => { logUpdate.done(); });
    } else {
      const stderr = opts.stderr ?? process.stderr;
      const stdout = opts.stdout ?? process.stdout;
      stderr.write(
        'watch: no interactive TTY (or CI is set, or TERM=dumb); falling back to plain console output\n',
      );
      this.fallback = new ConsoleRenderer(FALLBACK_LEVEL, stdout, {
        color: opts.color,
        columns: opts.columns,
        solution: this.solution ?? undefined,
      });
      this.finishDraw = null;
    }
  }

  /**
   * T45: releases `log-update`'s held-open frame once the live session is
   * over, so whatever the caller writes to the stream next (the score and
   * cost block, the next shell prompt) starts on a fresh line instead of
   * overwriting or corrupting the last drawn frame. A no-op in the B31
   * fallback branch (`handle()` routed every event to a plain
   * `ConsoleRenderer` instead, so no live frame was ever opened to release).
   */
  finish(): void {
    this.finishDraw?.();
  }

  /**
   * Never throws: `src/render/replay.ts`'s `replay()` calls handlers
   * directly and does not catch a throwing handler, so an unexpected or
   * malformed event must be absorbed here rather than aborting the whole
   * replay or watch session.
   */
  handle(event: SolverEvent): void {
    if (this.fallback !== null) {
      this.fallback.handle(event);
      return;
    }

    try {
      this.captureState(event);
    } catch {
      return;
    }

    if (REDRAW_TRIGGERS.has(event.type)) {
      try {
        this.draw(this.renderFrame());
      } catch {
        return;
      }
    }
  }

  private captureState(event: SolverEvent): void {
    switch (event.type) {
      case 'grid:init':
        this.initGrid(event);
        return;
      case 'phase:start':
        this.phase = event.phase;
        return;
      case 'progress':
        this.phase = event.phase;
        this.assigned = event.assigned;
        this.total = event.total;
        this.usd = event.usd;
        return;
      case 'search:assign':
        this.writeSlot(event.slotId, event.answer, {
          tier: event.tier,
          producedBy: event.producedBy,
          confidence: event.score,
        });
        return;
      case 'repair:accept':
        this.writeSlot(event.slotId, event.after, {
          tier: event.tier,
          producedBy: event.producedBy,
          confidence: 1,
        });
        return;
      case 'search:unassign':
        this.clearSlot(event.slotId);
        return;
      case 'search:backtrack':
        this.backtracks += 1;
        return;
      case 'score:final':
        this.scored = true;
        return;
      case 'grid:final':
        this.finalLetters = event.letters;
        return;
      default:
        return;
    }
  }

  private initGrid(event: GridInitEvent): void {
    this.blocks = event.blocks;
    this.letters = event.blocks.map((row) => row.map(() => null));
    this.cellMeta = event.blocks.map((row) => row.map(() => null));
    this.slots = new Map();
    this.coverage = new Map();
    this.slotAnswers = new Map();
    this.slotMeta = new Map();
    this.total = event.slots.length;
    this.assigned = 0;
    this.finalLetters = null;
    this.scored = false;

    for (const slot of event.slots) {
      this.slots.set(slot.id, slot);
      for (const { row, col } of cellsOf(slot)) {
        const key = `${row},${col}`;
        const list = this.coverage.get(key) ?? [];
        list.push(slot.id);
        this.coverage.set(key, list);
      }
    }
  }

  private writeSlot(slotId: string, answer: string, meta: CellMeta): void {
    const slot = this.slots.get(slotId);
    if (slot === undefined) return;

    if (!this.slotAnswers.has(slotId)) this.assigned += 1;
    this.slotAnswers.set(slotId, answer);
    this.slotMeta.set(slotId, meta);

    const cells = cellsOf(slot);
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const letter = answer[i];
      if (cell === undefined || letter === undefined) continue;
      this.setCell(cell.row, cell.col, letter, meta);
    }
  }

  private clearSlot(slotId: string): void {
    const slot = this.slots.get(slotId);
    if (slot === undefined) return;

    if (this.slotAnswers.has(slotId)) {
      this.slotAnswers.delete(slotId);
      this.slotMeta.delete(slotId);
      this.assigned = Math.max(0, this.assigned - 1);
    }

    for (const { row, col } of cellsOf(slot)) {
      this.recomputeCell(row, col);
    }
  }

  /**
   * A cell can belong to two slots (an across and a down). Unassigning one
   * of them must not blank a cell the other slot still covers, so this looks
   * for any other slot still assigned at this position and, if found, uses
   * its letter and colouring instead of clearing the cell.
   */
  private recomputeCell(row: number, col: number): void {
    const coveringIds = this.coverage.get(`${row},${col}`) ?? [];
    for (const slotId of coveringIds) {
      const answer = this.slotAnswers.get(slotId);
      const meta = this.slotMeta.get(slotId);
      const slot = this.slots.get(slotId);
      if (answer === undefined || meta === undefined || slot === undefined) continue;
      const index = slot.direction === 'across' ? col - slot.col : row - slot.row;
      const letter = answer[index];
      if (letter === undefined) continue;
      this.setCell(row, col, letter, meta);
      return;
    }
    this.setCell(row, col, null, null);
  }

  private setCell(row: number, col: number, letter: string | null, meta: CellMeta | null): void {
    const letterRow = this.letters[row];
    const metaRow = this.cellMeta[row];
    if (letterRow === undefined || metaRow === undefined) return;
    letterRow[col] = letter;
    metaRow[col] = meta;
  }

  private renderFrame(): string {
    const lines: string[] = [this.statusLine(), ...this.gridLines()];
    if (this.scored) lines.push('', ...this.diffLines());
    return lines.map((line) => this.truncate(line)).join('\n');
  }

  private statusLine(): string {
    return (
      `phase=${this.phase} assigned=${this.assigned}/${this.total} ` +
      `backtracks=${this.backtracks} usd=$${this.usd.toFixed(4)}`
    );
  }

  private gridLines(): string[] {
    if (this.finalLetters !== null) return formatGridLines(this.blocks, this.finalLetters);
    return this.liveGridLines();
  }

  /** Renders the accumulated live state, colouring each letter by tier and confidence band. */
  private liveGridLines(): string[] {
    if (this.blocks === null) return ['(grid unavailable)'];
    const out: string[] = [];
    for (let row = 0; row < this.blocks.length; row++) {
      const blockRow: readonly boolean[] = this.blocks[row] ?? [];
      const letterRow: ReadonlyArray<string | null> = this.letters[row] ?? [];
      const metaRow: ReadonlyArray<CellMeta | null> = this.cellMeta[row] ?? [];
      let text = '';
      for (let col = 0; col < blockRow.length; col++) {
        if (blockRow[col] === true) {
          text += '#';
          continue;
        }
        const letter = letterRow[col] ?? null;
        if (letter === null) {
          text += '.';
          continue;
        }
        const upper = letter.toUpperCase();
        const meta = metaRow[col] ?? null;
        text += meta === null ? upper : confidenceBand(this.paint, meta.confidence, tierPaint(this.paint, meta)(upper));
      }
      out.push(text);
    }
    return out;
  }

  private diffLines(): string[] {
    const letters: FinalLetters | null = this.finalLetters ?? this.letters;
    return formatDiffLines(this.blocks, letters, this.solution, this.paint);
  }

  /**
   * Truncates on visible width, not raw byte length: an ANSI SGR escape
   * (`ESC[<params>m`) contributes 0 columns even though it is several raw
   * characters, so a coloured cell (e.g. `ESC[1mESC[36mXESC[39mESC[22m`)
   * must not be cut mid-sequence or counted as if each escape byte were a
   * printed column.
   */
  private truncate(line: string): string {
    const visible = visibleLength(line);
    if (visible <= this.columns) return line;
    const budget = this.columns <= 3 ? this.columns : this.columns - 3;
    let result = '';
    let count = 0;
    let i = 0;
    while (i < line.length && count < budget) {
      const match = ANSI_SGR.exec(line.slice(i));
      if (match) {
        result += match[0];
        i += match[0].length;
        continue;
      }
      result += line[i];
      count += 1;
      i += 1;
    }
    // Drain any escape sequences immediately following the cut point so a
    // style opened by the last included character (e.g. bold/colour) is
    // always closed, and the result never ends with a dangling `ESC[`.
    while (i < line.length) {
      const match = ANSI_SGR.exec(line.slice(i));
      if (!match) break;
      result += match[0];
      i += match[0].length;
    }
    return this.columns <= 3 ? result : `${result}...`;
  }
}

/** Matches one ANSI SGR escape sequence (`ESC[<params>m`) at the start of a string. */
const ANSI_SGR = /^\x1b\[[0-9;]*m/;

/** Matches every ANSI SGR escape sequence in a string, for stripping. */
const ANSI_SGR_GLOBAL = /\x1b\[[0-9;]*m/g;

/** Visible column width of a string: ANSI SGR escapes contribute 0. */
function visibleLength(text: string): number {
  return text.replace(ANSI_SGR_GLOBAL, '').length;
}
