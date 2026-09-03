import type {
  Candidate,
  CandidateRequest,
  CandidateResult,
  CandidateService,
  CrossingContextEntry,
  RejectedAnswer,
  Tier,
} from '../candidates/types.js';
import type { Emit } from '../events/types.js';
import { Grid } from '../grid/model.js';
import { fixedLetterCount, patternMatches } from '../grid/pattern.js';
import type { DomainStore } from '../grid/types.js';
import { usdFor } from '../llm/pricing.js';
import type { TokenUsage } from '../llm/types.js';
import type { BudgetTracker } from '../policy/budget.js';
import { decide as defaultDecide } from '../policy/escalation.js';
import type { BudgetCap, EscalationContext, EscalationDecision } from '../policy/types.js';
import type { Profile } from '../profiles/schema.js';
import type { PuzzleStyle, Slot } from '../puzzle/types.js';
import { log } from '../util/log.js';
import type { SearchHooks } from './types.js';

export interface SearchHooksDeps {
  grid: Grid;
  domains: DomainStore;
  service: CandidateService;
  budget: BudgetTracker;
  profile: Profile;
  emit: Emit;
  /**
   * The puzzle's style, which every `CandidateRequest` carries and `Grid`
   * deliberately does not hold. Defaults to `'unknown'` so a caller that has
   * no puzzle to hand still gets a well-formed request.
   */
  style?: PuzzleStyle;
  /** The puzzle title, prompt-only context (T31). */
  title?: string;
  /**
   * `EscalationContext.parseFailures` for a slot. Injected rather than read
   * off the service, because `parseFailures` lives on T34's
   * `RunCandidateService` (an implementation module) and not on the T0
   * `CandidateService` contract this task is wired against. Defaults to 0,
   * which simply means trigger 1 never fires on the parse-failure arm.
   */
  parseFailures?: (slotId: string) => number;
  /**
   * USD for one call, defaulting to the T8 catalogue. Injected so a test (or
   * a caller doing its own cost accounting) can price a model the catalogue
   * does not carry.
   */
  priceUsd?: (model: string, usage: TokenUsage) => number;
  /**
   * The escalation policy (T18), injected only so a test can observe every
   * context it is consulted with. Production always uses `decide` itself.
   */
  decide?: (ctx: EscalationContext) => EscalationDecision;
}

/**
 * A resolve loop consults `decide` again after every service return (B13), so
 * it needs a stop. Every executed action consumes a per-slot or per-puzzle cap
 * (`reasksPerSlot`, `escalationsPerSlot`, `maxTier2CallsPerPuzzle`) and the
 * re-ask guard refuses a repeat of the pattern already queried, so the loop
 * converges on its own; this bound only keeps a mis-configured profile with
 * enormous caps from spending a whole budget inside one hook call.
 */
const MAX_ROUNDS = 6;

/**
 * The caps whose crossing ends the current phase (spec, "Budget-cap
 * behaviour"). `tier2Calls` is deliberately absent: exhausting it downgrades
 * an escalation to a re-ask (T18 does that from `ctx.tier2CallsUsed`) rather
 * than stopping the phase, so the sweep carries on at tier 1.
 */
const PHASE_ENDING_CAPS: ReadonlySet<BudgetCap> = new Set([
  'usd',
  'tokens',
  'wallMs',
  'backtracks',
  'repairCalls',
]);

/** The per-slot state neither the search nor the policy holds. */
interface SlotState {
  lastPatternQueried: string | null;
  reasksUsed: number;
  escalationsUsed: number;
  wipeouts: number;
  gaveUp: boolean;
}

function newSlotState(): SlotState {
  return {
    lastPatternQueried: null,
    reasksUsed: 0,
    escalationsUsed: 0,
    wipeouts: 0,
    gaveUp: false,
  };
}

function defaultPriceUsd(model: string, usage: TokenUsage): number {
  return usdFor({
    model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    calls: 1,
  });
}

/**
 * T38: the implementation of the interface T37 calls. Applies the re-ask
 * guards, merges results into the base domain (B39), consults `decide()` after
 * every service return, routes escalations to tier 2, and charges the budget.
 *
 * The division of labour with T18 is strict: `decide` owns the triggers, the
 * policy and the escalation caps and is the only thing that chooses an action;
 * these hooks own the per-slot bookkeeping (last pattern queried, re-asks,
 * escalations, wipeouts), the three re-ask guards, the service calls, the
 * merge and the events. A decision this module cannot execute - a `reask` for
 * a pattern with no fixed letters, or for a pattern already queried - is
 * reported back as `none` rather than being upgraded to something else, so the
 * policy stays where it belongs.
 */
