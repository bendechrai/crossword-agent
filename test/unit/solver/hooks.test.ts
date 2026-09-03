import { describe, expect, it } from 'vitest';

import type {
  Candidate,
  CandidateRequest,
  CandidateResult,
  CandidateService,
} from '../../../src/candidates/types.js';
import type { Emit, EmittedEvent } from '../../../src/events/types.js';
import { createDomainStore } from '../../../src/grid/domainStore.js';
import { Grid } from '../../../src/grid/model.js';
import type { DomainStore } from '../../../src/grid/types.js';
import { createBudgetTracker, resolveBudget } from '../../../src/policy/budget.js';
import type { BudgetTracker } from '../../../src/policy/budget.js';
import { decide as realDecide } from '../../../src/policy/escalation.js';
import type { EscalationContext, EscalationDecision } from '../../../src/policy/types.js';
import { ProfileSchema } from '../../../src/profiles/schema.js';
import type { Profile, ProfileInput } from '../../../src/profiles/schema.js';
import type { Cell, Puzzle, Slot } from '../../../src/puzzle/types.js';
import { createSearchHooks } from '../../../src/solver/hooks.js';

/**
 * A 3x3 all-open grid: three across slots and three down slots, so every cell
 * is checked and every slot has crossings for the escalation context.
 */
