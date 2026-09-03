import { notImplemented } from '../util/errors.js';
import type { SolveFn } from './types.js';

/**
 * T44: the 8 steps in order, with the event emissions the spec's pipeline
 * section brackets. Hitting a budget cap emits `budget:hit`, ends the current
 * phase gracefully and proceeds to the next; it never throws and never skips
 * step 8.
 */
export const solve: SolveFn = () => notImplemented('src/solver/solve.ts');
