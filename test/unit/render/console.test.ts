import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ConsoleRenderer } from '../../../src/render/console.js';
import { MIN_LEVEL } from '../../../src/events/levels.js';
import type { Level, SolverEvent } from '../../../src/events/types.js';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../fixtures/events/full-run.events.jsonl', import.meta.url),
);

/** ASCII escape byte (0x1b): color codes start with this. */
const ESC = String.fromCharCode(27);

/** The synthetic-5x5 fixture's ground truth (test/fixtures/puzzles/synthetic-5x5.json). */
const SYNTHETIC_5X5_SOLUTION: ReadonlyArray<ReadonlyArray<string | null>> = [
  ['O', 'H', '', 'P', 'I'],
  ['R', 'A', 'Y', 'O', 'N'],
  ['A', 'V', 'O', 'I', 'D'],
  ['L', 'O', 'U', 'S', 'E'],
  ['', 'C', '', 'E', 'X'],
];

const EVENT_TYPES: ReadonlySet<string> = new Set(Object.keys(MIN_LEVEL));

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

/**
 * A minimal runtime type guard for `SolverEvent`: every event is a record
 * carrying the shared `EventBase` fields plus a `type` that is one of the
 * keys `MIN_LEVEL` declares - which is exactly `SolverEvent['type']`, since
 * `MIN_LEVEL` is declared `satisfies Record<SolverEventType, Level>`.
 */
function isSolverEvent(value: unknown): value is SolverEvent {
  if (!isRecord(value)) return false;
  if (typeof value.type !== 'string' || !EVENT_TYPES.has(value.type)) return false;
  if (typeof value.runId !== 'string') return false;
  if (typeof value.seq !== 'number') return false;
  if (typeof value.tMs !== 'number') return false;
  return true;
}

function loadFixtureLines(): string[] {
  const raw = readFileSync(FIXTURE_PATH, 'utf8');
  return raw.split('\n').filter((line) => line.trim().length > 0);
}

function loadFixtureEvents(): SolverEvent[] {
  return loadFixtureLines().map((line) => {
    const parsed: unknown = JSON.parse(line);
    if (!isSolverEvent(parsed)) {
      throw new Error(`fixture line does not validate as a SolverEvent: ${line}`);
    }
    return parsed;
  });
}

interface Sink {
  stream: PassThrough;
  text: () => string;
}

