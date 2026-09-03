import { notImplemented } from '../util/errors.js';
import type { SearchFn } from './types.js';

/**
 * T37: depth-first assignment with forward checking over the trailed
 * DomainStore, margin ordering and LDS restarts. It calls `hooks` at the
 * declared points and never touches the candidate service directly.
 */
export const search: SearchFn = () => notImplemented('src/solver/search.ts');
