/**
 * Minimal leveled logger for bootstrap and fatal-error lines.
 *
 * Leveled output is the event stream's job; this exists only for the handful
 * of lines that happen before or outside a run. It writes to stderr so it can
 * never interleave with a renderer's stdout frame.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function parseLevel(raw: string | undefined, fallback: LogLevel): LogLevel {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  return value in ORDER ? (value as LogLevel) : fallback;
}

let current: LogLevel = parseLevel(process.env['CROSSWORD_LOG_LEVEL'], 'warn');

export function getLogLevel(): LogLevel {
  return current;
}

export function setLogLevel(level: LogLevel): void {
  current = level;
}

function write(level: Exclude<LogLevel, 'silent'>, args: unknown[]): void {
  if (ORDER[level] > ORDER[current]) return;
  const parts = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a)));
  process.stderr.write(`${level}: ${parts.join(' ')}\n`);
}

export const log = {
  error: (...args: unknown[]): void => write('error', args),
  warn: (...args: unknown[]): void => write('warn', args),
  info: (...args: unknown[]): void => write('info', args),
  debug: (...args: unknown[]): void => write('debug', args),
};

const warnedOnce = new Set<string>();

/** Warn at most once per key, for the "no word list loaded" class of message. */
export function warnOnce(key: string, ...args: unknown[]): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  log.warn(...args);
}
