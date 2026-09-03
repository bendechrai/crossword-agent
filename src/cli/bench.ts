import { notImplemented } from '../util/errors.js';
import type { BenchOptions, GlobalOptions } from './options.js';

/**
 * T47: the `(puzzle, profile, repeat)` matrix. A usage error is raised before
 * any run starts; a per-run exit 4 or 5 marks that run errored and the matrix
 * continues; the command exits 6 if any run errored, and a `--max-usd` abort
 * also exits 6 (B28, B45).
 */
export function benchCommand(
  _puzzleSet: string,
  _opts: BenchOptions,
  _global: GlobalOptions,
): Promise<void> {
  return notImplemented('src/cli/bench.ts');
}
