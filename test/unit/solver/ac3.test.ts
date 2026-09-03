import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { Candidate } from '../../../src/candidates/types.js';
import type { Emit, EmittedEvent } from '../../../src/events/types.js';
import { createDomainStore } from '../../../src/grid/domainStore.js';
import { Grid } from '../../../src/grid/model.js';
import type { DomainStore } from '../../../src/grid/types.js';
import type { Cell, Puzzle, Slot } from '../../../src/puzzle/types.js';
import { ac3 } from '../../../src/solver/ac3.js';
import type { Ac3Fn } from '../../../src/solver/types.js';

/**
 * `ac3` widens the frozen `Ac3Result` with `suspect` and `capped`, so it stays
 * assignable to the contract `Ac3Fn` that T44 composes it through.
 */
const asContractFn: Ac3Fn = ac3;

/**
 * A fixture at `test/fixtures/domains/ac3-*.json` is a puzzle (inline, or
 * `puzzleRef` naming one of `test/fixtures/puzzles/*.json`) plus one answer
 * list per slot, best first. Scores are derived from list position so the
 * fixtures stay readable: the calibrated numbers are T13's business and AC-3
 * never reads a score.
 */
interface DomainFixture {
  name: string;
  description: string;
  puzzle?: Puzzle;
  puzzleRef?: string;
  domains: Record<string, string[]>;
}

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, 'utf8'));
}

function candidatesFor(answers: readonly string[]): Candidate[] {
  return answers.map((answer, rank) => ({
    answer,
    raw: answer,
    rank,
    selfConfidence: 1 - rank * 0.1,
    votes: 1,
    score: 1 - rank * 0.1,
    tier: 1,
    fromCache: false,
  }));
}

function loadFixture(name: string): { grid: Grid; domains: DomainStore; puzzle: Puzzle } {
  const fixture = readJson(
    new URL(`../../fixtures/domains/${name}.json`, import.meta.url),
  ) as DomainFixture;

  let puzzle = fixture.puzzle;
  if (puzzle === undefined) {
    const ref = fixture.puzzleRef;
    if (ref === undefined) throw new Error(`fixture ${name} has neither puzzle nor puzzleRef`);
    // The puzzle fixtures carry a `solution` field for the scorer (B11); the
    // `Puzzle` the solver sees structurally cannot, hence the cast.
    puzzle = readJson(new URL(`../../fixtures/puzzles/${ref}.json`, import.meta.url)) as Puzzle;
  }

  const domains = createDomainStore();
  for (const [slotId, answers] of Object.entries(fixture.domains)) {
    domains.setBase(slotId, candidatesFor(answers));
  }
  return { grid: new Grid(puzzle), domains, puzzle };
}

function recorder(): { emit: Emit; events: EmittedEvent[] } {
  const events: EmittedEvent[] = [];
  const emit: Emit = (event) => {
    events.push(event);
  };
  return { emit, events };
}

function eventsOfType<T extends EmittedEvent['type']>(
  events: readonly EmittedEvent[],
  type: T,
): Array<Extract<EmittedEvent, { type: T }>> {
  return events.filter((e): e is Extract<EmittedEvent, { type: T }> => e.type === type);
}

function answersOf(domains: DomainStore, slotId: string): string[] {
  return domains.get(slotId).map((c) => c.answer);
}

