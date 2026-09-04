import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { notFoundError, usageError } from '../cli/exit.js';
import { log } from '../util/log.js';
import type { RunRecord } from './types.js';

/**
 * T59: reads past `RunRecord`s out of a runs directory (the same directory
 * `src/eval/runRecorder.ts` writes `<runId>.json` into by default) for
 * `xw show --run`.
 *
 * Every function here tolerates a runs directory that does not exist yet (an
 * empty result, not an error - a fresh checkout has run nothing) and skips,
 * with one `log.warn` line each, any `*.json` entry that fails to read,
 * fails to parse, or does not look like a `RunRecord`. `*.events.jsonl`
 * trace files (`src/render/jsonl.ts`) are never even opened: the directory
 * listing is filtered to entries ending in `.json` before anything is read,
 * and a name ending in `.events.jsonl` does not end in `.json`.
 */

interface RunFile {
  path: string;
  record: RunRecord;
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return JSON.stringify(cause) ?? 'unknown error';
}

/**
 * A loose structural check, not full schema validation: enough to reject "an
 * unrelated JSON file that happens to live in the runs dir" without pulling
 * in ajv or `schemas/run-record.schema.json` for a read-only CLI view.
 */
function looksLikeRunRecord(value: unknown): value is RunRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['runId'] !== 'string') return false;
  if (typeof v['timestamp'] !== 'string') return false;
  if (!Array.isArray(v['perSlot'])) return false;

  const puzzle = v['puzzle'];
  if (typeof puzzle !== 'object' || puzzle === null) return false;
  if (typeof (puzzle as Record<string, unknown>)['id'] !== 'string') return false;

  const profile = v['profile'];
  if (typeof profile !== 'object' || profile === null) return false;

  const accuracy = v['accuracy'];
  if (typeof accuracy !== 'object' || accuracy === null) return false;

  return true;
}

/** Every `*.json` file in `runsDir`, parsed and shape-checked, unreadable and foreign ones skipped. */
async function readRunFiles(runsDir: string): Promise<RunFile[]> {
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    // No runs directory at all yet: an empty result, not an error.
    return [];
  }

  const out: RunFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const path = join(runsDir, entry);

    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      log.warn(`show --run: skipping unreadable file ${path}: ${describeCause(error)}`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      log.warn(`show --run: skipping non-JSON file ${path}: ${describeCause(error)}`);
      continue;
    }

    if (!looksLikeRunRecord(parsed)) {
      log.warn(`show --run: skipping ${path}: does not look like a run record`);
      continue;
    }

    out.push({ path, record: parsed });
  }
  return out;
}

/** Every run record in `runsDir` for `puzzleId`, in no particular order. */
export async function listRuns(runsDir: string, puzzleId: string): Promise<RunRecord[]> {
  const files = await readRunFiles(runsDir);
  return files.filter((f) => f.record.puzzle.id === puzzleId).map((f) => f.record);
}

/** The run record for `puzzleId` with the latest `timestamp`, or `null` when there is none. */
export async function latestRun(runsDir: string, puzzleId: string): Promise<RunRecord | null> {
  const records = await listRuns(runsDir, puzzleId);
  const [first, ...rest] = records;
  if (first === undefined) return null;
  return rest.reduce(
    (latest, candidate) => (Date.parse(candidate.timestamp) > Date.parse(latest.timestamp) ? candidate : latest),
    first,
  );
}

/**
 * Resolves a full run id or a unique prefix of one, scanning every record in
 * `runsDir` regardless of which puzzle it belongs to (the caller checks that
 * separately - see `src/cli/show.ts` - because naming both ids in the error
 * needs the caller's target puzzle id, which this function does not take).
 *
 * Throws `notFoundError` (exit 3) when nothing matches, or `usageError`
 * (exit 2) listing the candidate run ids when the prefix matches more than
 * one record and none of them is an exact match.
 */
export async function findRun(runsDir: string, runIdOrPrefix: string): Promise<RunRecord> {
  const files = await readRunFiles(runsDir);

  const exact = files.find((f) => f.record.runId === runIdOrPrefix);
  if (exact !== undefined) return exact.record;

  const prefixed = files.filter((f) => f.record.runId.startsWith(runIdOrPrefix));
  const [first, ...rest] = prefixed;
  if (first === undefined) {
    throw notFoundError(`no run record found for id or prefix "${runIdOrPrefix}" under ${runsDir}`);
  }
  if (rest.length > 0) {
    const candidates = prefixed.map((f) => f.record.runId).sort();
    throw usageError(`run id prefix "${runIdOrPrefix}" is ambiguous: matches ${candidates.join(', ')}`);
  }
  return first.record;
}
