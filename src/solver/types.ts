import type { CandidateResult, CandidateService } from '../candidates/types.js';
import type { Emit } from '../events/types.js';
import type { DomainStore, GridSnapshot } from '../grid/types.js';
import type { Grid } from '../grid/model.js';
import type { BudgetCap, EscalationDecision } from '../policy/types.js';
import type { Profile } from '../profiles/schema.js';
import type { Accuracy, RunStatus } from '../eval/types.js';
import type { WordList } from '../validate/types.js';

export interface Ac3Options {
  /** Stop after this many arc revisions; 0 or undefined means no cap. */
  maxArcs?: number;
}

export interface Ac3Result {
  arcsVisited: number;
  reductions: number;
  /** Slots marked suspect by a wipeout (B40), in the order it happened. */
  wipeouts: string[];
}

export type Ac3Fn = (
  grid: Grid,
  domains: DomainStore,
  emit: Emit,
  opts: Ac3Options,
) => Ac3Result;

export interface SearchOptions {
  ordering: 'margin' | 'mrv';
  ldsLimitStart: number;
  ldsLimitMax: number;
  maxBacktracks: number;
  /** Seeded PRNG for tie-breaks (B38). */
  rng: () => number;
}

export interface SearchResult {
  complete: boolean;
  assigned: number;
  backtracks: number;
  discrepancies: number;
  wipeouts: number;
  ldsRestarts: number;
  /** Slots still empty when the search terminated. */
  emptySlotIds: string[];
}

/**
 * The seam between T37 (search core) and T38 (search hooks): the search calls
 * these at the declared points and never touches the candidate service.
 */
export interface SearchHooks {
  /** A domain emptied: re-ask, escalate or give up. */
  onEmptyDomain(slotId: string, ctx: { pattern: string; depth: number }): Promise<EscalationDecision>;
  /** Consulted after every `getCandidates` return (B13). */
  onCandidatesReturned(slotId: string, result: CandidateResult): Promise<EscalationDecision>;
  /** Consulted once at search termination for each still-empty slot. */
  onSearchTermination(emptySlotIds: readonly string[]): Promise<EscalationDecision[]>;
  /** Never throws: a crossed cap is reported so the phase can end gracefully. */
  chargeBudget(cap: BudgetCap, amount: number): { exceeded: BudgetCap | null };
}

export type SearchFn = (
  grid: Grid,
  domains: DomainStore,
  hooks: SearchHooks,
  emit: Emit,
  opts: SearchOptions,
) => Promise<SearchResult>;

export interface RepairOptions {
  enabled: boolean;
  maxCalls: number;
  maxEditDistance: 1 | 2;
}

export interface RepairResult {
  proposals: number;
  accepted: number;
  callsUsed: number;
}

export type RepairFn = (
  grid: Grid,
  service: CandidateService,
  wordList: WordList,
  emit: Emit,
  opts: RepairOptions,
) => Promise<RepairResult>;

export interface SolveOptions {
  runId: string;
  puzzleId: string;
  repeatIndex: number;
  seed: number | null;
  /** A cache miss is fatal (B6). */
  offline: boolean;
  /** Implies `offline`, but degrades gracefully instead of exiting. */
  offlineLenient: boolean;
}

/**
 * Everything `solve()` composes (T44). It is a record of collaborators rather
 * than concrete modules so that T44 can test the orchestration with fakes and
 * so no wave-mate imports another's implementation directly.
 */
export interface SolveDeps {
  grid: Grid;
  domains: DomainStore;
  service: CandidateService;
  hooks: SearchHooks;
  wordList: WordList;
  ac3: Ac3Fn;
  search: SearchFn;
  repair: RepairFn;
  emit: Emit;
  /**
   * Step 8. Injected rather than handed the solution, so nothing inside
   * `src/solver/` can see the answers.
   */
  score: (snapshot: GridSnapshot) => Accuracy;
}

export interface SolveResult {
  status: RunStatus;
  snapshot: GridSnapshot;
  accuracy: Accuracy;
  ac3: Ac3Result;
  search: SearchResult;
  repair: RepairResult;
  wallMs: number;
}

export type SolveFn = (
  deps: SolveDeps,
  profile: Profile,
  opts: SolveOptions,
) => Promise<SolveResult>;
