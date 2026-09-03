import { log } from '../util/log.js';
import type { EmittedEvent, EventBus, EventHandler, SolverEvent } from './types.js';

export interface EventBusOptions {
  runId: string;
  /** Defaults to `Date.now`; injected so tests get deterministic `tMs`. */
  now?: () => number;
}

/**
 * T15: synchronous, ordered event bus. It stamps `runId`, `seq` and `tMs` so
 * no producer has to.
 *
 * `seq` starts at 0 and increments once per `emit`. `tMs` is elapsed
 * milliseconds since bus construction, measured through the injectable
 * `now()` so tests get deterministic timestamps. A handler that throws is
 * caught, logged once via `src/util/log.ts`, and never prevents the
 * remaining handlers (registered before or after it) from seeing the event.
 */
export function createEventBus(opts: EventBusOptions): EventBus {
  const { runId } = opts;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  let seq = 0;
  // A plain array, not a Set: handlers must be notified in registration
  // order, and the same handler function could conceivably be registered
  // more than once.
  let handlers: EventHandler[] = [];

  return {
    on(handler: EventHandler): void {
      handlers.push(handler);
    },
    off(handler: EventHandler): void {
      handlers = handlers.filter((h) => h !== handler);
    },
    emit(event: EmittedEvent): void {
      const stamped: SolverEvent = {
        ...event,
        runId,
        seq: seq++,
        tMs: now() - startedAt,
      };

      // Snapshot the handler list so a handler that calls `off` on itself
      // (or registers a new handler) mid-emit does not change who sees this
      // particular event.
      for (const handler of [...handlers]) {
        try {
          handler(stamped);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          log.warn(`event handler threw for "${stamped.type}" (seq ${stamped.seq}): ${reason}`);
        }
      }
    },
  };
}
