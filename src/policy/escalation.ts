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
 * `ctx.domainSize` is the *pattern-filtered* live domain size (T62; see its
 * doc comment on `EscalationContext`), so triggers 1, 2 and 5 fire for a slot
 * whose surviving candidates all conflict with the letters on the board, not
 * only for one whose domain is literally empty.
 *
 * `decide` reads no clock, no config file and no global state - every input
 * it needs is in `ctx` - and it never mutates `ctx`.
 */

type Trigger = 1 | 2 | 3 | 4 | 5;
type Action = EscalationDecision['action'];

const CAP_TIER2_PER_PUZZLE = 'maxTier2CallsPerPuzzle';
const CAP_ESCALATIONS_PER_SLOT = 'escalationsPerSlot';
const CAP_REASKS_PER_SLOT = 'reasksPerSlot';

/**
 * T62: a constrained re-ask is only worth asking for when the pattern carries
 * at least one fixed letter - that letter is the whole point of the second
 * ask (the algorithms doc's 43.5% -> 89.6% result), and the hooks' own guard
 * refuses an all-`?` re-ask anyway. Treating "no fixed letter" as
 * *unavailable* here, rather than leaving it for the hooks to discover, is
 * what makes an empty domain at seed time escalate straight away (spec step
 * 2: a slot empty after validation goes onto the escalation queue) instead of
 * idling until trigger 5 escalates it at termination with an all-`?` pattern.
 */
const BLOCKER_NO_FIXED_LETTER = 'the pattern has no fixed letter for a constrained re-ask';

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
 * Whether a constrained re-ask is worth choosing at all: the slot is under
 * `reasksPerSlot` and the pattern carries at least one fixed letter (T62).
 */
function reaskIsAvailable(ctx: EscalationContext): boolean {
  return ctx.reasksUsed < ctx.profile.reasksPerSlot && ctx.patternFixedLetters > 0;
}

/**
 * The action a trigger maps to for a given policy, before any cap is
 * checked (B13 decisions baked in):
 *   - `reask-first` (default) prefers `reask` while a re-ask is available,
 *     else `escalate`.
 *   - `eager` always prefers `escalate` and never `reask` (its profile sets
 *     `reasksPerSlot: 0`, which structurally blocks every re-ask attempt in
 *     the cap check below regardless of what this function returns).
 *   - `patient` prefers `reask` while a re-ask is available, else `none`;
 *     it escalates only on trigger 5.
 * "Available" is `reasksPerSlot` remaining *and* at least one fixed letter in
 * the pattern (T62): an all-`?` re-ask is the same question the seed pass has
 * already asked, so under `reask-first` an empty domain with no fixed letter
 * escalates immediately rather than waiting for termination.
 * Trigger 5 always prefers `escalate`, for every policy - it is the one
 * last-resort attempt before repair/give-up, and `patient`'s "escalate only
 * on trigger 5" phrasing is unremarkable for the other two policies (they
 * already escalate elsewhere) but is the one place `patient` does so.
 */
function desiredAction(trigger: Trigger, ctx: EscalationContext): Action {
  if (trigger === 5) return 'escalate';

  const policy = ctx.profile.escalation.policy;
  if (policy === 'eager') return 'escalate';

  const available = reaskIsAvailable(ctx);
  if (policy === 'patient') return available ? 'reask' : 'none';
  return available ? 'reask' : 'escalate'; // reask-first (default)
}

function composeReason(trigger: Trigger, action: Action, blockers: readonly string[]): string {
  const base = `trigger ${trigger}: ${TRIGGER_LABEL[trigger]}`;
  if (blockers.length === 0) {
    return `${base}; action: ${action}`;
  }
  return `${base}; downgraded to ${action} because ${blockers.join(' and ')}`;
}

export function decide(ctx: EscalationContext): EscalationDecision {
  const trigger = detectTrigger(ctx);
  if (trigger === null) {
    return { action: 'none', reason: 'no escalation trigger matched' };
  }

  let action = desiredAction(trigger, ctx);
  const blockers: string[] = [];

  // Caps checked before any action: maxTier2CallsPerPuzzle, escalationsPerSlot,
  // reasksPerSlot. A cap that blocks the chosen action downgrades it
  // (escalate -> reask -> none), and the reason string names the cap. The
  // downgrade to `reask` also has to clear the fixed-letter condition, or the
  // policy would hand the hooks an ask they are bound to refuse.
  if (action === 'escalate') {
    const tier2Blocked = ctx.tier2CallsUsed >= ctx.profile.escalation.maxTier2CallsPerPuzzle;
    const slotBlocked = ctx.escalationsUsed >= ctx.profile.escalation.escalationsPerSlot;
    if (tier2Blocked) blockers.push(`${CAP_TIER2_PER_PUZZLE} is exhausted`);
    if (slotBlocked) blockers.push(`${CAP_ESCALATIONS_PER_SLOT} is exhausted`);
    if (tier2Blocked || slotBlocked) action = 'reask';
  }

  if (action === 'reask') {
    if (ctx.reasksUsed >= ctx.profile.reasksPerSlot) {
      blockers.push(`${CAP_REASKS_PER_SLOT} is exhausted`);
      action = 'none';
    } else if (ctx.patternFixedLetters === 0) {
      blockers.push(BLOCKER_NO_FIXED_LETTER);
      action = 'none';
    }
  }

  // give-up is returned only at search termination when no action remains
  // and the slot is still empty (which detectTrigger has already confirmed,
  // since trigger 5 only fires when ctx.domainSize === 0 at termination).
  if (action === 'none' && ctx.point === 'at-termination') {
    action = 'give-up';
  }

  return { action, trigger, reason: composeReason(trigger, action, blockers) };
}
