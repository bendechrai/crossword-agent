import { notImplemented } from '../util/errors.js';
import type { GlobalOptions, SolveOptions } from './options.js';

/**
 * T45: resolve the profile, resolve `<id|path>` (B16), construct the real
 * `SolveDeps`, attach the renderers per `-v/-vv/-vvv`, `--watch` (B31) and
 * `--trace`, run `solve()` and write the run record.
 *
 * Exit 0 even on a partial fill; exit 4 on an offline miss (B6); exit 5 on a
 * provider failure.
 */
export function solveCommand(
  _target: string,
  _opts: SolveOptions,
  _global: GlobalOptions,
): Promise<void> {
  return notImplemented('src/cli/solve.ts');
}