function makeGrid(): Grid {
  const cells: Cell[][] = [0, 1, 2].map((row) =>
    [0, 1, 2].map((col) => ({ row, col, block: false })),
  );
  const slots: Slot[] = [
    {
      id: '1A',
      number: 1,
      direction: 'across',
      row: 0,
      col: 0,
      length: 3,
      clue: 'Across one',
      cells: [
        [0, 0],
        [0, 1],
        [0, 2],
      ],
    },
    {
      id: '4A',
      number: 4,
      direction: 'across',
      row: 1,
      col: 0,
      length: 3,
      clue: 'Across four',
      cells: [
        [1, 0],
        [1, 1],
        [1, 2],
      ],
    },
    {
      id: '6A',
      number: 6,
      direction: 'across',
      row: 2,
      col: 0,
      length: 3,
      clue: 'Across six',
      cells: [
        [2, 0],
        [2, 1],
        [2, 2],
      ],
    },
    {
      id: '1D',
      number: 1,
      direction: 'down',
      row: 0,
      col: 0,
      length: 3,
      clue: 'Down one',
      cells: [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
    },
    {
      id: '2D',
      number: 2,
      direction: 'down',
      row: 0,
      col: 1,
      length: 3,
      clue: 'Down two',
      cells: [
        [0, 1],
        [1, 1],
        [2, 1],
      ],
    },
    {
      id: '3D',
      number: 3,
      direction: 'down',
      row: 0,
      col: 2,
      length: 3,
      clue: 'Down three',
      cells: [
        [0, 2],
        [1, 2],
        [2, 2],
      ],
    },
  ];
  const puzzle: Puzzle = {
    id: 'hooks-fixture',
    source: 'synthetic',
    style: 'american',
    width: 3,
    height: 3,
    cells,
    slots,
    parsedBy: 'xd-crossword-tools',
  };
  return new Grid(puzzle);
}

function candidate(answer: string, score = 0.9, tier: 1 | 2 = 1): Candidate {
  return {
    answer,
    raw: answer,
    rank: 0,
    selfConfidence: score,
    votes: 1,
    score,
    tier,
    fromCache: false,
  };
}

function result(
  candidates: Candidate[],
  clueUnderstood = 0.9,
  extra: Partial<CandidateResult> = {},
): CandidateResult {
  return { candidates, clueUnderstood, cacheHit: false, ...extra };
}

interface RecordingService {
  service: CandidateService;
  requests: CandidateRequest[];
}

/** Returns queued results in order, and keeps the B43 `peek` ledger honestly. */
function recordingService(queue: CandidateResult[]): RecordingService {
  const requests: CandidateRequest[] = [];
  const pending = [...queue];
  const ledger = new Map<string, Candidate[]>();
  const service: CandidateService = {
    getCandidates(req: CandidateRequest): Promise<CandidateResult> {
      requests.push(req);
      const next = pending.shift() ?? result([], 0.9);
      ledger.set(req.slotId, [...(ledger.get(req.slotId) ?? []), ...next.candidates]);
      return Promise.resolve(next);
    },
    getCandidatesBatch(): Promise<Map<string, CandidateResult>> {
      throw new Error('getCandidatesBatch is not used by the search hooks');
    },
    peek(slotId: string): Candidate[] {
      return [...(ledger.get(slotId) ?? [])];
    },
  };
  return { service, requests };
}

function makeProfile(overrides: Partial<ProfileInput> = {}): Profile {
  return ProfileSchema.parse({ name: 'hooks-test', ...overrides });
}

interface Harness {
  grid: Grid;
  domains: DomainStore;
  budget: BudgetTracker;
  profile: Profile;
  events: EmittedEvent[];
  requests: CandidateRequest[];
  contexts: EscalationContext[];
  hooks: ReturnType<typeof createSearchHooks>;
}

interface HarnessOptions {
  profile?: Profile;
  queue?: CandidateResult[];
  decide?: (ctx: EscalationContext) => EscalationDecision;
  parseFailures?: (slotId: string) => number;
  now?: () => number;
}

function harness(opts: HarnessOptions = {}): Harness {
  const profile = opts.profile ?? makeProfile();
  const grid = makeGrid();
  const domains = createDomainStore();
  const budget = createBudgetTracker(
    resolveBudget(profile),
    opts.now === undefined ? {} : { now: opts.now },
  );
  const events: EmittedEvent[] = [];
  const emit: Emit = (event) => {
    events.push(event);
  };
  const { service, requests } = recordingService(opts.queue ?? []);
  const contexts: EscalationContext[] = [];
  const decide = (ctx: EscalationContext): EscalationDecision => {
    contexts.push(ctx);
    return (opts.decide ?? realDecide)(ctx);
  };

  const hooks = createSearchHooks({
    grid,
    domains,
    service,
    budget,
    profile,
    emit,
    style: 'american',
    decide,
    ...(opts.parseFailures === undefined ? {} : { parseFailures: opts.parseFailures }),
  });

  return { grid, domains, budget, profile, events, requests, contexts, hooks };
}

function eventsOfType(events: EmittedEvent[], type: EmittedEvent['type']): EmittedEvent[] {
  return events.filter((event) => event.type === type);
}

describe('createSearchHooks / onEmptyDomain re-ask guards', () => {
  it('re-asks once for a pattern with a fixed letter, merges and emits slot:reask', async () => {
    const h = harness({ queue: [result([candidate('COT')])] });
    // A crossing assignment fixes the first letter of 1A.
    h.grid.assign('1D', 'CAT');
    h.domains.setBase('1A', []);

    const decision = await h.hooks.onEmptyDomain('1A', { pattern: 'C??', depth: 1 });

    expect(decision.action).toBe('reask');
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.purpose).toBe('reask');
    expect(h.requests[0]?.tier).toBe(1);
    expect(h.requests[0]?.pattern).toBe('C??');
    expect(h.requests[0]?.clue).toBe('Across one');
    expect(h.requests[0]?.n).toBe(h.profile.candidatesPerAsk);
    expect(h.domains.get('1A').map((c) => c.answer)).toEqual(['COT']);

    const reasks = eventsOfType(h.events, 'slot:reask');
    expect(reasks).toEqual([{ type: 'slot:reask', slotId: '1A', pattern: 'C??', attempt: 1 }]);
  });

  it('does not re-ask twice for the same pattern and reports no executed action', async () => {
    const h = harness({ queue: [result([]), result([candidate('COT')])] });
    h.grid.assign('1D', 'CAT');
    h.domains.setBase('1A', []);

    const first = await h.hooks.onEmptyDomain('1A', { pattern: 'C??', depth: 1 });
    const second = await h.hooks.onEmptyDomain('1A', { pattern: 'C??', depth: 1 });

    expect(first.action).toBe('reask');
    expect(second.action).toBe('none');
    expect(second.reason).toContain('already queried');
    expect(h.requests).toHaveLength(1);
    expect(eventsOfType(h.events, 'slot:reask')).toHaveLength(1);
  });

  it('never re-asks for an all-? pattern', async () => {
    const h = harness();
    h.domains.setBase('1A', []);

    const decision = await h.hooks.onEmptyDomain('1A', { pattern: '???', depth: 0 });

    expect(decision.action).toBe('none');
    expect(decision.reason).toContain('no fixed letter');
    expect(h.requests).toHaveLength(0);
    expect(eventsOfType(h.events, 'slot:reask')).toHaveLength(0);
  });

  it('makes no call for a slot that has used every re-ask', async () => {
    // reask-first with the tier-2 cap at zero: an escalation downgrades to a
    // re-ask, so only the re-ask cap and the guards are under test here.
    const profile = makeProfile({
      reasksPerSlot: 1,
      escalation: { maxTier2CallsPerPuzzle: 0 },
    });
    const h = harness({ profile, queue: [result([])] });
    h.grid.assign('1D', 'CAT');
    h.domains.setBase('1A', []);

    const first = await h.hooks.onEmptyDomain('1A', { pattern: 'C??', depth: 1 });
    expect(first.action).toBe('reask');
    expect(h.requests).toHaveLength(1);

    // A different pattern, so only the per-slot re-ask cap can refuse it.
    h.grid.assign('2D', 'ADO');
    const second = await h.hooks.onEmptyDomain('1A', { pattern: 'CA?', depth: 2 });

    expect(second.action).toBe('none');
    expect(second.reason).toContain('reasksPerSlot');
    expect(h.requests).toHaveLength(1);
  });

  it('makes no call at all when reasksPerSlot is zero', async () => {
    const profile = makeProfile({
      reasksPerSlot: 0,
      escalation: { maxTier2CallsPerPuzzle: 0 },
    });
    const h = harness({ profile });
    h.grid.assign('1D', 'CAT');
    h.domains.setBase('1A', []);

    const decision = await h.hooks.onEmptyDomain('1A', { pattern: 'C??', depth: 1 });

    expect(decision.action).toBe('none');
    expect(h.requests).toHaveLength(0);
  });

  it('carries the pattern-rejected ledger (B43) into the re-ask request', async () => {
    // reasksPerSlot 3 keeps T18's trigger-4 proxy (re-asks exhausted with a
    // non-empty domain) from turning the second round into an escalation.
    const h = harness({
      profile: makeProfile({ reasksPerSlot: 3 }),
      queue: [result([candidate('COT')]), result([candidate('CAB')])],
    });
    h.grid.assign('1D', 'CAT');
    h.domains.setBase('1A', []);

    await h.hooks.onEmptyDomain('1A', { pattern: 'C??', depth: 1 });
    // A second crossing rules the first answer out, as the search's own
    // trailed forward check would, so it is now "rejected" for this slot.
    h.grid.assign('2D', 'ABC');
    h.domains.push();
    h.domains.reduce('1A', () => false, 'forward check');
    await h.hooks.onEmptyDomain('1A', { pattern: 'CA?', depth: 2 });

    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]?.pattern).toBe('CA?');
    expect(h.requests[1]?.rejected).toEqual([{ answer: 'COT', reason: 'pattern' }]);
  });
});

