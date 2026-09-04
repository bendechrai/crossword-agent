import type { PromptKind, Purpose, RejectReason, Tier } from '../candidates/types.js';
import type { TokenUsage } from '../llm/types.js';
import type { BudgetCap } from '../policy/types.js';
import type { Accuracy, ProducedByTier, RunStatus } from '../eval/types.js';
import type { Direction } from '../puzzle/types.js';

export type Phase = 'seed' | 'prepass' | 'search' | 'repair' | 'score';

export type Level = 0 | 1 | 2 | 3;

/** Every event carries these; the bus stamps `seq` and `tMs`. */
export interface EventBase {
  runId: string;
  seq: number;
  tMs: number;
}

/** A candidate as it appears in an event payload: answer plus score only. */
export interface ScoredAnswer {
  answer: string;
  score: number;
}

export interface RunStartEvent extends EventBase {
  type: 'run:start';
  puzzleId: string;
  profileName: string;
  models: { tier1: string; tier2: string };
  seed: number | null;
}

/**
 * B32. Emitted right after `run:start` so a renderer, a replay or an offline
 * analysis tool can draw the grid without loading the puzzle file.
 */
export interface GridInitEvent extends EventBase {
  type: 'grid:init';
  width: number;
  height: number;
  blocks: boolean[][];
  numbers: (number | null)[][];
  slots: Array<{
    id: string;
    row: number;
    col: number;
    length: number;
    direction: Direction;
    clue: string;
  }>;
}

export interface PhaseStartEvent extends EventBase {
  type: 'phase:start';
  phase: Phase;
}

export interface PhaseEndEvent extends EventBase {
  type: 'phase:end';
  phase: Phase;
  durationMs: number;
}

export interface ProgressEvent extends EventBase {
  type: 'progress';
  phase: Phase;
  assigned: number;
  total: number;
  elapsedMs: number;
  usd: number;
}

export interface GridFinalEvent extends EventBase {
  type: 'grid:final';
  letters: (string | null)[][];
}

export interface ScoreFinalEvent extends EventBase {
  type: 'score:final';
  accuracy: Accuracy;
}

export interface CostSummaryEvent extends EventBase {
  type: 'cost:summary';
  perTier: Record<
    'tier1' | 'tier2',
    { calls: number; usdBilled: number; usdCounterfactual: number }
  >;
}

export interface BudgetHitEvent extends EventBase {
  type: 'budget:hit';
  cap: BudgetCap;
  limit: number;
  actual: number;
}

export interface RunEndEvent extends EventBase {
  type: 'run:end';
  status: RunStatus;
  wallMs: number;
}

export interface SlotAskEvent extends EventBase {
  type: 'slot:ask';
  slotId: string;
  clue: string;
  length: number;
  pattern: string;
  tier: Tier;
  purpose: Purpose;
  promptKind: PromptKind;
  batchIndex: number | null;
}

export interface SlotCandidatesEvent extends EventBase {
  type: 'slot:candidates';
  slotId: string;
  accepted: ScoredAnswer[];
  clueUnderstood: number | null;
  cacheHit: boolean;
}

export interface SearchAssignEvent extends EventBase {
  type: 'search:assign';
  slotId: string;
  answer: string;
  score: number;
  margin: number;
  tier: ProducedByTier;
  /** Model id, or "wordlist". */
  producedBy: string;
}

export interface SlotReaskEvent extends EventBase {
  type: 'slot:reask';
  slotId: string;
  pattern: string;
  attempt: number;
}

export interface SlotEscalateEvent extends EventBase {
  type: 'slot:escalate';
  slotId: string;
  trigger: 1 | 2 | 3 | 4 | 5;
  reason: string;
  tier2CallsUsed: number;
}

export interface RepairAcceptEvent extends EventBase {
  type: 'repair:accept';
  slotId: string;
  before: string;
  after: string;
  editDistance: number;
  tier: ProducedByTier;
  producedBy: string;
}

export interface RateLimitedEvent extends EventBase {
  type: 'rate:limited';
  model: string;
  status: number;
  retryAfterMs: number | null;
  attempt: number;
}

export interface PatternBuiltEvent extends EventBase {
  type: 'pattern:built';
  slotId: string;
  pattern: string;
  regex: string;
}

export interface CandidateRejectEvent extends EventBase {
  type: 'candidate:reject';
  slotId: string;
  answer: string;
  reason: RejectReason;
}

export interface DomainFilteredEvent extends EventBase {
  type: 'domain:filtered';
  slotId: string;
  surviving: ScoredAnswer[];
}

