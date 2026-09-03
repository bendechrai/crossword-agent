import { describe, expect, it, vi } from 'vitest';

import { createEventBus } from '../../../src/events/bus.js';
import { log } from '../../../src/util/log.js';
import type { EmittedEvent, SolverEvent } from '../../../src/events/types.js';

const RUN_START: EmittedEvent = {
  type: 'run:start',
  puzzleId: 'synthetic-5x5',
  profileName: 'baseline',
  models: { tier1: 'nvidia/Nemotron-3_5-Lightning', tier2: 'deepseek-ai/DeepSeek-V4-Pro' },
  seed: null,
};

const PROGRESS: EmittedEvent = {
  type: 'progress',
  phase: 'search',
  assigned: 1,
  total: 5,
  elapsedMs: 10,
  usd: 0.001,
};

function counter(): () => number {
  let n = 0;
  return () => n++;
}

describe('createEventBus', () => {
  it('delivers events to every registered handler, in registration order, with seq 0,1,2 (acceptance 1)', () => {
    const bus = createEventBus({ runId: 'r1', now: counter() });
    const seen: Array<{ who: string; seq: number }> = [];
    const order: string[] = [];

    bus.on((e) => {
      order.push('first');
      seen.push({ who: 'first', seq: e.seq });
    });
    bus.on((e) => {
      order.push('second');
      seen.push({ who: 'second', seq: e.seq });
    });
    bus.on((e) => {
      order.push('third');
      seen.push({ who: 'third', seq: e.seq });
    });

    bus.emit(RUN_START);
    bus.emit(PROGRESS);
    bus.emit(RUN_START);

    // Each emit calls handlers in registration order.
    expect(order).toEqual([
      'first',
      'second',
      'third',
      'first',
      'second',
      'third',
      'first',
      'second',
      'third',
    ]);
    // seq is 0, 1, 2 across the three emits, for every handler.
    expect(seen.filter((s) => s.who === 'first').map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(seen.filter((s) => s.who === 'second').map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(seen.filter((s) => s.who === 'third').map((s) => s.seq)).toEqual([0, 1, 2]);
  });

  it('stamps runId and tMs on every event', () => {
    let now = 100;
    const bus = createEventBus({ runId: 'stamped-run', now: () => now });
    const received: SolverEvent[] = [];
    bus.on((e) => received.push(e));

    now = 100;
    bus.emit(RUN_START);
    now = 130;
    bus.emit(PROGRESS);

    expect(received[0]?.runId).toBe('stamped-run');
    expect(received[0]?.tMs).toBe(0);
    expect(received[1]?.runId).toBe('stamped-run');
    expect(received[1]?.tMs).toBe(30);
  });

  it('does not stop other handlers when one throws, and logs exactly one warning (acceptance 2)', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const bus = createEventBus({ runId: 'r2', now: counter() });
      const secondReceived: SolverEvent[] = [];

      bus.on(() => {
        throw new Error('boom');
      });
      bus.on((e) => secondReceived.push(e));

      bus.emit(RUN_START);

      expect(secondReceived).toHaveLength(1);
      expect(secondReceived[0]?.type).toBe('run:start');
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('off removes a handler so it receives no further events (acceptance 3)', () => {
    const bus = createEventBus({ runId: 'r3', now: counter() });
    const received: SolverEvent[] = [];
    const handler = (e: SolverEvent): void => {
      received.push(e);
    };

    bus.on(handler);
    bus.emit(RUN_START);
    bus.off(handler);
    bus.emit(RUN_START);

    expect(received).toHaveLength(1);
  });

  it('tMs is monotonic non-decreasing across a stream of emits with a real, ever-increasing clock', () => {
    let clock = 0;
    const bus = createEventBus({
      runId: 'r4',
      now: () => {
        clock += 3;
        return clock;
      },
    });
    const tMs: number[] = [];
    bus.on((e) => tMs.push(e.tMs));

    for (let i = 0; i < 5; i++) bus.emit(PROGRESS);

    for (let i = 1; i < tMs.length; i++) {
      expect(tMs[i]).toBeGreaterThanOrEqual(tMs[i - 1] as number);
    }
  });
});