describe('createSearchHooks / escalation', () => {
  it('routes an escalate decision to one tier-2 call and emits slot:escalate', async () => {
    let consulted = 0;
    const h = harness({
      queue: [result([candidate('CAB', 0.8, 2)])],
      decide: (): EscalationDecision => {
        consulted += 1;
        return consulted === 1
          ? { action: 'escalate', trigger: 2, reason: 'forced by the test' }
          : { action: 'none', reason: 'nothing further' };
      },
    });
    h.grid.assign('1D', 'CAT');
    h.grid.assign('2D', 'ABC');
    h.domains.setBase('1A', []);

    const decision = await h.hooks.onEmptyDomain('1A', { pattern: 'CA?', depth: 2 });

    expect(decision).toEqual({ action: 'escalate', trigger: 2, reason: 'forced by the test' });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.tier).toBe(2);
    expect(h.requests[0]?.purpose).toBe('escalate');
    expect(h.requests[0]?.crossingContext).toEqual([
      { slotId: '1D', clue: 'Down one', fill: 'CAT', confidence: 0 },
      { slotId: '2D', clue: 'Down two', fill: 'ABC', confidence: 0 },
      { slotId: '3D', clue: 'Down three', fill: null, confidence: 0 },
    ]);
    expect(eventsOfType(h.events, 'slot:escalate')).toEqual([
      {
        type: 'slot:escalate',
        slotId: '1A',
        trigger: 2,
        reason: 'forced by the test',
        tier2CallsUsed: 1,
      },
    ]);
    expect(h.domains.get('1A').map((c) => c.answer)).toEqual(['CAB']);
  });

  it('reports the confidence the run has in a crossing fill', async () => {
    const h = harness({
      queue: [result([candidate('CAB', 0.8, 2)])],
      decide: (ctx): EscalationDecision =>
        ctx.escalationsUsed === 0
          ? { action: 'escalate', trigger: 2, reason: 'forced by the test' }
          : { action: 'none', reason: 'nothing further' },
    });
    h.grid.assign('1D', 'CAT');
    h.domains.setBase('1D', [candidate('CAT', 0.75)]);
    h.domains.setBase('1A', []);

    await h.hooks.onEmptyDomain('1A', { pattern: 'C??', depth: 1 });

    const crossings = h.requests[0]?.crossingContext ?? [];
    expect(crossings.find((entry) => entry.slotId === '1D')).toEqual({
      slotId: '1D',
      clue: 'Down one',
      fill: 'CAT',
      confidence: 0.75,
    });
  });

  it('escalates on trigger 3 after a successful return, proving decide runs every time', async () => {
    // reask-first with no re-asks left: trigger 3's preferred action is an
    // escalation, so a low clue_understood on a *successful* seed return is
    // enough to reach tier 2.
    const profile = makeProfile({
      reasksPerSlot: 0,
      escalation: { clueUnderstoodThreshold: 0.4, maxTier2CallsPerPuzzle: 5 },
    });
    const h = harness({ profile, queue: [result([candidate('CAB', 0.8, 2)])] });
    h.domains.setBase('1A', [candidate('COT')]);

    const decision = await h.hooks.onCandidatesReturned(
      '1A',
      result([candidate('COT')], 0.1),
    );

    expect(decision.action).toBe('escalate');
    expect(decision.trigger).toBe(3);
    expect(h.contexts[0]?.clueUnderstood).toBe(0.1);
    expect(h.contexts[0]?.domainSize).toBe(1);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.tier).toBe(2);
    expect(eventsOfType(h.events, 'slot:escalate')).toHaveLength(1);
  });

  it('leaves a satisfactory return alone', async () => {
    const h = harness();
    h.domains.setBase('1A', [candidate('COT')]);

    const decision = await h.hooks.onCandidatesReturned('1A', result([candidate('COT')], 0.9));

    expect(decision.action).toBe('none');
    expect(h.requests).toHaveLength(0);
    expect(h.contexts).toHaveLength(1);
  });
});