describe('ac3', () => {
  it('is assignable to the frozen Ac3Fn contract', () => {
    expect(asContractFn).toBe(ac3);
  });

  it('drops the one candidate with no support at a crossing (acceptance 1)', () => {
    const { grid, domains } = loadFixture('ac3-reducible');
    const { emit, events } = recorder();

    const result = ac3(grid, domains, emit, {});

    expect(answersOf(domains, '1A')).toEqual(['OH', 'AH']);
    expect(answersOf(domains, '1D')).toEqual(['OX', 'AX']);
    expect(answersOf(domains, '2D')).toEqual(['HI', 'HE']);
    expect(result.reductions).toBe(1);
    expect(result.wipeouts).toEqual([]);
    expect(result.suspect).toEqual([]);
    expect(result.capped).toBe(false);
    expect(eventsOfType(events, 'ac3:arc')).toHaveLength(result.arcsVisited);
  });

  it('emits ac3:reduce once per reduction with the arc and the removed answers (acceptance 2)', () => {
    const { grid, domains } = loadFixture('ac3-reducible');
    const { emit, events } = recorder();

    ac3(grid, domains, emit, {});

    expect(eventsOfType(events, 'ac3:reduce')).toEqual([
      { type: 'ac3:reduce', slotId: '1A', otherSlotId: '1D', removed: ['ZZ'] },
    ]);
  });

  it('restores the domain, marks the slot suspect and emits ac3:wipeout once (acceptance 3)', () => {
    const { grid, domains } = loadFixture('ac3-wipeout');
    const { emit, events } = recorder();

    // Three arcs leave 2D, so three revisions could each have wiped it out.
    expect(grid.crossings('2D')).toHaveLength(3);

    const result = ac3(grid, domains, emit, {});

    expect(answersOf(domains, '2D')).toEqual(['AOZ', 'OIZ']);
    expect(result.suspect).toEqual(['2D']);
    expect(result.wipeouts).toEqual(['2D']);
    expect(domains.isSuspect('2D')).toBe(true);
    expect(eventsOfType(events, 'ac3:wipeout')).toEqual([{ type: 'ac3:wipeout', slotId: '2D' }]);
  });

  it('removes every arc incident on the wiped-out slot from the worklist (acceptance 4)', () => {
    const { grid, domains } = loadFixture('ac3-wipeout');
    const { emit, events } = recorder();

    ac3(grid, domains, emit, {});

    const wipeoutAt = events.findIndex((e) => e.type === 'ac3:wipeout');
    expect(wipeoutAt).toBeGreaterThanOrEqual(0);

    const after = eventsOfType(events.slice(wipeoutAt), 'ac3:arc');
    // The prepass carried on with the arcs that do not touch 2D, so the
    // removal is targeted rather than an early stop.
    expect(after.map((e) => `${e.slotId}->${e.otherSlotId}`)).toEqual(['4A->1D', '5A->1D']);
    expect(after.some((e) => e.slotId === '2D' || e.otherSlotId === '2D')).toBe(false);
  });

  it('gives the slot with an unchecked cell fewer arcs than its length (acceptance 5)', () => {
    const { grid, domains, puzzle } = loadFixture('ac3-unchecked');
    const { emit, events } = recorder();

    // r4c1 is 2D's last cell and belongs to no across slot (B7).
    expect(grid.isChecked(4, 1)).toBe(false);

    const result = ac3(grid, domains, emit, {});

    const slot = puzzle.slots.find((s) => s.id === '2D');
    expect(slot?.length).toBe(5);
    const neighbours = new Set(
      eventsOfType(events, 'ac3:arc')
        .filter((e) => e.slotId === '2D')
        .map((e) => e.otherSlotId),
    );
    expect(neighbours.size).toBe(4);
    expect(neighbours.size).toBeLessThan(slot?.length ?? 0);

    expect(result.wipeouts).toEqual([]);
    expect(answersOf(domains, '1A')).toEqual(['OH']);
    expect(answersOf(domains, '1D')).toEqual(['ORAL']);
    expect(answersOf(domains, '2D')).toEqual(['HAVOC']);
  });

  it('is idempotent: a second pass reduces nothing and emits only ac3:arc (acceptance 6)', () => {
    const { grid, domains } = loadFixture('ac3-reducible');
    const first = recorder();
    ac3(grid, domains, first.emit, {});

    const second = recorder();
    const result = ac3(grid, domains, second.emit, {});

    expect(result.reductions).toBe(0);
    expect(result.wipeouts).toEqual([]);
    expect(new Set(second.events.map((e) => e.type))).toEqual(new Set(['ac3:arc']));
    expect(answersOf(domains, '1A')).toEqual(['OH', 'AH']);
  });

  it('terminates under the arc cap on 1,000 slots of 10 candidates (acceptance 7)', () => {
    const { grid, domains } = buildLattice(500);
    const { emit } = recorder();

    const result = ac3(grid, domains, emit, {});

    expect(grid.slots.size).toBe(1000);
    expect(result.capped).toBe(false);
    expect(result.arcsVisited).toBe(1000);
    expect(result.arcsVisited).toBeLessThan(50_000);
    // One reduction per across slot: its F..J candidates have no support.
    expect(result.reductions).toBe(500);
  });

  it('reports capped when the arc-visit cap is reached', () => {
    const { grid, domains } = loadFixture('ac3-wipeout');
    const { emit, events } = recorder();

    const result = ac3(grid, domains, emit, { maxArcs: 3 });

    expect(result.capped).toBe(true);
    expect(result.arcsVisited).toBe(3);
    expect(eventsOfType(events, 'ac3:arc')).toHaveLength(3);
  });

  it('treats maxArcs 0 as no cap, per the Ac3Options contract', () => {
    const { grid, domains } = loadFixture('ac3-wipeout');
    const { emit } = recorder();

    const result = ac3(grid, domains, emit, { maxArcs: 0 });

    expect(result.capped).toBe(false);
    expect(result.arcsVisited).toBe(10);
  });

  it('leaves an unseeded neighbour out of the reasoning rather than wiping the slot', () => {
    const { grid, domains } = loadFixture('ac3-reducible');
    // Step 2 puts a slot that is empty after validation onto the escalation
    // queue; it must not take its neighbours down with it here.
    domains.setBase('2D', []);
    const { emit, events } = recorder();

    const result = ac3(grid, domains, emit, {});

    expect(result.wipeouts).toEqual([]);
    expect(answersOf(domains, '1A')).toEqual(['OH', 'AH']);
    expect(eventsOfType(events, 'ac3:arc').some((e) => e.otherSlotId === '2D')).toBe(true);
  });

  it('requeues the arcs into a slot whose domain shrank', () => {
    // Same geometry as the wipeout fixture, consistent domains except for
    // 1D's "CDQ", which arc (1D,5A) drops long after arc (1A,1D) has been
    // processed. That reduction has to put (1A,1D) back on the worklist.
    const { grid, domains } = loadFixture('ac3-wipeout');
    domains.setBase('1A', candidatesFor(['CAT']));
    domains.setBase('1D', candidatesFor(['CDP', 'CDQ']));
    domains.setBase('2D', candidatesFor(['AOI']));
    domains.setBase('4A', candidatesFor(['DOG']));
    domains.setBase('5A', candidatesFor(['PIE']));

    const { emit, events } = recorder();
    const result = ac3(grid, domains, emit, {});

    expect(result.reductions).toBe(1);
    expect(result.wipeouts).toEqual([]);
    expect(answersOf(domains, '1D')).toEqual(['CDP']);

    const arcs = eventsOfType(events, 'ac3:arc').map((e) => `${e.slotId}->${e.otherSlotId}`);
    expect(arcs.filter((a) => a === '1A->1D')).toHaveLength(2);
    expect(arcs.lastIndexOf('1A->1D')).toBeGreaterThan(arcs.indexOf('1D->5A'));
  });

  it('ignores a slot with no crossings (B7)', () => {
    const puzzle = latticePuzzle(1);
    const lone: Slot = {
      id: '99A',
      number: 99,
      direction: 'across',
      row: 3,
      col: 0,
      length: 3,
      clue: 'No crossings at all',
      cells: [
        [3, 0],
        [3, 1],
        [3, 2],
      ],
    };
    puzzle.slots.push(lone);
    const grid = new Grid(puzzle);
    const domains = createDomainStore();
    domains.setBase('99A', candidatesFor(['ZZZ']));
    const { emit, events } = recorder();

    const result = ac3(grid, domains, emit, {});

    expect(grid.crossings('99A')).toEqual([]);
    expect(eventsOfType(events, 'ac3:arc').some((e) => e.slotId === '99A')).toBe(false);
    expect(answersOf(domains, '99A')).toEqual(['ZZZ']);
    expect(result.wipeouts).toEqual([]);
  });
});