export interface SearchForwardcheckEvent extends EventBase {
  type: 'search:forwardcheck';
  slotId: string;
  crossingSlotId: string;
  before: number;
  after: number;
}

export interface SearchWipeoutEvent extends EventBase {
  type: 'search:wipeout';
  slotId: string;
}

export interface SearchUnassignEvent extends EventBase {
  type: 'search:unassign';
  slotId: string;
  answer: string;
}

export interface SearchBacktrackEvent extends EventBase {
  type: 'search:backtrack';
  slotId: string;
  margin: number;
  reason: string;
}

export interface Ac3ReduceEvent extends EventBase {
  type: 'ac3:reduce';
  slotId: string;
  otherSlotId: string;
  removed: string[];
}

export interface Ac3WipeoutEvent extends EventBase {
  type: 'ac3:wipeout';
  slotId: string;
}

export interface LdsRestartEvent extends EventBase {
  type: 'lds:restart';
  ldsLimit: number;
  discrepanciesUsed: number;
}

export interface RepairProposeEvent extends EventBase {
  type: 'repair:propose';
  slotId: string;
  before: string;
  after: string;
  editDistance: number;
  gate: string;
}

export interface RepairRejectEvent extends EventBase {
  type: 'repair:reject';
  slotId: string;
  before: string;
  after: string;
  gate: string;
  reason: string;
}

export interface RateAdjustedEvent extends EventBase {
  type: 'rate:adjusted';
  model: string;
  rps: number;
  reason: string;
}

export interface LlmRequestEvent extends EventBase {
  type: 'llm:request';
  model: string;
  slotId: string | null;
  prompt: string;
}

export interface LlmResponseEvent extends EventBase {
  type: 'llm:response';
  model: string;
  slotId: string | null;
  raw: string;
}

export interface CacheLookupEvent extends EventBase {
  type: 'cache:lookup';
  key: string;
  hit: boolean;
  slotId: string | null;
}

export interface LlmUsageEvent extends EventBase {
  type: 'llm:usage';
  model: string;
  usage: TokenUsage;
  usdBilled: number;
  usdCounterfactual: number;
  latencyMs: number;
  /**
   * True when this usage was served from the candidate cache rather than the
   * provider (B2). A hit costs nothing (`usdBilled` 0) but is still priced
   * into `usdCounterfactual` from the cached usage blob, which is what keeps
   * two profiles comparable when one of them inherited the other's cache.
   * Optional so an event stream recorded before T61 still parses; a consumer
   * reading such a stream falls back to the `cache:lookup` that preceded the
   * event.
   */
  cacheHit?: boolean;
}

export interface Ac3ArcEvent extends EventBase {
  type: 'ac3:arc';
  slotId: string;
  otherSlotId: string;
}

export interface PhaseTimingEvent extends EventBase {
  type: 'phase:timing';
  phase: Phase;
  label: string;
  ms: number;
}

export type SolverEvent =
  | RunStartEvent
  | GridInitEvent
  | PhaseStartEvent
  | PhaseEndEvent
  | ProgressEvent
  | GridFinalEvent
  | ScoreFinalEvent
  | CostSummaryEvent
  | BudgetHitEvent
  | RunEndEvent
  | SlotAskEvent
  | SlotCandidatesEvent
  | SearchAssignEvent
  | SlotReaskEvent
  | SlotEscalateEvent
  | RepairAcceptEvent
  | RateLimitedEvent
  | PatternBuiltEvent
  | CandidateRejectEvent
  | DomainFilteredEvent
  | SearchForwardcheckEvent
  | SearchWipeoutEvent
  | SearchUnassignEvent
  | SearchBacktrackEvent
  | Ac3ReduceEvent
  | Ac3WipeoutEvent
  | LdsRestartEvent
  | RepairProposeEvent
  | RepairRejectEvent
  | RateAdjustedEvent
  | LlmRequestEvent
  | LlmResponseEvent
  | CacheLookupEvent
  | LlmUsageEvent
  | Ac3ArcEvent
  | PhaseTimingEvent;

export type SolverEventType = SolverEvent['type'];

/**
 * What a producer passes to `emit`: the bus stamps `runId`, `seq` and `tMs`.
 */
export type EmittedEvent = {
  [K in SolverEventType]: Omit<Extract<SolverEvent, { type: K }>, keyof EventBase>;
}[SolverEventType];

export type Emit = (event: EmittedEvent) => void;

export type EventHandler = (event: SolverEvent) => void;

/** Synchronous and ordered: a handler sees events in emission order. */
export interface EventBus {
  on(handler: EventHandler): void;
  off(handler: EventHandler): void;
  emit(event: EmittedEvent): void;
}
