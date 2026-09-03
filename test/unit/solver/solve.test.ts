import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type {
  Candidate,
  CandidateRequest,
  CandidateResult,
  CandidateService,
} from '../../../src/candidates/types.js';
import { MIN_LEVEL } from '../../../src/events/levels.js';
import type { Emit, EmittedEvent } from '../../../src/events/types.js';
import { score as scoreFill } from '../../../src/eval/scorer.js';
import { Grid } from '../../../src/grid/model.js';
import { createDomainStore } from '../../../src/grid/domainStore.js';
import type { DomainStore, GridSnapshot } from '../../../src/grid/types.js';
import type { EscalationDecision } from '../../../src/policy/types.js';
import { ProfileObject, type Profile } from '../../../src/profiles/schema.js';
import type { NormalisedPuzzleFile, Puzzle } from '../../../src/puzzle/types.js';
import type { WordList } from '../../../src/validate/types.js';
import { solve, type SolveOrchestrationDeps } from '../../../src/solver/solve.js';
import type {
  Ac3Fn,
  RepairFn,
  SearchFn,
  SearchHooks,
  SolveFn,
  SolveOptions,
} from '../../../src/solver/types.js';

/**
 * T44. The orchestration is composed entirely through `SolveDeps`, so every
 * collaborator here is a fake: the point of these tests is the order of the
 * phases and of the level-0 events, the budget and error behaviour, and the
 * fact that step 8 always runs - never the behaviour of AC-3, the search or
 * the repair pass, which have their own suites.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_ROOT = new URL('../../fixtures/', import.meta.url);

interface DomainFixture {
  description: string;
  puzzle: string;
  domains: Record<string, Array<{ answer: string; score: number }>>;
}

function readPuzzle(name: string): NormalisedPuzzleFile {
  const path = fileURLToPath(new URL(`puzzles/${name}.json`, FIXTURE_ROOT));
  return JSON.parse(readFileSync(path, 'utf8')) as NormalisedPuzzleFile;
}

function readDomains(name: string): DomainFixture {
  const path = fileURLToPath(new URL(`domains/${name}.json`, FIXTURE_ROOT));
  return JSON.parse(readFileSync(path, 'utf8')) as DomainFixture;
}

/** B11's `stripSolution`, inlined so the test pulls in no loader adapters. */
function withoutSolution(file: NormalisedPuzzleFile): Puzzle {
  const { solution: _solution, ...rest } = file;
  return rest;
}

const PUZZLE_FILE = readPuzzle('synthetic-5x5');
const PUZZLE: Puzzle = withoutSolution(PUZZLE_FILE);
const DOMAINS = readDomains('search-solvable').domains;

