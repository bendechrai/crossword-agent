import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  Candidate,
  CandidateRequest,
  CandidateResult,
  CandidateService,
} from '../../../src/candidates/types.js';
import type { EmittedEvent, SolverEventType } from '../../../src/events/types.js';
import { Grid } from '../../../src/grid/model.js';
import { patternMatches } from '../../../src/grid/pattern.js';
import type { Cell, Puzzle, Slot } from '../../../src/puzzle/types.js';
import { log } from '../../../src/util/log.js';
import type { WordList } from '../../../src/validate/types.js';
import { repair } from '../../../src/solver/repair.js';
import type { RepairFn, RepairOptions } from '../../../src/solver/types.js';

/**
 * T42. The repair pass is exercised against `test/fixtures/domains/repair-*.json`
 * with a fake `CandidateService` (T34 owns the real one) and a hand-rolled
 * `WordList` (T43 owns the real one, and lands in this same batch, so this
 * file codes against the interface in `src/validate/types.ts` only).
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FixtureCandidate {
  answer: string;
  score: number;
}

interface RepairFixture {
  description: string;
  /** Rows of `.` (white) and `#` (block). */
  grid: string[];
  /** The fill the search left behind: slotId -> answer. */
  fill: Record<string, string>;
  /** The `peek` ledger (B43): slotId -> every candidate ever returned. */
  peek: Record<string, FixtureCandidate[]>;
  /** Word -> score, for the fixtures that need a loaded word list. */
  wordlist?: Record<string, number>;
  /** The correct grid, where the fixture has one. */
  solution?: string[];
}

const FIXTURE_ROOT = new URL('../../fixtures/', import.meta.url);

function readFixture(name: string): RepairFixture {
  const path = fileURLToPath(new URL(`domains/${name}.json`, FIXTURE_ROOT));
  return JSON.parse(readFileSync(path, 'utf8')) as RepairFixture;
}

/**
 * Numbering and slot extraction from a `.`/`#` grid, the same helper
 * `test/unit/solver/search.test.ts` uses, so a fixture can carry a tiny
 * purpose-built grid instead of a whole normalised puzzle file (B19).
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

function candidateOf(entry: FixtureCandidate, rank: number): Candidate {
  return {
    answer: entry.answer,
    raw: entry.answer,
    rank,
    selfConfidence: entry.score,
    votes: 1,
    score: entry.score,
    tier: 1,
    fromCache: false,
  };
}

interface LoadedFixture {
  fixture: RepairFixture;
  grid: Grid;
  ledger: Map<string, Candidate[]>;
}

function loadFixture(name: string): LoadedFixture {
  const fixture = readFixture(name);
  const grid = new Grid(buildPuzzle(name, fixture.grid));
  for (const [slotId, answer] of Object.entries(fixture.fill)) grid.assign(slotId, answer);

  const ledger = new Map<string, Candidate[]>();
  for (const [slotId, entries] of Object.entries(fixture.peek)) {
    ledger.set(slotId, entries.map(candidateOf));
  }
  return { fixture, grid, ledger };
}

function rowsOf(grid: Grid): string[] {
  return grid.snapshot().letters.map((row) => row.map((letter) => letter ?? '.').join(''));
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A stand-in for T34's service. `getCandidates` answers from a script keyed
 * `slotId:answer`; anything unscripted comes back with no candidates, which is
 * the model saying "that word does not answer this clue". Everything it
 * returns joins the ledger, exactly as the real service's does (B43).
 */
interface FakeService extends CandidateService {
  readonly requests: CandidateRequest[];
}

