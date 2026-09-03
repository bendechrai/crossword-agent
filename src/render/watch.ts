import { notImplemented } from '../util/errors.js';
import type { SolverEvent } from '../events/types.js';

export interface WatchRendererOptions {
  color?: boolean;
  columns?: number;
  /** Injected so the TTY rules (B31) can be tested without a terminal. */
  isTty?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * T39: `log-update` full-frame redraw on `search:assign`, `search:unassign`,
 * `repair:accept` and `progress`. The grid comes from `grid:init` (B32), never
 * inferred. Honoured only when `process.stdout.isTTY && !process.env.CI &&
 * process.env.TERM !== 'dumb'`; otherwise it prints one stderr line and falls
 * back to `ConsoleRenderer(0)`.
 */
export class WatchRenderer {
  constructor(_opts: WatchRendererOptions = {}) {
    notImplemented('src/render/watch.ts');
  }

  handle(_event: SolverEvent): void {
    return notImplemented('src/render/watch.ts');
  }
}