function candidatesFor(slotId: string): Candidate[] {
  return (DOMAINS[slotId] ?? []).map((entry, rank) => ({
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

function profileWith(overrides: Record<string, unknown> = {}): Profile {
  return ProfileObject.parse({ name: 'test', ...overrides });
}

function optionsWith(overrides: Partial<SolveOptions> = {}): SolveOptions {
  return {
    runId: 'run-1',
    puzzleId: PUZZLE.id,
    repeatIndex: 0,
    seed: 7,
    offline: false,
    offlineLenient: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Events as recorded, plus the two fields T44 adds ahead of the contract.
 * Written as a union of intersections (rather than `EmittedEvent & {...}`) so
 * narrowing on `type` keeps working.
 */
type Recorded = {
  [K in EmittedEvent['type']]: Extract<EmittedEvent, { type: K }> & {
    skipped?: boolean;
    error?: string;
  };
}[EmittedEvent['type']];

interface FakeService extends CandidateService {
  singleCalls: CandidateRequest[];
  batchCalls: CandidateRequest[][];
}

function fakeService(opts: { empty?: ReadonlySet<string> } = {}): FakeService {
  const empty = opts.empty ?? new Set<string>();
  const result = (slotId: string): CandidateResult => ({
    candidates: empty.has(slotId) ? [] : candidatesFor(slotId),
    clueUnderstood: 0.9,
    cacheHit: false,
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
  });
  const service: FakeService = {
    singleCalls: [],
    batchCalls: [],
    getCandidates(req): Promise<CandidateResult> {
      service.singleCalls.push(req);
      return Promise.resolve(result(req.slotId));
    },
    getCandidatesBatch(reqs): Promise<Map<string, CandidateResult>> {
      service.batchCalls.push([...reqs]);
      return Promise.resolve(new Map(reqs.map((req) => [req.slotId, result(req.slotId)])));
    },
    peek(slotId): Candidate[] {
      return candidatesFor(slotId);
    },
  };
  return service;
}

interface FakeHooks extends SearchHooks {
  candidatesReturned: string[];
  charges: Array<{ cap: string; amount: number }>;
}

function fakeHooks(): FakeHooks {
  const none: EscalationDecision = { action: 'none', reason: 'fake' };
  const hooks: FakeHooks = {
    candidatesReturned: [],
    charges: [],
    onEmptyDomain(): Promise<EscalationDecision> {
      return Promise.resolve(none);
    },
    onCandidatesReturned(slotId): Promise<EscalationDecision> {
      hooks.candidatesReturned.push(slotId);
      return Promise.resolve(none);
    },
    onSearchTermination(emptySlotIds): Promise<EscalationDecision[]> {
      return Promise.resolve(emptySlotIds.map(() => none));
    },
    chargeBudget(cap, amount): { exceeded: null } {
      hooks.charges.push({ cap, amount });
      return { exceeded: null };
    },
  };
  return hooks;
}

const NULL_WORDLIST: WordList = {
  has: () => false,
  score: () => 0,
  match: () => [],
  loaded: false,
};

/** Assigns each slot's best candidate, which for this fixture is the solution. */
function greedySearch(limitTo?: number): SearchFn {
  return (grid, domains, _hooks, emit) => {
    const ids = [...grid.slots.keys()];
    const chosen = limitTo === undefined ? ids : ids.slice(0, limitTo);
    for (const slotId of chosen) {
      const best = domains.get(slotId)[0];
      if (best === undefined) continue;
      grid.assign(slotId, best.answer);
      emit({
        type: 'search:assign',
        slotId,
        answer: best.answer,
        score: best.score,
        margin: best.score,
        tier: 1,
        producedBy: 'tier1',
      });
    }
    const emptySlotIds = ids.filter((id) => grid.assignmentOf(id) === undefined);
    return Promise.resolve({
      complete: emptySlotIds.length === 0,
      assigned: ids.length - emptySlotIds.length,
      backtracks: 0,
      discrepancies: 0,
      wipeouts: 0,
      ldsRestarts: 0,
      emptySlotIds,
    });
  };
}

const noopAc3: Ac3Fn = () => ({ arcsVisited: 4, reductions: 1, wipeouts: [] });

interface FakeRepair {
  fn: RepairFn;
  calls: number;
}

function fakeRepair(): FakeRepair {
  const state: FakeRepair = {
    calls: 0,
    fn: () => {
      state.calls += 1;
      return Promise.resolve({ proposals: 2, accepted: 1, callsUsed: 3 });
    },
  };
  return state;
}

interface Harness {
  deps: SolveOrchestrationDeps;
  events: Recorded[];
  grid: Grid;
  domains: DomainStore;
  service: FakeService;
  hooks: FakeHooks;
  repair: FakeRepair;
  scoreCalls: GridSnapshot[];
}

function harness(overrides: Partial<SolveOrchestrationDeps> = {}): Harness {
  const events: Recorded[] = [];
  const emit: Emit = (event) => {
    events.push(event);
  };
  const grid = new Grid(PUZZLE);
  const domains = createDomainStore();
  const service = fakeService();
  const hooks = fakeHooks();
  const repair = fakeRepair();
  const scoreCalls: GridSnapshot[] = [];
  const deps: SolveOrchestrationDeps = {
    grid,
    domains,
    service,
    hooks,
    wordList: NULL_WORDLIST,
    ac3: noopAc3,
    search: greedySearch(),
    repair: repair.fn,
    emit,
    score: (snapshot) => {
      scoreCalls.push(snapshot);
      return scoreFill(snapshot, PUZZLE_FILE.solution, PUZZLE.slots);
    },
    puzzle: PUZZLE,
    // A clock that never advances keeps the 250 ms progress rule (B37) from
    // adding events the ordered assertions would have to guess at.
    now: () => 1_000,
    ...overrides,
  };
  return { deps, events, grid, domains, service, hooks, repair, scoreCalls };
}

function typesOf(events: readonly Recorded[]): string[] {
  return events.map((event) => event.type);
}

function levelZero(events: readonly Recorded[]): Recorded[] {
  return events.filter((event) => MIN_LEVEL[event.type] === 0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('solve', () => {
  it('is assignable to the frozen SolveFn contract', () => {
    const fn: SolveFn = solve;
    expect(typeof fn).toBe('function');
  });

  it('emits the five phases in order and the level-0 events in the spec order (acceptance 1)', async () => {
    const h = harness();
    await solve(h.deps, profileWith(), optionsWith());

    const phases = h.events
      .filter((event) => event.type === 'phase:start')
      .map((event) => event.phase);
    expect(phases).toEqual(['seed', 'prepass', 'search', 'repair', 'score']);

    expect(typesOf(levelZero(h.events))).toEqual([
      'run:start',
      'grid:init',
      'phase:start',
      'progress',
      'phase:end',
      'phase:start',
      'progress',
      'phase:end',
      'phase:start',
      'progress',
      'phase:end',
      'phase:start',
      'progress',
      'phase:end',
      'phase:start',
      'progress',
      'score:final',
      'cost:summary',
      'grid:final',
      'phase:end',
      'run:end',
    ]);
  });

  it('emits grid:init exactly once, right after run:start, matching the fixture (acceptance 2)', async () => {
    const h = harness();
    await solve(h.deps, profileWith(), optionsWith());

    const inits = h.events.filter((event) => event.type === 'grid:init');
    expect(inits).toHaveLength(1);
    expect(typesOf(h.events).slice(0, 2)).toEqual(['run:start', 'grid:init']);

    const init = inits[0];
    if (init?.type !== 'grid:init') throw new Error('grid:init missing');
    expect(init.width).toBe(5);
    expect(init.height).toBe(5);
    expect(init.blocks).toEqual(PUZZLE.cells.map((row) => row.map((cell) => cell.block)));
    expect(init.numbers).toEqual(PUZZLE.cells.map((row) => row.map((cell) => cell.number ?? null)));
    expect(init.slots).toEqual(
      PUZZLE.slots.map((slot) => ({
        id: slot.id,
        row: slot.row,
        col: slot.col,
        length: slot.length,
        direction: slot.direction,
        clue: slot.clue,
      })),
    );
  });

  it('derives grid:init from the slots when no puzzle is injected', async () => {
    const h = harness({ puzzle: undefined });
    await solve(h.deps, profileWith(), optionsWith());

    const init = h.events.find((event) => event.type === 'grid:init');
    if (init?.type !== 'grid:init') throw new Error('grid:init missing');
    // Every white cell of the synthetic 5x5 belongs to a slot, so the derived
    // block map is exact for it.
    expect(init.blocks).toEqual(PUZZLE.cells.map((row) => row.map((cell) => cell.block)));
    expect(init.numbers).toEqual(PUZZLE.cells.map((row) => row.map((cell) => cell.number ?? null)));
  });

  it('ends the search phase on a budget hit and still runs repair and score (acceptance 3)', async () => {
    const h = harness();
    // T38's hooks emit `budget:hit`; T37 ends its phase and returns its best
    // partial fill. The fake does both.
    h.deps.search = (grid, domains, _hooks, emit) => {
      const first = [...grid.slots.keys()][0];
      if (first !== undefined) {
        const best = domains.get(first)[0];
        if (best !== undefined) grid.assign(first, best.answer);
      }
      emit({ type: 'budget:hit', cap: 'usd', limit: 0.5, actual: 0.6 });
      const emptySlotIds = [...grid.slots.keys()].filter(
        (id) => grid.assignmentOf(id) === undefined,
      );
      return Promise.resolve({
        complete: false,
        assigned: 1,
        backtracks: 0,
        discrepancies: 0,
        wipeouts: 0,
        ldsRestarts: 0,
        emptySlotIds,
      });
    };

    const result = await solve(h.deps, profileWith(), optionsWith());

    const order = typesOf(h.events);
    const hitAt = order.indexOf('budget:hit');
    expect(hitAt).toBeGreaterThan(-1);
    const searchEndAt = h.events.findIndex(
      (event) => event.type === 'phase:end' && event.phase === 'search',
    );
    expect(searchEndAt).toBeGreaterThan(hitAt);

    const phasesAfter = h.events
      .slice(searchEndAt)
      .filter((event) => event.type === 'phase:start')
      .map((event) => event.phase);
    expect(phasesAfter).toEqual(['repair', 'score']);
    expect(h.repair.calls).toBe(1);
    expect(h.scoreCalls).toHaveLength(1);
    expect(result.status).toBe('partial');

    const end = h.events.at(-1);
    if (end?.type !== 'run:end') throw new Error('run:end missing');
    expect(end.status).toBe('partial');
  });

  it('captures an error thrown by the search and still scores (acceptance 4)', async () => {
    const h = harness();
    h.deps.search = () => Promise.reject(new Error('transport exploded'));

    const result = await solve(h.deps, profileWith(), optionsWith());

    expect(result.status).toBe('error');
    expect(result.error).toBe('transport exploded');
    expect(result.errorCause).toBeInstanceOf(Error);
    // Step 8 ran: the scorer was consulted and the terminal block was emitted.
    expect(h.scoreCalls).toHaveLength(1);
    expect(typesOf(h.events)).toContain('score:final');
    expect(typesOf(h.events)).toContain('grid:final');

    const end = h.events.at(-1);
    if (end?.type !== 'run:end') throw new Error('run:end missing');
    expect(end.status).toBe('error');
    expect(end.error).toBe('transport exploded');

    // The failing phase still closed its bracket.
    const searchEvents = h.events.filter(
      (event) =>
        (event.type === 'phase:start' || event.type === 'phase:end') && event.phase === 'search',
    );
    expect(typesOf(searchEvents)).toEqual(['phase:start', 'phase:end']);
  });

  it('brackets a disabled repair phase with skipped: true and calls no repair (acceptance 5)', async () => {
    const h = harness();
    const result = await solve(h.deps, profileWith({ repair: { enabled: false } }), optionsWith());

    expect(h.repair.calls).toBe(0);
    expect(result.repair).toEqual({ proposals: 0, accepted: 0, callsUsed: 0 });

    const repairEvents = h.events.filter(
      (event) =>
        (event.type === 'phase:start' || event.type === 'phase:end') && event.phase === 'repair',
    );
    expect(typesOf(repairEvents)).toEqual(['phase:start', 'phase:end']);
    expect(repairEvents.map((event) => event.skipped)).toEqual([true, true]);

    // The phase list is the same shape as an enabled run's.
    const phases = h.events
      .filter((event) => event.type === 'phase:start')
      .map((event) => event.phase);
    expect(phases).toEqual(['seed', 'prepass', 'search', 'repair', 'score']);
  });

  it('seeds through getCandidatesBatch when batchSize > 1 (acceptance 6)', async () => {
    const h = harness();
    await solve(h.deps, profileWith({ batchSize: 3 }), optionsWith());

    expect(h.service.singleCalls).toHaveLength(0);
    expect(h.service.batchCalls).toHaveLength(1);
    expect(h.service.batchCalls[0]).toHaveLength(PUZZLE.slots.length);
    const first = h.service.batchCalls[0]?.[0];
    expect(first?.purpose).toBe('seed');
    expect(first?.tier).toBe(1);
    expect(first?.pattern).toBe('??');
    expect(first?.style).toBe(PUZZLE.style);
  });

  it('seeds with single calls when batchSize is 1', async () => {
    const h = harness();
    await solve(h.deps, profileWith(), optionsWith({ repeatIndex: 2 }));

    expect(h.service.batchCalls).toHaveLength(0);
    expect(h.service.singleCalls).toHaveLength(PUZZLE.slots.length);
    expect(h.service.singleCalls.map((req) => req.sampleIndex)).toEqual(
      PUZZLE.slots.map(() => 2),
    );
    expect(h.service.singleCalls.map((req) => req.n)).toEqual(
      PUZZLE.slots.map(() => profileWith().candidatesPerAsk),
    );
  });

  it('emits score:final with exactly the scorer output for the produced fill (acceptance 7)', async () => {
    const h = harness();
    const result = await solve(h.deps, profileWith(), optionsWith());

    const expected = scoreFill(h.grid.snapshot(), PUZZLE_FILE.solution, PUZZLE.slots);
    const final = h.events.find((event) => event.type === 'score:final');
    if (final?.type !== 'score:final') throw new Error('score:final missing');
    expect(final.accuracy).toEqual(expected);
    expect(result.accuracy).toEqual(expected);
    // The greedy fake fills the fixture's one consistent solution.
    expect(expected.perfect).toBe(true);
    expect(result.status).toBe('ok');
  });

  it('writes no stdout from any module under src/solver (acceptance 8)', () => {
    const dir = fileURLToPath(new URL('../../../src/solver/', import.meta.url));
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => readFileSync(`${dir}${name}`, 'utf8').includes('console.'));
    expect(offenders).toEqual([]);
  });

  it('puts every seed return to the escalation policy, empty domains included', async () => {
    const h = harness({ service: fakeService({ empty: new Set(['3D']) }) });
    await solve(h.deps, profileWith(), optionsWith());

    expect([...h.hooks.candidatesReturned].sort()).toEqual(
      PUZZLE.slots.map((slot) => slot.id).sort(),
    );
    expect(h.domains.sizeOf('3D')).toBe(0);
  });

  it('charges the seed calls against the budget and reports them in cost:summary', async () => {
    const h = harness();
    await solve(h.deps, profileWith(), optionsWith());

    const charged = h.hooks.charges.filter((c) => c.cap === 'tokens');
    expect(charged).toHaveLength(PUZZLE.slots.length);
    expect(charged.every((c) => c.amount === 120)).toBe(true);
    // One wall-clock observation per phase (B37's transition point).
    expect(h.hooks.charges.filter((c) => c.cap === 'wallMs')).toHaveLength(5);

    const summary = h.events.find((event) => event.type === 'cost:summary');
    if (summary?.type !== 'cost:summary') throw new Error('cost:summary missing');
    expect(summary.perTier.tier1.calls).toBe(PUZZLE.slots.length);
    expect(summary.perTier.tier1.usdBilled).toBeGreaterThan(0);
    expect(summary.perTier.tier2.calls).toBe(0);
  });

  it('prefers an injected cost tally over its own seed-only figures', async () => {
    const perTier = {
      tier1: { calls: 42, usdBilled: 1.5, usdCounterfactual: 2 },
      tier2: { calls: 1, usdBilled: 0.25, usdCounterfactual: 0.25 },
    };
    const h = harness({ costs: () => perTier });
    await solve(h.deps, profileWith(), optionsWith());

    const summary = h.events.find((event) => event.type === 'cost:summary');
    if (summary?.type !== 'cost:summary') throw new Error('cost:summary missing');
    expect(summary.perTier).toEqual(perTier);
  });

  it('fills a slot the search left unassigned from its live domain (T18 trigger 5 gap)', async () => {
    const h = harness();
    // The search returns one slot unassigned even though its domain is fine,
    // which is exactly what T37 hands back after restoring its best fill.
    h.deps.search = greedySearch(PUZZLE.slots.length - 1);

    const result = await solve(h.deps, profileWith(), optionsWith());

    const lastSlot = PUZZLE.slots[PUZZLE.slots.length - 1];
    expect(lastSlot).toBeDefined();
    if (lastSlot === undefined) throw new Error('no slots');
    expect(h.grid.assignmentOf(lastSlot.id)).toBeDefined();
    const assigns = h.events.filter(
      (event) => event.type === 'search:assign' && event.slotId === lastSlot.id,
    );
    expect(assigns).toHaveLength(1);
    expect(result.status).toBe('ok');
  });

  it('leaves a slot with no viable candidate for the repair pass', async () => {
    const h = harness({ service: fakeService({ empty: new Set(['6D']) }) });
    h.deps.search = () =>
      Promise.resolve({
        complete: false,
        assigned: 0,
        backtracks: 0,
        discrepancies: 0,
        wipeouts: 0,
        ldsRestarts: 0,
        emptySlotIds: ['6D'],
      });

    const result = await solve(h.deps, profileWith(), optionsWith());

    expect(h.grid.assignmentOf('6D')).toBeUndefined();
    expect(result.status).toBe('partial');
    expect(h.repair.calls).toBe(1);
  });

  it('passes the profile through to ac3, search and repair', async () => {
    const h = harness();
    const seen: Record<string, unknown> = {};
    h.deps.ac3 = (_grid, _domains, _emit, opts) => {
      seen['maxArcs'] = opts.maxArcs;
      return { arcsVisited: 0, reductions: 0, wipeouts: [] };
    };
    h.deps.search = (grid, domains, hooks, emit, opts) => {
      seen['search'] = opts;
      return greedySearch()(grid, domains, hooks, emit, opts);
    };
    h.deps.repair = (_grid, _service, _wordList, _emit, opts) => {
      seen['repair'] = opts;
      return Promise.resolve({ proposals: 0, accepted: 0, callsUsed: 0 });
    };

    const profile = profileWith({ search: { ordering: 'mrv', maxBacktracks: 11 } });
    await solve(h.deps, profile, optionsWith());

    expect(seen['maxArcs']).toBe(50_000);
    expect(seen['search']).toMatchObject({ ordering: 'mrv', maxBacktracks: 11 });
    expect(seen['repair']).toMatchObject({
      enabled: true,
      maxCalls: profile.repair.maxCalls,
      maxEditDistance: profile.repair.maxEditDistance,
      style: PUZZLE.style,
    });
  });
});