function fakeService(
  ledger: Map<string, Candidate[]>,
  script: Record<string, number> = {},
): FakeService {
  const requests: CandidateRequest[] = [];
  return {
    requests,
    getCandidates(req: CandidateRequest): Promise<CandidateResult> {
      requests.push(req);
      const score = script[`${req.slotId}:${req.pattern}`];
      const candidates: Candidate[] =
        score === undefined ? [] : [candidateOf({ answer: req.pattern, score }, 0)];
      const known = ledger.get(req.slotId) ?? [];
      ledger.set(req.slotId, [
        ...known,
        ...candidates.filter((c) => !known.some((k) => k.answer === c.answer)),
      ]);
      return Promise.resolve({ candidates, clueUnderstood: 1, cacheHit: false });
    },
    getCandidatesBatch(): Promise<Map<string, CandidateResult>> {
      // B3: batching applies to `purpose: "seed"` only, and the real service
      // throws for anything else, so repair must never reach it.
      return Promise.reject(new Error('repair must not batch'));
    },
    peek(slotId: string): Candidate[] {
      return (ledger.get(slotId) ?? []).map((candidate) => ({ ...candidate }));
    },
  };
}

/** B35's null object: the word-list arm of the gate is disabled. */
function nullWordList(): WordList {
  return {
    loaded: false,
    has: () => false,
    score: () => 0,
    match: () => [],
  };
}

function fakeWordList(words: Record<string, number>): WordList {
  const entries = Object.entries(words);
  return {
    loaded: true,
    has: (w: string) => Object.hasOwn(words, w),
    score: (w: string) => words[w] ?? 0,
    match: (pattern: string, limit: number) =>
      entries
        .filter(([word]) => word.length === pattern.length && patternMatches(pattern, word))
        .sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]))
        .slice(0, limit)
        .map(([word]) => word),
  };
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