describe('createSearchHooks / budget', () => {
  it('emits one budget:hit for tier2Calls and downgrades later escalations to re-asks', async () => {
    const profile = makeProfile({
      reasksPerSlot: 2,
      escalation: { policy: 'eager', maxTier2CallsPerPuzzle: 1, escalationsPerSlot: 5 },
    });
    const h = harness({
      profile,
      queue: [result([candidate('COT', 0.8, 2)]), result([candidate('ARC')])],
    });
    h.grid.assign('1D', 'CAT');
    h.domains.setBase('1A', []);
    h.domains.setBase('4A', []);

    const first = await h.hooks.onEmptyDomain('1A', { pattern: 'C??', depth: 1 });
    const second = await h.hooks.onEmptyDomain('4A', { pattern: 'A??', depth: 1 });

    expect(first.action).toBe('escalate');
    expect(second.action).toBe('reask');
    expect(h.requests.map((req) => req.purpose)).toEqual(['escalate', 'reask']);
    expect(h.requests.map((req) => req.tier)).toEqual([2, 1]);

    const hits = eventsOfType(h.events, 'budget:hit');
    expect(hits).toEqual([{ type: 'budget:hit', cap: 'tier2Calls', limit: 1, actual: 1 }]);
    expect(h.budget.snapshot().tier2Calls).toBe(1);
  });

  it('charges tokens and usd for every call it makes and stops on a crossed cap', async () => {
    const profile = makeProfile({
      reasksPerSlot: 2,
      budget: { usd: 0.000001 },
    });
    const h = harness({
      profile,
      queue: [
        result([candidate('COT')], 0.9, {
          usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
        }),
      ],
    });
    h.grid.assign('1D', 'CAT');
    h.domains.setBase('1A', []);
    h.domains.setBase('4A', []);

    await h.hooks.onEmptyDomain('1A', { pattern: 'C??', depth: 1 });

    expect(h.budget.snapshot().tokens).toBe(1500);
    expect(h.budget.snapshot().usd).toBeGreaterThan(0);
    const hits = eventsOfType(h.events, 'budget:hit');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ type: 'budget:hit', cap: 'usd' });

    // The phase is over: no further call is made, and nothing throws.
    const next = await h.hooks.onEmptyDomain('4A', { pattern: 'A??', depth: 1 });
    expect(next.action).toBe('none');
    expect(h.requests).toHaveLength(1);
  });

  it('does not charge a cache hit', async () => {
    const h = harness({
      queue: [
        result([candidate('COT')], 0.9, {
          cacheHit: true,
          usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
        }),
      ],
    });
    h.grid.assign('1D', 'CAT');
    h.domains.setBase('1A', []);

    await h.hooks.onEmptyDomain('1A', { pattern: 'C??', depth: 1 });

    expect(h.budget.snapshot().tokens).toBe(0);
    expect(h.budget.snapshot().usd).toBe(0);
  });

  it('chargeBudget reports a crossed cap once and never throws', () => {
    const profile = makeProfile({ search: { maxBacktracks: 2 } });
    const h = harness({ profile });

    expect(h.hooks.chargeBudget('backtracks', 2).exceeded).toBeNull();
    expect(h.hooks.chargeBudget('backtracks', 1).exceeded).toBe('backtracks');
    expect(h.hooks.chargeBudget('backtracks', 1).exceeded).toBe('backtracks');

    expect(eventsOfType(h.events, 'budget:hit')).toEqual([
      { type: 'budget:hit', cap: 'backtracks', limit: 2, actual: 3 },
    ]);
  });

  it('chargeBudget observes wallMs rather than charging it', () => {
    let clock = 1_000;
    const profile = makeProfile({ budget: { wallMs: 50 } });
    const h = harness({ profile, now: () => clock });

    expect(h.hooks.chargeBudget('wallMs', 1).exceeded).toBeNull();
    clock += 500;
    expect(h.hooks.chargeBudget('wallMs', 1).exceeded).toBe('wallMs');
    expect(h.budget.snapshot().wallMs).toBe(500);
    expect(eventsOfType(h.events, 'budget:hit')).toHaveLength(1);
  });
});

