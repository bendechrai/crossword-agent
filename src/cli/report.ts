import { notImplemented } from '../util/errors.js';
import type { GlobalOptions, ReportOptions } from './options.js';

/**
 * T46: aggregates a glob of run records, or with `--inference` reads
 * `logs/inference/*.jsonl` through `eval/inference.ts` instead. The `--md`
 * output is what gets committed under `docs/benches/` (B47).
 */
export function reportCommand(_opts: ReportOptions, _global: GlobalOptions): Promise<void> {
  return notImplemented('src/cli/report.ts');
}
