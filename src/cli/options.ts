import { usageError } from './exit.js';
import type { Level } from '../events/types.js';
import type { GroupBy } from '../eval/aggregate.js';

/** Options every subcommand sees. */
export interface GlobalOptions {
  config?: string;
  cacheDir?: string;
  /** False when `--no-color` was given or NO_COLOR is set. */
  color: boolean;
}

export interface FetchOptions {
  series?: string;
  date?: string;
  from?: string;
  to?: string;
  limit: number;
  out: string;
  path?: string;
}

export interface ListOptions {
  source?: string;
  style?: string;
  solved: boolean;
  json: boolean;
}

export interface ShowOptions {
  solution: boolean;
  /**
   * `--run [runId]` (T59): `undefined` when the flag was not given, `true`
   * for the bare flag (latest run for the puzzle), or the given run id / id
   * prefix.
   */
  run?: boolean | string;
}

export interface SolveOptions {
  profile: string;
  tier1?: string;
  tier2?: string;
  verbose: Level;
  watch: boolean;
  offline: boolean;
  offlineLenient: boolean;
  budgetUsd?: number;
  seed?: number;
  trace: boolean;
  /** False when `--no-inference-log` was given. */
  inferenceLog: boolean;
  out?: string;
}

export interface BenchOptions {
  profiles: string[];
  repeat: number;
  offline: boolean;
  offlineLenient: boolean;
  concurrency: number;
  maxUsd: number;
  yes: boolean;
  inferenceLog: boolean;
  out: string;
}

export interface ReportOptions {
  runs: string;
  compare?: string[];
  by: GroupBy;
  json: boolean;
  md: boolean;
  inference: boolean;
  since?: string;
  until?: string;
  model?: string;
  run?: string;
  slot?: string;
  dump: boolean;
}

export interface CacheClearOptions {
  model?: string;
  promptVersion?: string;
}

export function parseIntOption(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || String(n) !== value.trim()) {
    throw usageError(`expected an integer, got "${value}"`);
  }
  return n;
}

export function parseUsdOption(value: string): number {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n < 0) {
    throw usageError(`expected a non-negative amount in USD, got "${value}"`);
  }
  return n;
}

export function parseCsvOption(value: string): string[] {
  const parts = value
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw usageError(`expected a comma-separated list, got "${value}"`);
  }
  return parts;
}

/**
 * `-v`, `-vv`, `-vvv`; commander expands the combined short form for us and
 * passes no value, so only `previous` matters.
 */
export function increaseVerbosity(_value: unknown, previous: number): Level {
  const next = previous + 1;
  return (next > 3 ? 3 : next) as Level;
}

const GROUP_BY: ReadonlyArray<GroupBy> = ['profile', 'puzzle', 'tier', 'stratum', 'batchIndex'];

export function parseGroupBy(value: string): GroupBy {
  if (!(GROUP_BY as ReadonlyArray<string>).includes(value)) {
    throw usageError(`unknown --by value "${value}"`, `expected one of: ${GROUP_BY.join(', ')}`);
  }
  return value as GroupBy;
}
