import { notImplemented } from '../util/errors.js';
import type { EventBus } from './types.js';

export interface EventBusOptions {
  runId: string;
  /** Defaults to `Date.now`; injected so tests get deterministic `tMs`. */
  now?: () => number;
}

/**
 * T15: synchronous, ordered event bus. It stamps `runId`, `seq` and `tMs` so
 * no producer has to.
 */
export function createEventBus(_opts: EventBusOptions): EventBus {
  return notImplemented('src/events/bus.ts');
}
