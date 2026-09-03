import { notImplemented } from '../util/errors.js';
import type { GlobalOptions, ShowOptions } from './options.js';

/**
 * T30: prints the numbered grid (blocks as `#`, letters as `.` unless
 * `--solution`) plus the across and down clue lists.
 */
export function showCommand(
  _id: string,
  _opts: ShowOptions,
  _global: GlobalOptions,
): Promise<void> {
  return notImplemented('src/cli/show.ts');
}
