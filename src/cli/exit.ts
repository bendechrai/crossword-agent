/**
 * Exit codes, defined once (B28).
 *
 * There is exactly one top-level catch, in `src/cli/index.ts`, which prints a
 * `CliError`'s message (and hint, when present) to stderr and exits with its
 * code. Nothing else in the codebase calls `process.exit`.
 */
export enum ExitCode {
  /** Command completed, including a partial fill. */
  OK = 0,
  /** Not a CliError: a stack trace is printed. This is a bug. */
  UNEXPECTED = 1,
  /** Bad flags, unknown profile, invalid profile or config file. */
  USAGE = 2,
  /** Puzzle, run record, set or fixture not found; parse failure. */
  NOT_FOUND = 3,
  /** `--offline` and the cache lacks the query. */
  OFFLINE_MISS = 4,
  /** Transport failure after retries, or an uncovered provider error. */
  PROVIDER = 5,
  /** `bench` finished with at least one run errored. */
  BENCH_PARTIAL = 6,
}

export class CliError extends Error {
  readonly code: ExitCode;
  readonly hint?: string;

  constructor(code: ExitCode, message: string, hint?: string) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}

export function isCliError(e: unknown): e is CliError {
  return e instanceof CliError;
}

export const usageError = (message: string, hint?: string): CliError =>
  new CliError(ExitCode.USAGE, message, hint);

export const notFoundError = (message: string, hint?: string): CliError =>
  new CliError(ExitCode.NOT_FOUND, message, hint);

export const offlineMissError = (message: string, hint?: string): CliError =>
  new CliError(ExitCode.OFFLINE_MISS, message, hint);

export const providerError = (message: string, hint?: string): CliError =>
  new CliError(ExitCode.PROVIDER, message, hint);
