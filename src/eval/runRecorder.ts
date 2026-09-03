import { notImplemented } from '../util/errors.js';
import type { EventHandler } from '../events/types.js';
import type { Profile } from '../profiles/schema.js';
import type { RunRecord } from './types.js';

export interface RunIdInput {
  /** Constrained to [A-Za-z0-9._-]+. */
  puzzleId: string;
  /** Constrained to [A-Za-z0-9._-]+. */
  profileName: string;
  profile: Profile;
  gitCommit: string;
  repeatIndex: number;
  /** Defaults to now; injected so tests are deterministic. */
  at?: Date;
}

export interface RunRecorderOptions {
  /** Defaults to `runs/<runId>.json`. */
  out?: string;
  /** Skip the puzzle-index upsert (used by tests). */
  updateIndex?: boolean;
}

export interface RunRecorder {
  handler: EventHandler;
  /** The record accumulated so far. */
  record(): RunRecord;
  /** Resolves once `run:end` has been written out. */
  written(): Promise<string>;
}

/**
 * B25: `${puzzleId}--${profileName}--${YYYYMMDD}T${HHmmss}Z--${shortHash}`,
 * with shortHash the first 8 hex of
 * `sha1(canonicalJson(profile) + gitCommit + repeatIndex)`.
 */
export function makeRunId(_input: RunIdInput): string {
  return notImplemented('src/eval/runRecorder.ts');
}

/** T17: accumulates the RunRecord, writes it on `run:end`, upserts the index. */
export function createRunRecorder(_opts: RunRecorderOptions): RunRecorder {
  return notImplemented('src/eval/runRecorder.ts');
}
