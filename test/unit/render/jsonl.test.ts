import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEventBus } from '../../../src/events/bus.js';
import { createJsonlEventSink } from '../../../src/render/jsonl.js';
import { replay } from '../../../src/render/replay.js';
import { log } from '../../../src/util/log.js';
import type { EmittedEvent, SolverEvent } from '../../../src/events/types.js';

const MINIMAL_FIXTURE = fileURLToPath(
  new URL('../../fixtures/events/minimal.events.jsonl', import.meta.url),
);

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crossword-jsonl-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const RUN_START: EmittedEvent = {
  type: 'run:start',
  puzzleId: 'synthetic-5x5',
  profileName: 'baseline',
  models: { tier1: 'nvidia/Nemotron-3_5-Lightning', tier2: 'deepseek-ai/DeepSeek-V4-Pro' },
  seed: null,
};

const GRID_INIT: EmittedEvent = {
  type: 'grid:init',
  width: 2,
  height: 1,
  blocks: [[false, false]],
  numbers: [[1, null]],
  slots: [{ id: '1a', row: 0, col: 0, length: 2, direction: 'across', clue: 'Test clue' }],
};

const RUN_END: EmittedEvent = { type: 'run:end', status: 'ok', wallMs: 42 };

describe('createJsonlEventSink + replay round-trip (acceptance 4)', () => {
  it('round-trips a bus-emitted stream to deep-equal objects in the same order', async () => {
    const dir = tempDir();
    const path = join(dir, 'run.events.jsonl');

    let clock = 0;
    const bus = createEventBus({
      runId: 'roundtrip-run',
      now: () => {
        clock += 7;
        return clock;
      },
    });
    const sink = createJsonlEventSink(path);
    bus.on(sink.handler);

    bus.emit(RUN_START);
    bus.emit(GRID_INIT);
    bus.emit(RUN_END);
    await sink.close();

    const received: SolverEvent[] = [];
    await replay(path, (e) => received.push(e));

    expect(received).toHaveLength(3);
    expect(received.map((e) => e.type)).toEqual(['run:start', 'grid:init', 'run:end']);
    expect(received.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(received.every((e) => e.runId === 'roundtrip-run')).toBe(true);
  });

  it('round-trips the minimal.events.jsonl fixture (this task ships its own fixture)', async () => {
    const received: SolverEvent[] = [];
    await replay(MINIMAL_FIXTURE, (e) => received.push(e));

    expect(received.map((e) => e.type)).toEqual(['run:start', 'grid:init', 'run:end']);
    expect(received.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(received.every((e) => e.runId === 'minimal-run')).toBe(true);

    const runEnd = received[2];
    expect(runEnd?.type).toBe('run:end');
    if (runEnd?.type === 'run:end') {
      expect(runEnd.status).toBe('ok');
      expect(runEnd.wallMs).toBe(42);
    }
  });
});

describe('createJsonlEventSink', () => {
  it('appends one JSON line per event, in order', () => {
    const dir = tempDir();
    const path = join(dir, 'out.events.jsonl');
    const bus = createEventBus({ runId: 'r', now: () => 0 });
    const sink = createJsonlEventSink(path);
    bus.on(sink.handler);

    bus.emit(RUN_START);
    bus.emit(RUN_END);

    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0] as string) as SolverEvent).type).toBe('run:start');
    expect((JSON.parse(lines[1] as string) as SolverEvent).type).toBe('run:end');
  });

  it('creates the parent directory if it does not already exist', () => {
    const dir = tempDir();
    const path = join(dir, 'nested', 'deeper', 'out.events.jsonl');
    const sink = createJsonlEventSink(path);
    sink.handler({ ...RUN_START, runId: 'r', seq: 0, tMs: 0 });
    expect(readFileSync(path, 'utf8')).toContain('"run:start"');
  });
});

describe('replay (acceptance 5, 6)', () => {
  it('succeeds on a file with a trailing blank line', async () => {
    const dir = tempDir();
    const path = join(dir, 'trailing-blank.events.jsonl');
    const line = JSON.stringify({ ...RUN_START, runId: 'r', seq: 0, tMs: 0 });
    writeFileSync(path, `${line}\n\n`, 'utf8');

    const received: SolverEvent[] = [];
    await expect(replay(path, (e) => received.push(e))).resolves.toBeUndefined();
    expect(received).toHaveLength(1);
  });

  it('reports a malformed line by its line number and continues with the rest', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const dir = tempDir();
      const path = join(dir, 'malformed.events.jsonl');
      const good1 = JSON.stringify({ ...RUN_START, runId: 'r', seq: 0, tMs: 0 });
      const good2 = JSON.stringify({ ...RUN_END, runId: 'r', seq: 1, tMs: 5 });
      writeFileSync(path, `${good1}\nthis is not json\n${good2}\n`, 'utf8');

      const received: SolverEvent[] = [];
      await replay(path, (e) => received.push(e));

      expect(received.map((e) => e.type)).toEqual(['run:start', 'run:end']);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain('2');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('hands back tMs unmodified, monotonic non-decreasing across the stream (acceptance 6)', async () => {
    const dir = tempDir();
    const path = join(dir, 'monotonic.events.jsonl');

    let clock = 0;
    const bus = createEventBus({
      runId: 'r',
      now: () => {
        clock += 11;
        return clock;
      },
    });
    const sink = createJsonlEventSink(path);
    bus.on(sink.handler);

    for (let i = 0; i < 5; i++) bus.emit(RUN_START);
    await sink.close();

    const tMs: number[] = [];
    await replay(path, (e) => tMs.push(e.tMs));

    expect(tMs).toEqual([11, 22, 33, 44, 55]);
    for (let i = 1; i < tMs.length; i++) {
      expect(tMs[i]).toBeGreaterThanOrEqual(tMs[i - 1] as number);
    }
  });

  it('does not re-stamp seq or tMs: replayed values equal exactly what was recorded', async () => {
    const dir = tempDir();
    const path = join(dir, 'exact.events.jsonl');
    const line = JSON.stringify({
      runId: 'exact-run',
      seq: 99,
      tMs: 12345,
      type: 'run:end',
      status: 'partial',
      wallMs: 999,
    });
    writeFileSync(path, `${line}\n`, 'utf8');

    const received: SolverEvent[] = [];
    await replay(path, (e) => received.push(e));

    expect(received).toEqual([
      { runId: 'exact-run', seq: 99, tMs: 12345, type: 'run:end', status: 'partial', wallMs: 999 },
    ]);
  });
});
