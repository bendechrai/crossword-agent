import { notImplemented } from '../util/errors.js';
import type { Level, SolverEvent } from '../events/types.js';

export interface ConsoleRendererOptions {
  color?: boolean;
  /** Terminal width; 80 when `process.stdout.columns` is undefined (B31). */
  columns?: number;
}

/**
 * T14: one line per accepted event, prefixed with elapsed ms and slot id.
 * Level 0 additionally prints the final grid, the diff against the solution
 * and the score and cost blocks. Filtering is driven by MIN_LEVEL, never by a
 * switch in the renderer.
 */
export class ConsoleRenderer {
  constructor(
    _level: Level,
    _stream: NodeJS.WritableStream,
    _opts: ConsoleRendererOptions = {},
  ) {
    notImplemented('src/render/console.ts');
  }

  handle(_event: SolverEvent): void {
    return notImplemented('src/render/console.ts');
  }
}
