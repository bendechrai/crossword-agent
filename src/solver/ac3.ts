import { notImplemented } from '../util/errors.js';
import type { Ac3Fn } from './types.js';

/**
 * T36: the AC-3 prepass. On a wipeout, restore the domain, mark the slot
 * suspect, remove every arc incident on that slot from the worklist for the
 * rest of the prepass, and emit `ac3:wipeout` once per slot (B40).
 */
export const ac3: Ac3Fn = () => notImplemented('src/solver/ac3.ts');
