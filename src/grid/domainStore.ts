import { notImplemented } from '../util/errors.js';
import type { DomainStore } from './types.js';

/**
 * T4 (B39): domains with a depth-indexed trail. Forward-check and AC-3
 * reductions are trailed and undone exactly on backtrack; a merged re-ask or
 * escalation result goes into the base domain and survives every `pop()`.
 */
export function createDomainStore(): DomainStore {
  return notImplemented('src/grid/domainStore.ts');
}
