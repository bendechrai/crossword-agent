import { notImplemented } from '../util/errors.js';
import type { GlobalOptions, ListOptions } from './options.js';

/**
 * T30: reads only the index, so it works offline. B33: an empty index prints
 * `no puzzles yet - try: xw fetch xd --limit 5` and exits 0, `--json` prints
 * `[]`, and null metrics render as `-`.
 */
export function listCommand(_opts: ListOptions, _global: GlobalOptions): Promise<void> {
  return notImplemented('src/cli/list.ts');
}
