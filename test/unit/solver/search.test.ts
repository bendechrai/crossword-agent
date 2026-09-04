import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Candidate } from '../../../src/candidates/types.js';
import { createDomainStore } from '../../../src/grid/domainStore.js';
import { Grid } from '../../../src/grid/model.js';
import type { DomainStore } from '../../../src/grid/types.js';
import type { EmittedEvent, SolverEventType } from '../../../src/events/types.js';
import type { EscalationDecision } from '../../../src/policy/types.js';
import type { Cell, Puzzle, Slot } from '../../../src/puzzle/types.js';
import { search } from '../../../src/solver/search.js';
import type { SearchFn, SearchHooks, SearchOptions } from '../../../src/solver/types.js';

/**
 * T37. The search is exercised against `test/fixtures/domains/search-*.json`
 * and a fake `SearchHooks`: T38 owns the real hooks, and this task must never
 * reach the candidate service.
 */

// Deterministic PRNG (mulberry32), matching test/unit/solver/ordering.test.ts,
// so no test here can reach Math.random.
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FixtureCandidate {
  answer: string;
  score: number;
}

interface SearchFixture {
  description: string;
  /** Id of a puzzle under test/fixtures/puzzles; mutually exclusive with `grid`. */
  puzzle?: string;
  /** Rows of `.` (white) and `#` (block); mutually exclusive with `puzzle`. */
  grid?: string[];
  domains: Record<string, FixtureCandidate[]>;
}

const FIXTURE_ROOT = new URL('../../fixtures/', import.meta.url);

