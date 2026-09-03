import { closeSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { ensureDir, resolveInferenceLogDir } from '../util/fs.js';
import { log } from '../util/log.js';
import type { InferenceLog, InferenceLogRecord } from './types.js';

export interface InferenceLogOptions {
  /** Defaults to `resolveInferenceLogDir()`. */
  dir?: string;
  /** `false` returns a no-op sink (`--no-inference-log`). */
  enabled?: boolean;
  /** Injectable clock; only its UTC date matters. Defaults to `() => new Date()`. */
  now?: () => Date;
}

const NOOP_LOG: InferenceLog = {
  write(): void {
    // `enabled: false`: no file, no directory, nothing written (acceptance 3).
  },
  close(): void {},
};

function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * T10: append-only JSONL at `<dir>/<YYYY-MM-DD>.jsonl`, one `InferenceLogRecord`
 * per line, through a single open file descriptor per process per day (one
 * `openSync`/`writeSync` pair, reopened only when the UTC date rolls over or
 * after a prior open failed). `write()` is fire-and-forget: a failure - a
 * record that cannot be serialised (e.g. a circular reference) or a directory
 * that cannot be created or written to - logs one warning through `util/log`
 * (naming the record id where one is known) and never throws. `enabled: false`
 * returns a no-op sink that touches no file and no directory. `close()`
 * flushes by closing the descriptor; a later `write()` reopens it.
 */
export function openInferenceLog(opts: InferenceLogOptions = {}): InferenceLog {
  if (opts.enabled === false) return NOOP_LOG;

  const dir = opts.dir ?? resolveInferenceLogDir();
  const now = opts.now ?? ((): Date => new Date());

  let fd: number | null = null;
  let currentDate: string | null = null;
  let warned = false;

  function warnOnce(context: string, err: unknown): void {
    if (warned) return;
    warned = true;
    log.warn(`inference log: ${context}: ${messageOf(err)}`);
  }

  function closeFd(): void {
    if (fd === null) return;
    const handle = fd;
    fd = null;
    currentDate = null;
    try {
      closeSync(handle);
    } catch {
      // Best-effort: nothing more we can do about a failed close, and a
      // process already tearing down is not a reason to throw.
    }
  }

  /** Opens (or reuses) today's file descriptor. Throws on failure; callers catch. */
  function fdFor(dateStr: string): number {
    if (fd !== null && currentDate === dateStr) return fd;
    closeFd();
    ensureDir(dir);
    const opened = openSync(join(dir, `${dateStr}.jsonl`), 'a');
    fd = opened;
    currentDate = dateStr;
    return opened;
  }

  function write(record: InferenceLogRecord): void {
    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch (err) {
      // Decision: a circular record is a programming error, not an I/O
      // failure, but it still must never throw out of write() - warn by id.
      warnOnce(`failed to serialise record ${record.id}`, err);
      return;
    }
    try {
      writeSync(fdFor(utcDateString(now())), line);
    } catch (err) {
      warnOnce(`failed to write record ${record.id}`, err);
    }
  }

  function close(): void {
    closeFd();
  }

  return { write, close };
}