function makeSink(): Sink {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

function render(
  level: Level,
  opts: { color?: boolean; solution?: ReadonlyArray<ReadonlyArray<string | null>> } = {},
): string {
  const sink = makeSink();
  const renderer = new ConsoleRenderer(level, sink.stream, opts);
  for (const event of loadFixtureEvents()) renderer.handle(event);
  return sink.text();
}

/** Matches only the one-line-per-event lines this renderer prints (never the final block). */
const EVENT_LINE_RE = /^\+(\d+)ms #(\d+)/gm;

function seqsRendered(text: string): Set<number> {
  const seqs = new Set<number>();
  for (const match of text.matchAll(EVENT_LINE_RE)) {
    const seq = match[2];
    if (seq !== undefined) seqs.add(Number(seq));
  }
  return seqs;
}

describe('fixture: test/fixtures/events/full-run.events.jsonl', () => {
  it('parses every line as JSON and validates as a SolverEvent (acceptance 7)', () => {
    const events = loadFixtureEvents();
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(isSolverEvent(event)).toBe(true);
  });

  it('contains at least one event of every SolverEvent type (acceptance 6)', () => {
    const events = loadFixtureEvents();
    const typesInFixture = new Set(events.map((e) => e.type));
    expect([...typesInFixture].sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('carries seq 0..n-1 in file order, one run', () => {
    const events = loadFixtureEvents();
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(new Set(events.map((e) => e.runId)).size).toBe(1);
  });
});

describe('ConsoleRenderer: level filtering (MIN_LEVEL-driven, never a switch)', () => {
  it('at level 0 prints exactly one line per event whose MIN_LEVEL is 0 (acceptance 1)', () => {
    const events = loadFixtureEvents();
    const expectedCount = events.filter((e) => MIN_LEVEL[e.type] === 0).length;

    const text = render(0);
    const matches = [...text.matchAll(EVENT_LINE_RE)];
    expect(matches.length).toBe(expectedCount);

    const renderedSeqs = seqsRendered(text);
    const expectedSeqs = new Set(events.filter((e) => MIN_LEVEL[e.type] === 0).map((e) => e.seq));
    expect(renderedSeqs).toEqual(expectedSeqs);
  });

  it('level 2 is a strict superset of level 1, which is a strict superset of level 0 (acceptance 2)', () => {
    const seqs0 = seqsRendered(render(0));
    const seqs1 = seqsRendered(render(1));
    const seqs2 = seqsRendered(render(2));

    expect(seqs0.size).toBeGreaterThan(0);
    expect(seqs1.size).toBeGreaterThan(seqs0.size);
    expect(seqs2.size).toBeGreaterThan(seqs1.size);

    for (const seq of seqs0) expect(seqs1.has(seq)).toBe(true);
    for (const seq of seqs1) expect(seqs2.has(seq)).toBe(true);
  });

  it('level 3 emits a line for every event in the fixture (acceptance 3)', () => {
    const events = loadFixtureEvents();
    const text = render(3);
    const matches = [...text.matchAll(EVENT_LINE_RE)];
    expect(matches.length).toBe(events.length);
    expect(seqsRendered(text)).toEqual(new Set(events.map((e) => e.seq)));
  });

  it('every printed line carries the event elapsed ms, and a slot id when the event has one', () => {
    const text = render(1);
    const askLine = text.split('\n').find((line) => line.includes('slot:ask'));
    expect(askLine).toBeDefined();
    expect(askLine).toMatch(/^\+50ms #3 \[1A\] slot:ask/);

    const runStartLine = text.split('\n').find((line) => line.includes('run:start'));
    expect(runStartLine).toBeDefined();
    // run:start carries no slotId: no "[...]" between the seq and the type.
    expect(runStartLine).toMatch(/^\+0ms #0 run:start/);
  });
});

describe('ConsoleRenderer: colour', () => {
  it('emits no ESC byte when constructed with colour: false (acceptance 4)', () => {
    const text = render(0, { color: false, solution: SYNTHETIC_5X5_SOLUTION });
    expect(text).not.toContain(ESC);
  });

  it('emits an ESC byte for the wrong letter when colour is forced on', () => {
    const text = render(0, { color: true, solution: SYNTHETIC_5X5_SOLUTION });
    expect(text).toContain(ESC);
  });
});

describe('ConsoleRenderer: level-0 final block (acceptance 5)', () => {
  it('prints the final grid, the diff against the solution, and the score and cost blocks', () => {
    const text = render(0, { color: false, solution: SYNTHETIC_5X5_SOLUTION });

    // Final grid: blocks as '#', the fixture's final letters uppercase, no
    // empty cells (the fixture's grid:final leaves nothing unfilled).
    expect(text).toContain('Final grid:');
    expect(text).toContain('OH#PI');
    expect(text).toContain('REYON');
    expect(text).toContain('AVOID');
    expect(text).toContain('LOUSE');
    expect(text).toContain('#C#EX');

    // Diff: the fixture's one wrong letter is row 1, col 1 (solution A,
    // filled E), everything else in the grid is correct and non-empty.
    expect(text).toContain('Diff: 1 wrong, 0 empty');
    expect(text).toContain('r1c1 expected A got E');

    // Score block: the fixture's score:final accuracy numbers.
    expect(text).toContain('Score: letters=0.955 words=0.818 perfect=false emptyCells=0');

    // Cost block: the fixture's cost:summary numbers, per tier.
    expect(text).toContain(
      'Cost: tier1 calls=9 billed=$0.0234 counterfactual=$0.0234 | tier2 calls=1 billed=$0.0080 counterfactual=$0.0200',
    );
  });

  it('is not printed at level 1 (only level 0 gets the extra block)', () => {
    const text = render(1, { solution: SYNTHETIC_5X5_SOLUTION });
    expect(text).not.toContain('Final grid:');
    expect(text).not.toContain('Score: letters=');
  });

  it('still prints score and cost, but skips the diff, when no solution is supplied', () => {
    const text = render(0, { color: false });
    expect(text).toContain('Final grid:');
    expect(text).toContain('Diff: no solution supplied');
    expect(text).toContain('Score: letters=0.955');
  });
});
