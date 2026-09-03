import { notImplemented } from '../util/errors.js';
import type { RepairFn } from './types.js';

/**
 * T42: from the possibly partial fill, propose 1-2 letter edits where each
 * changed letter appears in some candidate returned by `service.peek()` for
 * any crossing slot, or the result is in the word list; score survivors by
 * re-asking tier 1, and accept improving edits until none remain or
 * `repair.maxCalls` is spent.
 */
export const repair: RepairFn = () => notImplemented('src/solver/repair.ts');
