import { notImplemented } from '../util/errors.js';
import type { EscalationContext, EscalationDecision } from './types.js';

/**
 * T18 (B13): a pure function of its context, consulted after every
 * `getCandidates` return and once at search termination for each still-empty
 * slot. It owns all escalation caps.
 *
 * Triggers, in precedence order: (1) tier 1 returned unparseable JSON twice or
 * zero valid candidates; (2) a domain is empty after pattern filtering and one
 * constrained re-ask has already been tried; (3) `clue_understood` below the
 * threshold on the first pass; (4) the slot has caused three or more wipeouts;
 * (5) the slot is still empty when search terminates.
 */
export function decide(_ctx: EscalationContext): EscalationDecision {
  return notImplemented('src/policy/escalation.ts');
}