/**
 * `units` independent plus-shaped crosses on a 4-cell pitch: each unit is one
 * across slot and one down slot sharing their middle cell, so 500 units give
 * the 1,000 slots acceptance 7 asks for without a 500x500 grid of cells.
 */
function latticePuzzle(units: number): Puzzle {
  const cols = 25;
  const rows = Math.ceil(units / cols);
  const width = cols * 4;
  const height = rows * 4;

  const cells: Cell[][] = [];
  for (let row = 0; row < height; row += 1) {
    const line: Cell[] = [];
    for (let col = 0; col < width; col += 1) line.push({ row, col, block: false });
    cells.push(line);
  }

  const slots: Slot[] = [];
  for (let unit = 0; unit < units; unit += 1) {
    const baseRow = Math.floor(unit / cols) * 4;
    const baseCol = (unit % cols) * 4;
    slots.push({
      id: `${unit + 1}A`,
      number: unit + 1,
      direction: 'across',
      row: baseRow + 1,
      col: baseCol,
      length: 3,
      clue: `across ${unit}`,
      cells: [
        [baseRow + 1, baseCol],
        [baseRow + 1, baseCol + 1],
        [baseRow + 1, baseCol + 2],
      ],
    });
    slots.push({
      id: `${unit + 1}D`,
      number: unit + 1,
      direction: 'down',
      row: baseRow,
      col: baseCol + 1,
      length: 3,
      clue: `down ${unit}`,
      cells: [
        [baseRow, baseCol + 1],
        [baseRow + 1, baseCol + 1],
        [baseRow + 2, baseCol + 1],
      ],
    });
  }

  return {
    id: 'ac3-lattice',
    source: 'synthetic',
    style: 'american',
    width,
    height,
    cells,
    slots,
    parsedBy: 'xd-crossword-tools',
  };
}

/**
 * The lattice plus ten candidates per slot. Every candidate is `X<middle>X`
 * and the shared cell is each slot's middle, so the across candidates whose
 * middle is F..J have no support and the prepass has real work to do.
 */
function buildLattice(units: number): { grid: Grid; domains: DomainStore } {
  const puzzle = latticePuzzle(units);
  const grid = new Grid(puzzle);
  const domains = createDomainStore();
  // The down middles cover A..E only, so five of every across slot's ten
  // candidates lose their support; the outer letters keep the answers distinct
  // (the store dedupes by answer) and sit on unchecked cells.
  const acrossMiddles = 'ABCDEFGHIJ';
  const downMiddles = 'ABCDEABCDE';
  for (const slot of puzzle.slots) {
    const across = slot.direction === 'across';
    const middles = across ? acrossMiddles : downMiddles;
    const answers: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const outer = across ? 'X' : i < 5 ? 'P' : 'Q';
      answers.push(`${outer}${middles[i] ?? 'A'}${outer}`);
    }
    domains.setBase(slot.id, candidatesFor(answers));
  }
  return { grid, domains };
}