export function createSearchHooks(deps: SearchHooksDeps): SearchHooks {
  const { grid, domains, service, budget, profile, emit } = deps;
  const style: PuzzleStyle = deps.style ?? 'unknown';
  const title = deps.title;
  const parseFailuresOf = deps.parseFailures ?? ((): number => 0);
  const priceUsd = deps.priceUsd ?? defaultPriceUsd;
  const decide = deps.decide ?? defaultDecide;

  const states = new Map<string, SlotState>();
  /** Kept in step with `spent.tier2Calls`, which T18 and T19 read separately. */
  let tier2CallsUsed = 0;
  /** Caps a `budget:hit` has been emitted for; the event fires once per cap. */
  const capsReported = new Set<BudgetCap>();
  /** Set once a phase-ending cap is crossed; no further call is made. */
  let phaseEnded = false;

  function stateOf(slotId: string): SlotState {
    const existing = states.get(slotId);
    if (existing !== undefined) return existing;
    const created = newSlotState();
    states.set(slotId, created);
    return created;
  }

  function slotOf(slotId: string): Slot {
    const slot = grid.slots.get(slotId);
    if (slot === undefined) {
      throw new Error(`search hooks: unknown slot "${slotId}"`);
    }
    return slot;
  }

  /**
   * Emits `budget:hit` for a crossed cap, at most once per cap, and records
   * whether the phase should now end. Never throws: the caller finishes what
   * it is doing and the phase ends gracefully (spec, "Budget-cap behaviour").
   */
  function reportCap(cap: BudgetCap | null): void {
    if (cap === null) return;
    if (!capsReported.has(cap)) {
      capsReported.add(cap);
      emit({ type: 'budget:hit', cap, limit: budget.budget()[cap], actual: budget.snapshot()[cap] });
    }
    if (PHASE_ENDING_CAPS.has(cap)) phaseEnded = true;
  }

  /** Tokens and USD for a call this module made. A cache hit is billed nothing. */
  function chargeCall(tier: Tier, result: CandidateResult): void {
    const usage = result.usage;
    if (usage === undefined || result.cacheHit) return;
    if (usage.totalTokens > 0) {
      reportCap(budget.charge('tokens', usage.totalTokens).exceeded);
    }
    const usd = priceUsd(tier === 1 ? profile.tier1 : profile.tier2, usage);
    if (usd > 0) {
      reportCap(budget.charge('usd', usd).exceeded);
    }
  }

  /**
   * One tier-2 call against the `tier2Calls` cap. The cap is reported when it
   * is *reached*, not when it is crossed: T18 refuses a further escalation at
   * `tier2CallsUsed >= maxTier2CallsPerPuzzle`, so the counter never grows
   * past the limit and `charge` alone would never surface it.
   */
  function chargeTier2Call(): void {
    tier2CallsUsed += 1;
    reportCap(budget.charge('tier2Calls', 1).exceeded);
    const limit = budget.budget().tier2Calls;
    if (Number.isFinite(limit) && budget.snapshot().tier2Calls >= limit) {
      reportCap('tier2Calls');
    }
  }

  /** The score this run has for `answer` in `slotId`, 0 when it has none. */
  function confidenceIn(slotId: string, answer: string): number {
    const inDomain = domains.get(slotId).find((c: Candidate) => c.answer === answer);
    if (inDomain !== undefined) return inDomain.score;
    const everSeen = service.peek(slotId).find((c: Candidate) => c.answer === answer);
    return everSeen?.score ?? 0;
  }

  /** The crossing clues, fills and confidences the escalate prompt expects (T31). */
  function crossingContextFor(slotId: string): CrossingContextEntry[] {
    const entries = new Map<string, CrossingContextEntry>();
    for (const crossing of grid.crossings(slotId)) {
      if (entries.has(crossing.otherSlotId)) continue;
      const other = grid.slots.get(crossing.otherSlotId);
      if (other === undefined) continue;
      const fill = grid.assignmentOf(crossing.otherSlotId) ?? null;
      entries.set(crossing.otherSlotId, {
        slotId: crossing.otherSlotId,
        clue: other.clue,
        fill,
        confidence: fill === null ? 0 : confidenceIn(crossing.otherSlotId, fill),
      });
    }
    return [...entries.values()];
  }

  /**
   * The rejected list a constrained or escalate prompt carries: every answer
   * this run has ever seen for the slot (B43's ledger, so a candidate an
   * undone assignment removed still counts) that the current pattern rules
   * out. The reason is the `RejectReason` vocabulary's `pattern`.
   */
  function rejectedFor(slotId: string, pattern: string): RejectedAnswer[] {
    const seen = new Set<string>();
    const rejected: RejectedAnswer[] = [];
    for (const candidate of service.peek(slotId)) {
      if (seen.has(candidate.answer)) continue;
      seen.add(candidate.answer);
      if (candidate.answer.length !== pattern.length || !patternMatches(pattern, candidate.answer)) {
        rejected.push({ answer: candidate.answer, reason: 'pattern' });
      }
    }
    return rejected;
  }

  function requestFor(
    slotId: string,
    pattern: string,
    tier: Tier,
    purpose: 'reask' | 'escalate',
  ): CandidateRequest {
    const slot = slotOf(slotId);
    return {
      slotId,
      clue: slot.clue,
      length: slot.length,
      pattern,
      style,
      enumeration: slot.enumeration,
      title,
      rejected: rejectedFor(slotId, pattern),
      tier,
      purpose,
      n: profile.candidatesPerAsk,
      samples: profile.samples,
      sampleIndex: 0,
      crossingContext: purpose === 'escalate' ? crossingContextFor(slotId) : undefined,
    };
  }

  /**
   * The three re-ask guards (spec step 5), owned here rather than in `decide`:
   * the pattern must have at least one fixed letter, must differ from the last
   * pattern queried for this slot, and the slot must be under `reasksPerSlot`.
   * Returns the guard that refused, or null when the re-ask can go ahead.
   */
  function reaskBlockedBy(slotId: string, pattern: string): string | null {
    const state = stateOf(slotId);
    if (fixedLetterCount(pattern) === 0) {
      return 'the pattern has no fixed letter';
    }
    if (state.lastPatternQueried === pattern) {
      return `pattern ${pattern} was already queried for this slot`;
    }
    if (state.reasksUsed >= profile.reasksPerSlot) {
      return `the slot has used its ${profile.reasksPerSlot} re-asks`;
    }
    return null;
  }

  async function runReask(slotId: string, pattern: string): Promise<CandidateResult> {
    const result = await service.getCandidates(requestFor(slotId, pattern, 1, 'reask'));
    const state = stateOf(slotId);
    state.reasksUsed += 1;
    state.lastPatternQueried = pattern;
    // B39: the result joins the base domain, so it survives every backtrack.
    domains.merge(slotId, result.candidates);
    chargeCall(1, result);
    emit({ type: 'slot:reask', slotId, pattern, attempt: state.reasksUsed });
    return result;
  }

  async function runEscalate(
    slotId: string,
    pattern: string,
    trigger: 1 | 2 | 3 | 4 | 5,
    reason: string,
  ): Promise<CandidateResult> {
    const result = await service.getCandidates(requestFor(slotId, pattern, 2, 'escalate'));
    const state = stateOf(slotId);
    state.escalationsUsed += 1;
    chargeTier2Call();
    domains.merge(slotId, result.candidates);
    chargeCall(2, result);
    emit({ type: 'slot:escalate', slotId, trigger, reason, tier2CallsUsed });
    return result;
  }

  function contextFor(
    slotId: string,
    point: EscalationContext['point'],
    pattern: string,
    clueUnderstood: number | null,
  ): EscalationContext {
    const state = stateOf(slotId);
    return {
      slotId,
      point,
      clueUnderstood,
      domainSize: domains.sizeOf(slotId),
      parseFailures: parseFailuresOf(slotId),
      reasksUsed: state.reasksUsed,
      escalationsUsed: state.escalationsUsed,
      tier2CallsUsed,
      patternFixedLetters: fixedLetterCount(pattern),
      lastPatternQueried: state.lastPatternQueried,
      currentPattern: pattern,
      budget: budget.budget(),
      spent: budget.snapshot(),
      profile,
    };
  }

  /**
   * A give-up marks the slot: repair (T42) and any later phase can then tell a
   * slot the solver abandoned from one it simply never reached, and a second
   * hook call for the same slot spends nothing more on it.
   */
  function markGivenUp(slotId: string): void {
    stateOf(slotId).gaveUp = true;
    domains.markSuspect(slotId);
  }

  /**
   * A decision this module cannot execute. At search termination that is a
   * give-up (nothing else is left to try); mid-search it is `none`, and the
   * search backtracks.
   */
  function notExecuted(
    slotId: string,
    point: EscalationContext['point'],
    decision: EscalationDecision,
    why: string,
  ): EscalationDecision {
    const action = point === 'at-termination' ? 'give-up' : 'none';
    if (action === 'give-up') markGivenUp(slotId);
    const out: EscalationDecision = {
      action,
      reason: `${decision.reason}; not executed because ${why}`,
    };
    if (decision.trigger !== undefined) out.trigger = decision.trigger;
    return out;
  }

  /**
   * Consult `decide`, execute what it chose, and consult it again on the
   * result (B13). The returned decision is the action that actually happened,
   * so the search can tell a re-ask or escalation that merged something new
   * (`reask` / `escalate`, worth re-filtering the domain and retrying) from
   * one that did not (`none` / `give-up`, time to backtrack or move on).
   */
  async function resolve(
    slotId: string,
    point: EscalationContext['point'],
    initialClueUnderstood: number | null,
  ): Promise<EscalationDecision> {
    if (phaseEnded) {
      return { action: 'none', reason: 'a budget cap was crossed; the phase is ending' };
    }
    if (stateOf(slotId).gaveUp) {
      return { action: 'give-up', reason: 'the slot was already given up' };
    }

    let clueUnderstood = initialClueUnderstood;
    let executed: EscalationDecision | null = null;

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const pattern = grid.patternFor(slotId);
      const decision = decide(contextFor(slotId, point, pattern, clueUnderstood));

      if (decision.action === 'reask') {
        const blocked = reaskBlockedBy(slotId, pattern);
        if (blocked !== null) {
          return executed ?? notExecuted(slotId, point, decision, blocked);
        }
        const result = await runReask(slotId, pattern);
        clueUnderstood = result.clueUnderstood;
        executed = { action: 'reask', reason: decision.reason };
        if (decision.trigger !== undefined) executed.trigger = decision.trigger;
        if (phaseEnded) return executed;
        continue;
      }

      if (decision.action === 'escalate') {
        const trigger = decision.trigger;
        if (trigger === undefined) {
          return (
            executed ?? notExecuted(slotId, point, decision, 'the decision carried no trigger')
          );
        }
        const result = await runEscalate(slotId, pattern, trigger, decision.reason);
        clueUnderstood = result.clueUnderstood;
        executed = { action: 'escalate', trigger, reason: decision.reason };
        if (phaseEnded) return executed;
        continue;
      }

      if (executed !== null) return executed;
      if (decision.action === 'give-up') markGivenUp(slotId);
      return decision;
    }

    return executed ?? { action: 'none', reason: 'no further escalation is available' };
  }

  return {
    onEmptyDomain(slotId, ctx): Promise<EscalationDecision> {
      const state = stateOf(slotId);
      state.wipeouts += 1;
      const pattern = grid.patternFor(slotId);
      if (ctx.pattern !== pattern) {
        // The hooks build the pattern themselves (the deliverable); the
        // search's view is only cross-checked, never used, so the request and
        // the guards can never be keyed on a stale pattern.
        log.debug(
          `search hooks: ${slotId} pattern from the search was "${ctx.pattern}" at depth ${ctx.depth}, the grid says "${pattern}"`,
        );
      }
      return resolve(slotId, 'after-candidates', null);
    },

    onCandidatesReturned(slotId, result): Promise<EscalationDecision> {
      return resolve(slotId, 'after-candidates', result.clueUnderstood);
    },

    async onSearchTermination(emptySlotIds): Promise<EscalationDecision[]> {
      const decisions: EscalationDecision[] = [];
      for (const slotId of emptySlotIds) {
        decisions.push(await resolve(slotId, 'at-termination', null));
      }
      return decisions;
    },

    chargeBudget(cap, amount): { exceeded: BudgetCap | null } {
      // `wallMs` is not chargeable (T19): it accrues on its own and is only
      // ever observed, so a charge against it becomes an observation.
      const result = cap === 'wallMs' ? budget.checkWallClock() : budget.charge(cap, amount);
      reportCap(result.exceeded);
      return result;
    },
  };
}
