import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { Chalk } from 'chalk';

import { WatchRenderer, type WatchRendererOptions } from '../../../src/render/watch.js';
import type { SearchAssignEvent, SolverEvent } from '../../../src/events/types.js';

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

function loadFixtureEvents(): SolverEvent[] {
  const raw = readFileSync(FIXTURE_PATH, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SolverEvent);
}

/** A watch-mode renderer (not the B31 fallback) that never touches a real TTY or stream. */
function makeWatcher(
  opts: Partial<WatchRendererOptions> = {},
): { renderer: WatchRenderer; frames: string[] } {
  const frames: string[] = [];
  const renderer = new WatchRenderer({
    isTty: true,
    env: {},
    logUpdate: (frame) => frames.push(frame),
    ...opts,
  });
  return { renderer, frames };
}

function replayFixture(opts: Partial<WatchRendererOptions> = {}): string[] {
  const { renderer, frames } = makeWatcher(opts);
  for (const event of loadFixtureEvents()) renderer.handle(event);
  return frames;
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

describe('WatchRenderer: replaying the fixture (acceptance 1, 2, 9)', () => {
  it('produces at least one frame per search:assign, and the final frame contains the fixture\'s final grid', () => {
    const events = loadFixtureEvents();
    const assignCount = events.filter((e) => e.type === 'search:assign').length;
    expect(assignCount).toBeGreaterThan(0);

    const frames = replayFixture({ color: false, solution: SYNTHETIC_5X5_SOLUTION });

    // One frame is drawn for every trigger event (grid:init, search:assign,
    // search:unassign, repair:accept, progress, score:final, grid:final,
    // run:end); the fixture has exactly one of each, so at least assignCount
    // of the frames are attributable to search:assign, and there are exactly
    // 8 in total.
    expect(frames.length).toBe(8);
    expect(frames.length).toBeGreaterThanOrEqual(assignCount);

    const finalFrame = frames[frames.length - 1];
    expect(finalFrame).toBeDefined();
    expect(finalFrame).toContain('OH#PI');
    expect(finalFrame).toContain('REYON');
    expect(finalFrame).toContain('AVOID');
    expect(finalFrame).toContain('LOUSE');
    expect(finalFrame).toContain('#C#EX');
  });

  it('draws the first frame from grid:init, with the right dimensions before any assignment (acceptance 2)', () => {
    const frames = replayFixture({ color: false });
    const first = frames[0];
    expect(first).toBeDefined();
    const lines = (first ?? '').split('\n');
    // lines[0] is the status line; the 5x5 grid follows as 5 more lines.
    const gridLines = lines.slice(1);
    expect(gridLines.length).toBe(5);
    for (const line of gridLines) {
      expect(line.length).toBe(5);
      // No letters yet: only blocks ('#') and empty cells ('.').
      expect(line).toMatch(/^[.#]+$/);
    }
  });

  it('the score:final frame already shows a diff overlay, and by the run\'s final frame it marks the fixture\'s wrong letter (acceptance 9)', () => {
    const events = loadFixtureEvents();
    const scoreFinalIndex = events.findIndex((e) => e.type === 'score:final');
    expect(scoreFinalIndex).toBeGreaterThanOrEqual(0);

    // score:final (seq 40) fires before grid:final (seq 42) in this fixture,
    // so the diff overlay activates immediately on score:final (matching
    // "On score:final it overlays the diff") but only carries the accurate,
    // fully-filled grid once grid:final's authoritative letters have arrived
    // - by the run's last frame (triggered by run:end).
    const { renderer, frames } = makeWatcher({ color: false, solution: SYNTHETIC_5X5_SOLUTION });
    let scoreFinalFrame: string | undefined;
    for (const event of events) {
      renderer.handle(event);
      if (event.type === 'score:final') scoreFinalFrame = frames[frames.length - 1];
    }

    expect(scoreFinalFrame).toBeDefined();
    expect(scoreFinalFrame).toContain('Diff:');

    const finalFrame = frames[frames.length - 1];
    expect(finalFrame).toContain('Diff: 1 wrong, 0 empty');
    expect(finalFrame).toContain('r1c1 expected A got E');
  });
});

describe('WatchRenderer: colour by tier and confidence (acceptance 3, 4)', () => {
  const gridInit: SolverEvent = {
    type: 'grid:init',
    runId: 'test-run',
    seq: 0,
    tMs: 0,
    width: 2,
    height: 1,
    blocks: [[false, false]],
    numbers: [[1, null]],
    slots: [{ id: '1A', row: 0, col: 0, length: 2, direction: 'across', clue: 'Test' }],
  };

  function assignEvent(tier: 1 | 2 | 'wordlist', producedBy: string): SearchAssignEvent {
    return {
      type: 'search:assign',
      runId: 'test-run',
      seq: 1,
      tMs: 10,
      slotId: '1A',
      answer: 'OK',
      score: 0.3, // the "normal" confidence band: no bold/dim wrapping to interfere
      margin: 0.1,
      tier,
      producedBy,
    };
  }

  it('a search:assign with tier: 2 produces a magenta cell', () => {
    const { renderer, frames } = makeWatcher({ color: true, columns: 200 });
    renderer.handle(gridInit);
    renderer.handle(assignEvent(2, 'test/tier2-model'));

    const magenta = new Chalk({ level: 1 }).magenta('O');
    const last = frames[frames.length - 1];
    expect(last).toContain(magenta);
  });

  it('a search:assign with tier: 1 produces a cyan cell', () => {
    const { renderer, frames } = makeWatcher({ color: true, columns: 200 });
    renderer.handle(gridInit);
    renderer.handle(assignEvent(1, 'test/tier1-model'));

    const cyan = new Chalk({ level: 1 }).cyan('O');
    const last = frames[frames.length - 1];
    expect(last).toContain(cyan);
  });

  it('producedBy: "wordlist" produces the grey cell', () => {
    const { renderer, frames } = makeWatcher({ color: true, columns: 200 });
    renderer.handle(gridInit);
    renderer.handle(assignEvent('wordlist', 'wordlist'));

    const grey = new Chalk({ level: 1 }).gray('O');
    const last = frames[frames.length - 1];
    expect(last).toContain(grey);
  });

  it('confidence at 0.5 and above is bold, below 0.25 is dim', () => {
    // Bold/dim nest around the tier colour, so a full `chalk.bold('O')`
    // substring would not appear contiguously; check for the raw SGR opening
    // codes instead (1 = bold, 2 = dim).
    const BOLD_OPEN = '\u001b[1m';
    const DIM_OPEN = '\u001b[2m';

    const bold: SolverEvent = { ...assignEvent(1, 'test/tier1-model'), score: 0.9 };
    const dim: SolverEvent = { ...assignEvent(1, 'test/tier1-model'), score: 0.1 };

    const boldRun = makeWatcher({ color: true, columns: 200 });
    boldRun.renderer.handle(gridInit);
    boldRun.renderer.handle(bold);
    const boldFrame = boldRun.frames[boldRun.frames.length - 1] ?? '';
    expect(boldFrame).toContain(BOLD_OPEN);
    expect(boldFrame).not.toContain(DIM_OPEN);

    const dimRun = makeWatcher({ color: true, columns: 200 });
    dimRun.renderer.handle(gridInit);
    dimRun.renderer.handle(dim);
    const dimFrame = dimRun.frames[dimRun.frames.length - 1] ?? '';
    expect(dimFrame).toContain(DIM_OPEN);
    expect(dimFrame).not.toContain(BOLD_OPEN);
  });
});

describe('WatchRenderer: B31 TTY gating and fallback (acceptance 5, 6)', () => {
  it('with isTTY false, writes exactly one line to stderr and every event goes to a ConsoleRenderer(0)', () => {
    const stderrSink = makeSink();
    const stdoutSink = makeSink();
    const renderer = new WatchRenderer({
      isTty: false,
      env: {},
      stderr: stderrSink.stream,
      stdout: stdoutSink.stream,
      color: false,
    });

    for (const event of loadFixtureEvents()) renderer.handle(event);

    const stderrLines = stderrSink.text().split('\n').filter((l) => l.length > 0);
    expect(stderrLines.length).toBe(1);

    // ConsoleRenderer(0)-shaped output: "+<ms>ms #<seq> ...".
    const stdoutText = stdoutSink.text();
    expect(stdoutText).toMatch(/^\+\d+ms #\d+/m);
    expect(stdoutText).toContain('run:start');
  });

  it('falls back even when isTTY is true, if CI is set (acceptance 6, B31)', () => {
    const stderrSink = makeSink();
    const stdoutSink = makeSink();
    const renderer = new WatchRenderer({
      isTty: true,
      env: { CI: '1' },
      stderr: stderrSink.stream,
      stdout: stdoutSink.stream,
      color: false,
    });

    renderer.handle(loadFixtureEvents()[0] as SolverEvent);

    expect(stderrSink.text().split('\n').filter((l) => l.length > 0).length).toBe(1);
    expect(stdoutSink.text()).toMatch(/^\+0ms #0 run:start/);
  });

  it('falls back when TERM is dumb, even with isTTY true and no CI', () => {
    const stderrSink = makeSink();
    const stdoutSink = makeSink();
    const renderer = new WatchRenderer({
      isTty: true,
      env: { TERM: 'dumb' },
      stderr: stderrSink.stream,
      stdout: stdoutSink.stream,
      color: false,
    });

    renderer.handle(loadFixtureEvents()[0] as SolverEvent);

    expect(stdoutSink.text()).toMatch(/^\+0ms #0 run:start/);
  });
});

describe('WatchRenderer: NO_COLOR and width (acceptance 7, 8)', () => {
  it('with NO_COLOR=1, no frame contains an ESC byte', () => {
    const frames = replayFixture({ env: { NO_COLOR: '1' }, solution: SYNTHETIC_5X5_SOLUTION });
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) expect(frame).not.toContain(ESC);
  });

  it('with process.stdout.columns undefined, frames are at most 80 columns wide', () => {
    // Cast to a narrow, honest shape (not `any`) so `columns` can be forced
    // to `undefined` for this one assertion, regardless of the real test
    // runner's stdout, then restored.
    const stdoutColumns = process.stdout as unknown as { columns: number | undefined };
    const original = stdoutColumns.columns;
    stdoutColumns.columns = undefined;
    try {
      expect(process.stdout.columns).toBeUndefined();
      const frames = replayFixture({ color: false, solution: SYNTHETIC_5X5_SOLUTION });
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          expect(line.length).toBeLessThanOrEqual(80);
        }
      }
    } finally {
      stdoutColumns.columns = original;
    }
  });
});

describe('WatchRenderer: never throws on unexpected events', () => {
  it('ignores a search:assign for an unknown slot id rather than throwing', () => {
    const { renderer, frames } = makeWatcher({ color: false });
    renderer.handle({
      type: 'grid:init',
      runId: 'test-run',
      seq: 0,
      tMs: 0,
      width: 1,
      height: 1,
      blocks: [[false]],
      numbers: [[1]],
      slots: [],
    });

    expect(() =>
      renderer.handle({
        type: 'search:assign',
        runId: 'test-run',
        seq: 1,
        tMs: 1,
        slotId: 'does-not-exist',
        answer: 'X',
        score: 0.9,
        margin: 0.1,
        tier: 1,
        producedBy: 'test/tier1-model',
      }),
    ).not.toThrow();

    expect(frames.length).toBe(2);
  });

  it('ignores an unassign for a slot that was never assigned', () => {
    const { renderer } = makeWatcher({ color: false });
    renderer.handle({
      type: 'grid:init',
      runId: 'test-run',
      seq: 0,
      tMs: 0,
      width: 1,
      height: 1,
      blocks: [[false]],
      numbers: [[1]],
      slots: [{ id: '1A', row: 0, col: 0, length: 1, direction: 'across', clue: 'x' }],
    });

    expect(() =>
      renderer.handle({
        type: 'search:unassign',
        runId: 'test-run',
        seq: 1,
        tMs: 1,
        slotId: '1A',
        answer: 'X',
      }),
    ).not.toThrow();
  });
});
