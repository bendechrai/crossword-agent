import type { EscalationContext, EscalationDecision } from './types.js';

/**
 * T18 (B13): a pure function of its context, consulted after every
 * `getCandidates` return and once at search termination for each still-empty
 * slot. It owns all escalation caps.
 *
 * Triggers, in strict precedence order (1 > 2 > 3 > 4 > 5 - the first match
 * wins and the rest are not evaluated):
 *   1. tier 1 returned unparseable JSON twice, or zero valid candidates
 *      survived validation and no re-ask has been attempted yet.
 *   2. the domain is empty after pattern filtering and at least one
 *      constrained re-ask has already been tried.
 *   3. `clueUnderstood` is below `escalation.clueUnderstoodThreshold` on the
 *      first pass (no re-ask or escalation attempted for this slot yet).
 *   4. the slot has caused three or more wipeouts (see the note on
 *      `hasThrashed` below for how this is approximated from `ctx`).
 *   5. the slot is still empty when search terminates.
 *
 * Triggers 1-4 are evaluated only when `ctx.point === 'after-candidates'`;
 * trigger 5 is evaluated only when `ctx.point === 'at-termination'`, which
 * mirrors the two moments `decide` is consulted at (spec "Solver pipeline"
 * step 6) and keeps the two families of trigger mutually exclusive.
 *
 * `decide` reads no clock, no config file and no global state - every input
 * it needs is in `ctx` - and it never mutates `ctx`.
 */

type Trigger = 1 | 2 | 3 | 4 | 5;
type Action = EscalationDecision['action'];

const CAP_TIER2_PER_PUZZLE = 'maxTier2CallsPerPuzzle';
const CAP_ESCALATIONS_PER_SLOT = 'escalationsPerSlot';
const CAP_REASKS_PER_SLOT = 'reasksPerSlot';

const TRIGGER_LABEL: Record<Trigger, string> = {
  1: 'tier 1 returned unparseable JSON twice or zero candidates survived validation',
  2: 'the domain emptied after pattern filtering and a re-ask has already been tried',
  3: 'clue_understood was below the threshold on the first pass',
  4: 'the slot has caused three or more wipeouts',
  5: 'the slot was still empty when search terminated',
};

/**
 * Trigger 4 in the spec is a raw per-slot wipeout count ("three or more
 * wipeouts"), but `EscalationContext` (T0's contract) carries no dedicated
 * wipeout counter - only `reasksUsed`, which is capped at `reasksPerSlot`
 * (2 by default) and so cannot itself count as high as 3. The closest signal
 * available in `ctx` is: the slot has used its entire re-ask budget (each
 * re-ask is spent recovering one wipeout) and its domain is currently
 * non-empty again (it has recovered from at least `reasksPerSlot` wipeouts
 * and is one more wipeout away from needing help again). This is flagged as
 * a deviation - see the PR description - which recommends `EscalationContext`
 * grow a `wipeoutCount: number` field so this can be exact.
 */
function hasThrashed(ctx: EscalationContext): boolean {
  return ctx.reasksUsed >= 1 && ctx.reasksUsed >= ctx.profile.reasksPerSlot && ctx.domainSize > 0;
}

function isFirstPass(ctx: EscalationContext): boolean {
  return ctx.reasksUsed === 0 && ctx.escalationsUsed === 0;
}

function detectTrigger(ctx: EscalationContext): Trigger | null {
  if (ctx.point === 'at-termination') {
    return ctx.domainSize === 0 ? 5 : null;
  }

  // ctx.point === 'after-candidates'
  if (ctx.parseFailures >= 2 || (ctx.domainSize === 0 && ctx.reasksUsed === 0)) return 1;
  if (ctx.domainSize === 0 && ctx.reasksUsed >= 1) return 2;
  if (
    ctx.clueUnderstood !== null &&
    ctx.clueUnderstood < ctx.profile.escalation.clueUnderstoodThreshold &&
    isFirstPass(ctx)
  ) {
    return 3;
  }
  if (hasThrashed(ctx)) return 4;
  return null;
}

/**
 * The action a trigger maps to for a given policy, before any cap is
 * checked (B13 decisions baked in):
 *   - `reask-first` (default) prefers `reask` while `reasksPerSlot` remains,
 *     else `escalate`.
 *   - `eager` always prefers `escalate` and never `reask` (its profile sets
 *     `reasksPerSlot: 0`, which structurally blocks every re-ask attempt in
 *     the cap check below regardless of what this function returns).
 *   - `patient` prefers `reask` while `reasksPerSlot` remains, else `none`;
 *     it escalates only on trigger 5.
 * Trigger 5 always prefers `escalate`, for every policy - it is the one
 * last-resort attempt before repair/give-up, and `patient`'s "escalate only
 * on trigger 5" phrasing is unremarkable for the other two policies (they
 * already escalate elsewhere) but is the one place `patient` does so.
 */
function desiredAction(trigger: Trigger, ctx: EscalationContext): Action {
  if (trigger === 5) return 'escalate';

  const policy = ctx.profile.escalation.policy;
  if (policy === 'eager') return 'escalate';

  const reasksRemain = ctx.reasksUsed < ctx.profile.reasksPerSlot;
  if (policy === 'patient') return reasksRemain ? 'reask' : 'none';
  return reasksRemain ? 'reask' : 'escalate'; // reask-first (default)
}

function composeReason(trigger: Trigger, action: Action, blockedCaps: readonly string[]): string {
  const base = `trigger ${trigger}: ${TRIGGER_LABEL[trigger]}`;
  if (blockedCaps.length === 0) {
    return `${base}; action: ${action}`;
  }
  const capList = blockedCaps.join(' and ');
  const verb = blockedCaps.length > 1 ? 'are' : 'is';
  return `${base}; downgraded to ${action} because ${capList} ${verb} exhausted`;
}

export function decide(ctx: EscalationContext): EscalationDecision {
  const trigger = detectTrigger(ctx);
  if (trigger === null) {
    return { action: 'none', reason: 'no escalation trigger matched' };
  }

  let action = desiredAction(trigger, ctx);
  const blockedCaps: string[] = [];

  // Caps checked before any action: maxTier2CallsPerPuzzle, escalationsPerSlot,
  // reasksPerSlot. A cap that blocks the chosen action downgrades it
  // (escalate -> reask -> none), and the reason string names the cap.
  if (action === 'escalate') {
    const tier2Blocked = ctx.tier2CallsUsed >= ctx.profile.escalation.maxTier2CallsPerPuzzle;
    const slotBlocked = ctx.escalationsUsed >= ctx.profile.escalation.escalationsPerSlot;
    if (tier2Blocked) blockedCaps.push(CAP_TIER2_PER_PUZZLE);
    if (slotBlocked) blockedCaps.push(CAP_ESCALATIONS_PER_SLOT);
    if (tier2Blocked || slotBlocked) action = 'reask';
  }

  if (action === 'reask') {
    const reaskBlocked = ctx.reasksUsed >= ctx.profile.reasksPerSlot;
    if (reaskBlocked) {
      blockedCaps.push(CAP_REASKS_PER_SLOT);
      action = 'none';
    }
  }

  // give-up is returned only at search termination when no action remains
  // and the slot is still empty (which detectTrigger has already confirmed,
  // since trigger 5 only fires when ctx.domainSize === 0 at termination).
  if (action === 'none' && ctx.point === 'at-termination') {
    action = 'give-up';
  }

  return { action, trigger, reason: composeReason(trigger, action, blockedCaps) };
}
