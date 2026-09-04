import type { Level, SolverEventType } from './types.js';

/**
 * The minimum verbosity level at which each event is shown. A renderer
 * subscribing at level L sees events whose minimum level is at most L.
 *
 * The `satisfies` clause is what makes this exhaustive: adding an event type
 * to the union without a level here is a compile error, and so is a level for
 * an event type that does not exist.
 */
export const MIN_LEVEL = {
  'run:start': 0,
  'grid:init': 0,
  'phase:start': 0,
  'phase:end': 0,
  progress: 0,
  'grid:final': 0,
  'score:final': 0,
  'cost:summary': 0,
  'budget:hit': 0,
  'run:end': 0,

  'slot:ask': 1,
  'slot:candidates': 1,
  'search:assign': 1,
  'slot:reask': 1,
  'slot:escalate': 1,
  'repair:accept': 1,
  'rate:limited': 1,

  'pattern:built': 2,
  'candidate:reject': 2,
  'domain:filtered': 2,
  'search:forwardcheck': 2,
  'search:wipeout': 2,
  'search:unassign': 2,
  'search:backtrack': 2,
  'ac3:reduce': 2,
  'ac3:wipeout': 2,
  'lds:restart': 2,
  'repair:propose': 2,
  'repair:reject': 2,
  'rate:adjusted': 2,
  'policy:refused': 2,

  'llm:request': 3,
  'llm:response': 3,
  'cache:lookup': 3,
  'llm:usage': 3,
  'ac3:arc': 3,
  'phase:timing': 3,
} as const satisfies Record<SolverEventType, Level>;

/** True when an event should be shown to a renderer subscribed at `level`. */
export function isVisibleAt(type: SolverEventType, level: Level): boolean {
  return MIN_LEVEL[type] <= level;
}