function readJson(relative: string): unknown {
  const path = fileURLToPath(new URL(relative, FIXTURE_ROOT));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/**
 * Numbering and slot extraction from a `.`/`#` grid, so a fixture can carry a
 * tiny purpose-built grid inline instead of a whole normalised puzzle file. It
 * is B19's rule: a white cell starts a number when it begins an across run of
 * at least 2 or a down run of at least 2, numbered left to right, top to
 * bottom from 1.
 */
function buildPuzzle(id: string, rows: readonly string[]): Puzzle {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const isBlock = (row: number, col: number): boolean => {
    if (row < 0 || row >= height || col < 0 || col >= width) return true;
    return (rows[row]?.[col] ?? '#') === '#';
  };
  const startsAcross = (row: number, col: number): boolean =>
    !isBlock(row, col) && isBlock(row, col - 1) && !isBlock(row, col + 1);
  const startsDown = (row: number, col: number): boolean =>
    !isBlock(row, col) && isBlock(row - 1, col) && !isBlock(row + 1, col);

  const cells: Cell[][] = [];
  const slots: Slot[] = [];
  let next = 1;
  for (let row = 0; row < height; row += 1) {
    const cellRow: Cell[] = [];
    for (let col = 0; col < width; col += 1) {
      if (isBlock(row, col)) {
        cellRow.push({ row, col, block: true });
        continue;
      }
      const across = startsAcross(row, col);
      const down = startsDown(row, col);
      if (!across && !down) {
        cellRow.push({ row, col, block: false });
        continue;
      }
      const number = next;
      next += 1;
      cellRow.push({ row, col, block: false, number });
      if (across) {
        const cellsOf: Array<readonly [number, number]> = [];
        for (let c = col; !isBlock(row, c); c += 1) cellsOf.push([row, c] as const);
        slots.push({
          id: `${number}A`,
          number,
          direction: 'across',
          row,
          col,
          length: cellsOf.length,
          clue: `across entry at r${row}c${col}`,
          cells: cellsOf,
        });
      }
      if (down) {
        const cellsOf: Array<readonly [number, number]> = [];
        for (let r = row; !isBlock(r, col); r += 1) cellsOf.push([r, col] as const);
        slots.push({
          id: `${number}D`,
          number,
          direction: 'down',
          row,
          col,
          length: cellsOf.length,
          clue: `down entry at r${row}c${col}`,
          cells: cellsOf,
        });
      }
    }
    cells.push(cellRow);
  }

  return {
    id,
    source: 'synthetic',
    style: 'american',
    width,
    height,
    cells,
    slots,
    parsedBy: 'xd-crossword-tools',
  };
}

function candidatesOf(entries: readonly FixtureCandidate[]): Candidate[] {
  return entries.map((entry, rank) => ({
    answer: entry.answer,
    raw: entry.answer,
    rank,
    selfConfidence: entry.score,
    votes: 1,
    score: entry.score,
    tier: 1,
    fromCache: false,
  }));
}

interface LoadedFixture {
  grid: Grid;
  domains: DomainStore;
}

function loadFixture(name: string): LoadedFixture {
  const fixture = readJson(`domains/${name}.json`) as SearchFixture;

  let puzzle: Puzzle;
  if (fixture.puzzle !== undefined) {
    const file = readJson(`puzzles/${fixture.puzzle}.json`) as Puzzle & { solution?: unknown };
    // The solver's input is structurally incapable of carrying answers (B11),
    // so the solution is dropped before the grid is built.
    const { solution: _solution, ...rest } = file;
    puzzle = rest;
  } else {
    puzzle = buildPuzzle(name, fixture.grid ?? []);
  }

  const domains = createDomainStore();
  for (const [slotId, entries] of Object.entries(fixture.domains)) {
    domains.setBase(slotId, candidatesOf(entries));
  }
  return { grid: new Grid(puzzle), domains };
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface HooksLog {
  emptyDomain: string[];
  charges: Array<{ cap: string; amount: number }>;
  terminations: string[][];
}

interface FakeHooksOptions {
  /** Called when a domain empties; may merge into the store to "fix" the slot. */
  onEmpty?: (slotId: string) => EscalationDecision;
  /** Reports a crossed cap on the nth charge (1-based). */
  exceedOnCharge?: number;
}

function fakeHooks(log: HooksLog, opts: FakeHooksOptions = {}): SearchHooks {
  return {
    onEmptyDomain(slotId: string): Promise<EscalationDecision> {
      log.emptyDomain.push(slotId);
      const decision = opts.onEmpty?.(slotId) ?? { action: 'give-up' as const, reason: 'fake' };
      return Promise.resolve(decision);
    },
    onCandidatesReturned(): Promise<EscalationDecision> {
      return Promise.reject(new Error('the search must never call onCandidatesReturned'));
    },
    onSearchTermination(emptySlotIds: readonly string[]): Promise<EscalationDecision[]> {
      log.terminations.push([...emptySlotIds]);
      return Promise.resolve([]);
    },
    chargeBudget(cap, amount) {
      log.charges.push({ cap, amount });
      const exceeded = opts.exceedOnCharge === log.charges.length ? cap : null;
      return { exceeded };
    },
  };
}

function emptyLog(): HooksLog {
  return { emptyDomain: [], charges: [], terminations: [] };
}

function recorder(): { events: EmittedEvent[]; emit: (event: EmittedEvent) => void } {
  const events: EmittedEvent[] = [];
  return { events, emit: (event) => void events.push(event) };
}

function ofType<T extends SolverEventType>(
  events: readonly EmittedEvent[],
  type: T,
): Array<Extract<EmittedEvent, { type: T }>> {
  return events.filter((e): e is Extract<EmittedEvent, { type: T }> => e.type === type);
}

function options(overrides: Partial<SearchOptions> = {}): SearchOptions {
  return {
    ordering: 'margin',
    ldsLimitStart: 0,
    ldsLimitMax: 3,
    maxBacktracks: 200,
    rng: mulberry32(1),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('search', () => {
  it('satisfies the SearchFn contract declared in T0', () => {
    const asContract: SearchFn = search;
    expect(typeof asContract).toBe('function');
  });

  it('solves a 5x5 whose domains admit exactly one consistent fill', async () => {
    const { grid, domains } = loadFixture('search-solvable');
    const log = emptyLog();
    const { events, emit } = recorder();

    const result = await search(grid, domains, fakeHooks(log), emit, options());

    expect(result.complete).toBe(true);
    expect(grid.isComplete()).toBe(true);
    expect(grid.snapshot().assigned).toEqual({
      '1A': 'OH',
      '3A': 'PI',
      '5A': 'RAYON',
      '7A': 'AVOID',
      '8A': 'LOUSE',
      '9A': 'EX',
      '1D': 'ORAL',
      '2D': 'HAVOC',
      '3D': 'POISE',
      '4D': 'INDEX',
      '6D': 'YOU',
    });
    expect(result.assigned).toBe(11);
    expect(result.backtracks).toBe(0);
    expect(result.discrepancies).toBe(0);
    expect(result.wipeouts).toBe(0);
    expect(result.ldsRestarts).toBe(0);
    expect(result.emptySlotIds).toEqual([]);
    expect(log.emptyDomain).toEqual([]);
    // Every assignment carries its producing tier and producer (B32).
    for (const event of ofType(events, 'search:assign')) {
      expect(event.tier).toBe(1);
      expect(event.producedBy).toBe('tier1');
    }
  });

  it('assigns a dead-end first value, wipes out, backtracks and completes', async () => {
    const { grid, domains } = loadFixture('search-backtrack');
    const log = emptyLog();
    const { events, emit } = recorder();

    const result = await search(
      grid,
      domains,
      fakeHooks(log),
      emit,
      options({ ldsLimitStart: 2 }),
    );

    expect(result.complete).toBe(true);
    expect(ofType(events, 'search:assign').map((e) => `${e.slotId}=${e.answer}`)).toEqual([
      '1A=COT',
      '1A=CAT',
      '2D=ARE',
      '4A=ARE',
      '3D=TED',
      '1D=CAB',
      '5A=BED',
    ]);
    expect(ofType(events, 'search:backtrack').map((e) => e.slotId)).toEqual(['1A']);
    expect(ofType(events, 'search:wipeout').map((e) => e.slotId)).toEqual(['2D']);
    expect(ofType(events, 'search:unassign').map((e) => `${e.slotId}=${e.answer}`)).toEqual([
      '1A=COT',
    ]);
    expect(result.backtracks).toBe(1);
    expect(result.wipeouts).toBe(1);
    expect(result.discrepancies).toBe(1);
    expect(grid.snapshot().assigned['1A']).toBe('CAT');
  });

  it('backtracks to the lowest-margin crossing assignment, not the last one', async () => {
    const { grid, domains } = loadFixture('search-backjump');
    const log = emptyLog();
    const { events, emit } = recorder();

    const result = await search(
      grid,
      domains,
      fakeHooks(log),
      emit,
      options({ ldsLimitStart: 2 }),
    );

    const backtracks = ofType(events, 'search:backtrack');
    expect(backtracks).toHaveLength(1);
    // 2D (margin 0.95) was assigned last and 1A (margin 0.40) has the lowest
    // margin on the board, but only 1D and 2D cross the wiped-out 4A.
    expect(backtracks[0]?.slotId).toBe('1D');
    expect(backtracks[0]?.margin).toBeCloseTo(0.6, 10);
    expect(backtracks[0]?.reason).toBe('wipeout');

    const assignsBeforeBacktrack = ofType(events, 'search:assign').slice(0, 3).map((e) => e.slotId);
    expect(assignsBeforeBacktrack).toEqual(['1D', '1A', '2D']);
    // The whole subtree above the target is undone, deepest first.
    expect(ofType(events, 'search:unassign').map((e) => e.slotId)).toEqual(['2D', '1A', '1D']);

    expect(result.complete).toBe(true);
    expect(grid.snapshot().assigned).toEqual({
      '1A': 'CAT',
      '4A': 'ORE',
      '5A': 'DEN',
      '1D': 'COD',
      '2D': 'ARE',
      '3D': 'TEN',
    });
  });

  it('undoes the lowest-margin assignment anywhere when the failed slot has no crossings', async () => {
    const { grid, domains } = loadFixture('search-nocross');
    const log = emptyLog();
    const { events, emit } = recorder();

    // 1A sits above a full row of blocks, so it has no crossings at all (B7).
    expect(grid.crossings('1A')).toEqual([]);

    const result = await search(
      grid,
      domains,
      fakeHooks(log),
      emit,
      options({ maxBacktracks: 1 }),
    );

    expect(log.emptyDomain).toEqual(['1A']);
    const backtracks = ofType(events, 'search:backtrack');
    expect(backtracks).toHaveLength(1);
    expect(backtracks[0]?.slotId).toBe('5A');
    expect(backtracks[0]?.margin).toBeCloseTo(0.25, 10);
    expect(result.complete).toBe(false);
    expect(result.emptySlotIds).toContain('1A');
  });

  it('counts discrepancies, abandons a branch over ldsLimit and restarts at limit + 1', async () => {
    const { grid, domains } = loadFixture('search-backtrack');
    const log = emptyLog();
    const { events, emit } = recorder();

    const result = await search(
      grid,
      domains,
      fakeHooks(log),
      emit,
      options({ ldsLimitStart: 0, ldsLimitMax: 1 }),
    );

    const restarts = ofType(events, 'lds:restart');
    expect(restarts).toHaveLength(1);
    // The first pass never got to take a discrepant value, so it used none.
    expect(restarts[0]).toEqual({ type: 'lds:restart', ldsLimit: 1, discrepanciesUsed: 0 });
    expect(result.ldsRestarts).toBe(1);
    // The second pass takes 1A's rank-1 value once, and only once.
    expect(result.discrepancies).toBe(1);
    expect(result.complete).toBe(true);
  });

  it('runs at most ldsLimitMax + 1 passes and then returns its best partial fill', async () => {
    const { grid, domains } = loadFixture('search-unsolvable');
    const log = emptyLog();
    const { events, emit } = recorder();

    const result = await search(
      grid,
      domains,
      fakeHooks(log),
      emit,
      options({ ldsLimitStart: 0, ldsLimitMax: 3 }),
    );

    // Limits 0, 1, 2, 3: four passes, so three restarts.
    expect(ofType(events, 'lds:restart').map((e) => e.ldsLimit)).toEqual([1, 2, 3]);
    expect(result.ldsRestarts).toBe(3);
    expect(result.complete).toBe(false);
    expect(grid.isComplete()).toBe(false);
    // The best partial fill reached in any pass is restored on the way out.
    expect(result.assigned).toBe(1);
    expect(grid.snapshot().assigned).toEqual({ '1A': 'CAT' });
    expect(result.emptySlotIds).toEqual(['1D', '2D', '3D', '4A', '5A']);
  });

  it('stops gracefully at maxBacktracks, charging the budget for each one', async () => {
    const { grid, domains } = loadFixture('search-unsolvable');
    const log = emptyLog();
    const { events, emit } = recorder();

    const result = await search(
      grid,
      domains,
      fakeHooks(log),
      emit,
      options({ ldsLimitStart: 0, ldsLimitMax: 10, maxBacktracks: 5 }),
    );

    expect(result.backtracks).toBe(5);
    expect(result.complete).toBe(false);
    expect(ofType(events, 'search:backtrack')).toHaveLength(5);
    expect(log.charges).toEqual(Array.from({ length: 5 }, () => ({ cap: 'backtracks', amount: 1 })));
    expect(log.terminations).toHaveLength(1);
  });

  it('ends the search when chargeBudget reports a crossed cap', async () => {
    const { grid, domains } = loadFixture('search-unsolvable');
    const log = emptyLog();
    const { emit } = recorder();

    const result = await search(
      grid,
      domains,
      fakeHooks(log, { exceedOnCharge: 1 }),
      emit,
      options({ ldsLimitStart: 0, ldsLimitMax: 10, maxBacktracks: 500 }),
    );

    expect(result.backtracks).toBe(1);
    expect(result.complete).toBe(false);
  });

  it('retries a slot when onEmptyDomain merged candidates, and backtracks when it did not', async () => {
    const merged = loadFixture('search-nocross');
    const mergedLog = emptyLog();
    const mergedEvents = recorder();

    const result = await search(
      merged.grid,
      merged.domains,
      fakeHooks(mergedLog, {
        onEmpty: (slotId) => {
          merged.domains.merge(slotId, candidatesOf([{ answer: 'TOP', score: 0.42 }]));
          return { action: 'none', reason: 'merged by the fake' };
        },
      }),
      mergedEvents.emit,
      options(),
    );

    expect(mergedLog.emptyDomain).toEqual(['1A']);
    expect(result.complete).toBe(true);
    expect(merged.grid.snapshot().assigned['1A']).toBe('TOP');
    expect(ofType(mergedEvents.events, 'search:backtrack')).toEqual([]);
    expect(mergedLog.terminations).toEqual([[]]);

    const refused = loadFixture('search-nocross');
    const refusedLog = emptyLog();
    const refusedEvents = recorder();

    const refusedResult = await search(
      refused.grid,
      refused.domains,
      fakeHooks(refusedLog, { onEmpty: () => ({ action: 'give-up', reason: 'no' }) }),
      refusedEvents.emit,
      options({ maxBacktracks: 1 }),
    );

    expect(refusedLog.emptyDomain).toEqual(['1A']);
    expect(ofType(refusedEvents.events, 'search:backtrack')).toHaveLength(1);
    expect(refusedResult.complete).toBe(false);
    expect(refusedResult.emptySlotIds).toContain('1A');
  });

  it('offers every crossing a forward check empties to onEmptyDomain (T62)', async () => {
    // 1A has a single value, so it is branched on first (a one-candidate
    // domain has the largest possible margin). Assigning it empties both 2D
    // and 3D; 1D survives. Before T62 only the first emptied crossing was
    // offered a re-ask, and the rest were abandoned to the backjump.
    const grid = new Grid(buildPuzzle('two-wipeouts', ['...', '...', '...']));
    const domains = createDomainStore();
    domains.setBase('1A', candidatesOf([{ answer: 'CAT', score: 0.99 }]));
    domains.setBase('1D', candidatesOf([
      { answer: 'CAB', score: 0.6 },
      { answer: 'CAR', score: 0.55 },
    ]));
    domains.setBase('2D', candidatesOf([
      { answer: 'BAT', score: 0.6 },
      { answer: 'BAR', score: 0.55 },
    ]));
    domains.setBase('3D', candidatesOf([
      { answer: 'BUS', score: 0.6 },
      { answer: 'BUN', score: 0.55 },
    ]));
    domains.setBase('4A', candidatesOf([
      { answer: 'ABS', score: 0.6 },
      { answer: 'ABC', score: 0.55 },
    ]));
    domains.setBase('5A', candidatesOf([
      { answer: 'RUN', score: 0.6 },
      { answer: 'RUM', score: 0.55 },
    ]));

    const log = emptyLog();
    const { events, emit } = recorder();
    const result = await search(
      grid,
      domains,
      fakeHooks(log),
      emit,
      // A single pass, so the count is the count of one forward check.
      options({ ldsLimitMax: 0 }),
    );

    expect(ofType(events, 'search:wipeout').map((e) => e.slotId)).toEqual(['2D', '3D']);
    expect(log.emptyDomain).toEqual(['2D', '3D']);
    // The first crossing that stayed empty is still the backtrack target.
    expect(ofType(events, 'search:backtrack')[0]?.reason).toBe('wipeout');
    expect(result.complete).toBe(false);
  });

  it('backjumps to an ancestor when a node runs out of values', async () => {
    const { grid, domains } = loadFixture('search-exhaust');
    const log = emptyLog();
    const { events, emit } = recorder();

    const result = await search(
      grid,
      domains,
      fakeHooks(log),
      emit,
      options({ ldsLimitStart: 3, ldsLimitMax: 3, maxBacktracks: 20 }),
    );

    // 4A is crossed only by the assigned 2D, so each wipeout lands back on 2D;
    // once 2D has no values left the target moves up to 1A, whose second value
    // then wipes 3D out and exhausts the tree.
    expect(
      ofType(events, 'search:backtrack').map((e) => `${e.slotId}:${e.reason}`),
    ).toEqual(['2D:wipeout', '2D:wipeout', '1A:values-exhausted', '1A:wipeout']);
    expect(result.complete).toBe(false);
    expect(result.backtracks).toBe(4);
    // The deepest consistent fill it ever held is what it hands back.
    expect(grid.snapshot().assigned).toEqual({ '1A': 'TOP', '2D': 'ONE' });
    expect(result.assigned).toBe(2);
  });

  it('emits forwardcheck events naming the surviving counts of every crossing', async () => {
    const { grid, domains } = loadFixture('search-backtrack');
    const log = emptyLog();
    const { events, emit } = recorder();

    await search(grid, domains, fakeHooks(log), emit, options({ ldsLimitStart: 2 }));

    const first = ofType(events, 'search:forwardcheck').slice(0, 3);
    expect(first).toEqual([
      { type: 'search:forwardcheck', slotId: '1A', crossingSlotId: '1D', before: 2, after: 2 },
      { type: 'search:forwardcheck', slotId: '1A', crossingSlotId: '2D', before: 2, after: 0 },
      { type: 'search:forwardcheck', slotId: '1A', crossingSlotId: '3D', before: 2, after: 2 },
    ]);
  });

  it('coalesces progress to at most one per 250 ms on the injected clock', async () => {
    const { grid, domains } = loadFixture('search-solvable');
    const log = emptyLog();
    const { events, emit } = recorder();

    // 100 ms per reading, so the 250 ms floor cannot be met by every tick.
    let ticks = 0;
    const now = (): number => {
      const value = ticks * 100;
      ticks += 1;
      return value;
    };

    await search(grid, domains, fakeHooks(log), emit, { ...options(), now });

    const progress = ofType(events, 'progress');
    expect(progress.length).toBeGreaterThan(2);
    // The first and last are the phase transitions; everything between them
    // has to respect the 250 ms floor (B37).
    for (let i = 1; i < progress.length - 1; i += 1) {
      const previous = progress[i - 1]?.elapsedMs ?? 0;
      const current = progress[i]?.elapsedMs ?? 0;
      expect(current - previous).toBeGreaterThanOrEqual(250);
    }
    expect(progress[0]?.elapsedMs).toBe(0);
    expect(progress[0]?.assigned).toBe(0);
    expect(progress[progress.length - 1]?.assigned).toBe(11);
    for (const event of progress) {
      expect(event.phase).toBe('search');
      expect(event.total).toBe(11);
    }
  });

  it('leaves the domain store at the depth it was handed', async () => {
    const { grid, domains } = loadFixture('search-backjump');
    const log = emptyLog();
    const { emit } = recorder();

    expect(domains.depth()).toBe(0);
    await search(grid, domains, fakeHooks(log), emit, options({ ldsLimitStart: 2 }));
    expect(domains.depth()).toBe(0);
  });

  it('calls onSearchTermination exactly once with the still-empty slots', async () => {
    const { grid, domains } = loadFixture('search-nocross');
    const log = emptyLog();
    const { emit } = recorder();

    await search(grid, domains, fakeHooks(log), emit, options({ maxBacktracks: 1 }));

    expect(log.terminations).toHaveLength(1);
    expect(log.terminations[0]).toEqual(['1A']);
  });

  it('is iterative, so a 15x15-sized search cannot blow the stack', async () => {
    // 15 wide, 15 tall, no blocks: 30 slots of length 15, each crossing 15
    // others. A recursive implementation would nest 30 frames per pass; this
    // one must simply run.
    const rows = Array.from({ length: 15 }, () => '.'.repeat(15));
    const puzzle = buildPuzzle('open-15x15', rows);
    const grid = new Grid(puzzle);
    const domains = createDomainStore();
    const letters = 'ABCDEFGHIJKLMNO';
    for (const slot of puzzle.slots) {
      // One consistent fill exists: every cell is the same letter.
      domains.setBase(
        slot.id,
        candidatesOf([
          { answer: 'A'.repeat(15), score: 0.9 },
          { answer: letters, score: 0.5 },
        ]),
      );
    }

    const result = await search(grid, domains, fakeHooks(emptyLog()), recorder().emit, options());

    expect(result.complete).toBe(true);
    expect(grid.isComplete()).toBe(true);
  });
});
