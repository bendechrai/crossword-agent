import { notImplemented } from '../util/errors.js';
import type { CacheClearOptions, GlobalOptions } from './options.js';

/** T35: entry count, disk bytes, last-run hit rate, breakdowns; warns above 1 GB. */
export function cacheStatsCommand(_global: GlobalOptions): Promise<void> {
  return notImplemented('src/cli/cache.ts');
}

export function cacheClearCommand(
  _opts: CacheClearOptions,
  _global: GlobalOptions,
): Promise<void> {
  return notImplemented('src/cli/cache.ts');
}

/** How the committed test cache is produced (T50). */
export function cacheExportCommand(_file: string, _global: GlobalOptions): Promise<void> {
  return notImplemented('src/cli/cache.ts');
}

export function cacheImportCommand(_file: string, _global: GlobalOptions): Promise<void> {
  return notImplemented('src/cli/cache.ts');
}
