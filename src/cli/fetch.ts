import { notImplemented } from '../util/errors.js';
import type { FetchOptions, GlobalOptions } from './options.js';

/**
 * T29: resolve the adapter, `list()`, then per ref download, write the
 * original, parse, write the normalised JSON (B16) and upsert the index row
 * (B34). Exit 3 if the source returns nothing.
 */
export function fetchCommand(
  _source: string,
  _opts: FetchOptions,
  _global: GlobalOptions,
): Promise<void> {
  return notImplemented('src/cli/fetch.ts');
}