function options(overrides: Partial<RepairOptions> = {}): RepairOptions {
  return { enabled: true, maxCalls: 30, maxEditDistance: 1, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

describe('repair', () => {
  it('satisfies the RepairFn contract declared in T0', () => {
    const asContract: RepairFn = repair;
    expect(typeof asContract).toBe('function');
  });

  it('is a no-op when the profile disables it', async () => {
    const { grid, ledger } = loadFixture('repair-onefix');
    const service = fakeService(ledger);
    const { events, emit } = recorder();

    const result = await repair(grid, service, nullWordList(), emit, options({ enabled: false }));

    expect(result).toEqual({ proposals: 0, accepted: 0, callsUsed: 0 });
    expect(service.requests).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  // Acceptance 1
  it('proposes, gates through peek and accepts the distance-1 edit that fixes the fill', async () => {
    const { fixture, grid, ledger } = loadFixture('repair-onefix');
    const service = fakeService(ledger, { '1A:CAT': 0.9, '1A:COT': 0.6, '2D:ORE': 0.6 });
    const { events, emit } = recorder();

    const result = await repair(grid, service, nullWordList(), emit, options());

    expect(rowsOf(grid)).toEqual(fixture.solution);
    expect(result.accepted).toBe(1);
    expect(grid.assignmentOf('1A')).toBe('CAT');
    expect(grid.assignmentOf('2D')).toBe('ARE');

    // Round 1 finds the fix; round 2 re-proposes the undo from both sides and
    // rejects it on score, which is what makes the pass terminate.
    const proposed = ofType(events, 'repair:propose').filter((e) => e.gate !== 'none');
    expect(proposed.map((e) => [e.slotId, e.before, e.after, e.gate])).toEqual([
      ['1A', 'COT', 'CAT', 'peek'],
      ['1A', 'CAT', 'COT', 'peek'],
      ['2D', 'ARE', 'ORE', 'peek'],
    ]);

    // Both slots the edit touches are reported, so a renderer redraws both.
    expect(ofType(events, 'repair:accept')).toEqual([
      {
        type: 'repair:accept',
        slotId: '1A',
        before: 'COT',
        after: 'CAT',
        editDistance: 1,
        tier: 1,
        producedBy: 'tier1',
      },
      {
        type: 'repair:accept',
        slotId: '2D',
        before: 'ORE',
        after: 'ARE',
        editDistance: 1,
        tier: 1,
        producedBy: 'tier1',
      },
    ]);

    // Every scoring call is a tier-1 repair ask for the anchor slot, carrying
    // the proposed word as a fully fixed pattern.
    expect(service.requests.map((r) => [r.slotId, r.pattern, r.purpose, r.tier])).toEqual([
      ['1A', 'CAT', 'repair', 1],
      ['1A', 'COT', 'repair', 1],
      ['2D', 'ORE', 'repair', 1],
    ]);
    expect(result.callsUsed).toBe(3);
  });

  // Acceptance 2
  it('rejects a proposal that fails both arms of the gate before any service call', async () => {
    const { fixture, grid, ledger } = loadFixture('repair-nogate');
    const service = fakeService(ledger);
    const { events, emit } = recorder();

    const result = await repair(
      grid,
      service,
      fakeWordList(fixture.wordlist ?? {}),
      emit,
      options(),
    );

    expect(service.requests).toHaveLength(0);
    expect(result.callsUsed).toBe(0);
    expect(result.accepted).toBe(0);
    expect(result.proposals).toBeGreaterThan(0);

    const rejects = ofType(events, 'repair:reject');
    expect(rejects).toHaveLength(result.proposals);
    expect(rejects.every((e) => e.gate === 'plausibility')).toBe(true);
    expect(ofType(events, 'repair:propose').every((e) => e.gate === 'none')).toBe(true);
    // The fill it was handed is the fill it hands back.
    expect(rowsOf(grid)).toEqual(['COT', 'ARE', 'BED']);
  });

  // Acceptance 3
  it('still rejects with the word list absent, and warns exactly once per run', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const { grid, ledger } = loadFixture('repair-nogate');
    const service = fakeService(ledger);
    const { events, emit } = recorder();

    const result = await repair(grid, service, nullWordList(), emit, options());

    expect(service.requests).toHaveLength(0);
    expect(result.accepted).toBe(0);
    expect(ofType(events, 'repair:reject').every((e) => e.gate === 'plausibility')).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('no word list loaded');
  });

  // Acceptance 4
  it('stops at maxCalls, checked before the call rather than after', async () => {
    const { grid, ledger } = loadFixture('repair-onefix');
    const service = fakeService(ledger, { '1A:CAT': 0.9, '1A:COT': 0.6, '2D:ORE': 0.6 });
    const { emit } = recorder();

    const result = await repair(grid, service, nullWordList(), emit, options({ maxCalls: 1 }));

    expect(result.callsUsed).toBe(1);
    expect(result.accepted).toBe(1);
    expect(service.requests).toHaveLength(1);
    expect(grid.assignmentOf('1A')).toBe('CAT');
  });

  it('ends its own phase when the budget reports the repairCalls cap', async () => {
    const { grid, ledger } = loadFixture('repair-onefix');
    const service = fakeService(ledger, { '1A:CAT': 0.9 });
    const { emit } = recorder();
    const charges: Array<{ cap: string; amount: number }> = [];

    const result = await repair(grid, service, nullWordList(), emit, {
      ...options(),
      chargeBudget: (cap, amount) => {
        charges.push({ cap, amount });
        return { exceeded: charges.length >= 2 ? cap : null };
      },
    });

    expect(charges).toEqual([
      { cap: 'repairCalls', amount: 1 },
      { cap: 'repairCalls', amount: 1 },
    ]);
    expect(result.callsUsed).toBe(1);
    expect(service.requests).toHaveLength(1);
  });

  // Acceptance 5
  it('rejects a tie and terminates with a bounded proposal count', async () => {
    const { grid, ledger } = loadFixture('repair-tie');
    const service = fakeService(ledger, { '1A:CAT': 0.6, '2D:ARE': 0.6 });
    const { events, emit } = recorder();

    const result = await repair(grid, service, nullWordList(), emit, options());

    expect(result.accepted).toBe(0);
    expect(rowsOf(grid)).toEqual(['COT', 'ARE', 'BED']);
    // One pass over 9 cells x 2 anchors x 25 letters, and no second round,
    // because nothing was accepted.
    expect(result.proposals).toBe(450);

    const scoreRejects = ofType(events, 'repair:reject').filter((e) => e.gate === 'score');
    expect(scoreRejects.map((e) => [e.slotId, e.after])).toEqual([
      ['1A', 'CAT'],
      ['2D', 'ARE'],
    ]);
    expect(scoreRejects[0]?.reason).toContain('does not improve');
  });

  // Acceptance 6
  it('exhausts every distance-1 proposal before considering a distance-2 one', async () => {
    const { grid, ledger } = loadFixture('repair-distance2');
    const service = fakeService(ledger);
    const { events, emit } = recorder();

    const result = await repair(
      grid,
      service,
      nullWordList(),
      emit,
      options({ maxEditDistance: 2 }),
    );

    expect(result.accepted).toBe(0);
    const distances = ofType(events, 'repair:propose').map((e) => e.editDistance);
    expect(distances).toContain(1);
    expect(distances).toContain(2);
    expect(distances.lastIndexOf(1)).toBeLessThan(distances.indexOf(2));

    // Three distance-1 proposals (one per offset of 1A) then three distance-2
    // ones (one per pair of offsets), each costing exactly one call.
    expect(service.requests.map((r) => r.pattern)).toEqual([
      'DOT',
      'CAT',
      'COR',
      'DAT',
      'DOR',
      'CAR',
    ]);
    expect(result.callsUsed).toBe(6);
  });

  // Acceptance 7
  it('fills a still-empty slot with the best word-list match', async () => {
    const { fixture, grid, ledger } = loadFixture('repair-empty');
    const service = fakeService(ledger);
    const { events, emit } = recorder();

    const result = await repair(
      grid,
      service,
      fakeWordList(fixture.wordlist ?? {}),
      emit,
      options(),
    );

    expect(service.requests).toHaveLength(0);
    expect(grid.isComplete()).toBe(true);
    expect(rowsOf(grid)).toEqual(['COT', 'ARE', 'BED']);
    expect(result.accepted).toBe(2);

    // "?OT" matches COT (0.8) and HOT (0.5); the higher-scoring one wins.
    expect(ofType(events, 'repair:accept')).toEqual([
      {
        type: 'repair:accept',
        slotId: '1A',
        before: '?OT',
        after: 'COT',
        editDistance: 1,
        tier: 'wordlist',
        producedBy: 'wordlist',
      },
      {
        type: 'repair:accept',
        slotId: '1D',
        before: 'CAB',
        after: 'CAB',
        editDistance: 0,
        tier: 'wordlist',
        producedBy: 'wordlist',
      },
    ]);
  });

  it('leaves an empty slot blank when no word list is loaded, warning once', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const { grid, ledger } = loadFixture('repair-empty');
    const service = fakeService(ledger);
    const { events, emit } = recorder();

    const result = await repair(grid, service, nullWordList(), emit, options());

    expect(grid.assignmentOf('1A')).toBeUndefined();
    expect(grid.isComplete()).toBe(false);
    expect(result.accepted).toBe(0);
    expect(ofType(events, 'repair:accept')).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // Acceptance 8
  it('gates on the word list alone for a slot with no crossings', async () => {
    const { fixture, grid, ledger } = loadFixture('repair-nocross');
    const service = fakeService(ledger, { '1A:COT': 0.9, '1A:CAT': 0.5 });
    const { events, emit } = recorder();

    expect(grid.crossings('1A')).toEqual([]);

    const result = await repair(
      grid,
      service,
      fakeWordList(fixture.wordlist ?? {}),
      emit,
      options({ maxEditDistance: 2 }),
    );

    expect(grid.assignmentOf('1A')).toBe('COT');
    expect(result.accepted).toBe(1);

    const passed = ofType(events, 'repair:propose').filter((e) => e.gate !== 'none');
    expect(passed.map((e) => [e.slotId, e.after, e.gate])).toEqual([
      ['1A', 'COT', 'wordlist'],
      ['1A', 'CAT', 'wordlist'],
    ]);
    expect(ofType(events, 'repair:accept')).toEqual([
      {
        type: 'repair:accept',
        slotId: '1A',
        before: 'CAT',
        after: 'COT',
        editDistance: 1,
        tier: 1,
        producedBy: 'tier1',
      },
    ]);
  });
});