describe('createSearchHooks / termination and persistence', () => {
  it('consults decide once per still-empty slot with a trigger-5 context', async () => {
    const profile = makeProfile({
      reasksPerSlot: 0,
      escalation: { maxTier2CallsPerPuzzle: 0 },
    });
    const h = harness({ profile });
    h.domains.setBase('1A', []);
    h.domains.setBase('4A', []);

    const decisions = await h.hooks.onSearchTermination(['1A', '4A']);

    const atTermination = h.contexts.filter((ctx) => ctx.point === 'at-termination');
    expect(atTermination.map((ctx) => ctx.slotId)).toEqual(['1A', '4A']);
    expect(atTermination.every((ctx) => ctx.domainSize === 0)).toBe(true);
    expect(decisions.map((d) => d.trigger)).toEqual([5, 5]);
    expect(decisions.map((d) => d.action)).toEqual(['give-up', 'give-up']);
    expect(h.requests).toHaveLength(0);
    // A give-up marks the slot, so a later phase can tell it apart from a
    // slot that was simply never reached.
    expect(h.domains.isSuspect('1A')).toBe(true);
    expect(h.domains.isSuspect('4A')).toBe(true);

    // A given-up slot is not consulted or paid for a second time.
    const again = await h.hooks.onSearchTermination(['1A']);
    expect(again[0]?.action).toBe('give-up');
    expect(h.contexts).toHaveLength(atTermination.length);
    expect(h.requests).toHaveLength(0);
  });

  it('escalates a still-empty slot at termination when the caps allow', async () => {
    const profile = makeProfile({ escalation: { maxTier2CallsPerPuzzle: 3 } });
    const h = harness({ profile, queue: [result([candidate('COT', 0.7, 2)])] });
    h.grid.assign('1D', 'CAT');
    h.domains.setBase('1A', []);

    const decisions = await h.hooks.onSearchTermination(['1A']);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.action).toBe('escalate');
    expect(decisions[0]?.trigger).toBe(5);
    expect(h.requests.map((req) => req.purpose)).toEqual(['escalate']);
    expect(h.domains.get('1A').map((c) => c.answer)).toEqual(['COT']);
  });

  it('merged re-ask results survive undoTo(0) (B39)', async () => {
    const h = harness({ queue: [result([candidate('COT')])] });
    h.grid.assign('1D', 'CAT');
    h.domains.setBase('1A', []);

    // Two search frames deep, and a trailed reduction on the way down.
    h.domains.push();
    h.domains.push();
    expect(h.domains.depth()).toBe(2);

    await h.hooks.onEmptyDomain('1A', { pattern: 'C??', depth: 2 });
    expect(h.domains.get('1A').map((c) => c.answer)).toEqual(['COT']);

    h.domains.undoTo(0);
    expect(h.domains.depth()).toBe(0);
    expect(h.domains.get('1A').map((c) => c.answer)).toEqual(['COT']);
  });
});
