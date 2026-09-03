import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';

import type { RejectReason } from '../candidates/types.js';
import type { EventHandler, ScoredAnswer, SolverEvent } from '../events/types.js';
import type { BudgetHit } from '../policy/types.js';
import type { ParsedBy, PuzzleIndexRow, PuzzleStyle, Stratum } from '../puzzle/types.js';
import type { Profile, ProfileSource } from '../profiles/schema.js';
import { atomicWriteFile, repoRoot, resolveRunsDir } from '../util/fs.js';
import { readGitCommit } from '../util/git.js';
import { canonicalJson, sha1 } from '../util/hash.js';
import { log } from '../util/log.js';
import type { Accuracy, PerSlotRecord, ProducedByTier, RunRecord, RunStatus, TierCallStats } from './types.js';

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

/** The pieces of `RunRecord.puzzle` that never appear on the event stream. */
export interface RunRecorderPuzzleInfo {
  id: string;
  source: string;
  style: PuzzleStyle;
  stratum: Stratum;
  /** For example "15x15". */
  size: string;
  slots: number;
}

/**
 * The fields `puzzles/index.json` needs beyond what a `RunRecord` already
 * carries, plus the writer itself. Injected rather than imported: T21 owns
 * `src/puzzle/library.ts` and this task must not import a sibling wave-mate's
 * implementation module directly (only the T0 contract in `puzzle/types.ts`
 * is safe to read). The caller - once T21 is merged - passes
 * `upsertIndexRow` from that module, `readIndex()`'s prior row for this
 * puzzle id if one exists, and the fields the RunRecorder cannot derive from
 * `RunRecorderOptions` or the event stream.
 */
export interface RunRecorderIndexUpdate {
  upsertIndexRow: (row: PuzzleIndexRow) => Promise<void>;
  date: string | null;
  title: string | null;
  width: number;
  height: number;
  files: { original: string; normalised: string };
  parsedBy: ParsedBy;
  /** The existing row for this puzzle id, if `readIndex()` found one. */
  previousRow?: PuzzleIndexRow | null;
}

export interface RunRecorderOptions {
  puzzle: RunRecorderPuzzleInfo;
  /** slotId -> the correct answer, normalised A-Z (B11's solution grid, by slot). */
  truth: Readonly<Record<string, string>>;
  profile: Profile;
  profileSource: ProfileSource;
  repeatIndex: number;
  /** Defaults to `readGitCommit()`. */
  gitCommit?: string;
  /** Defaults to `process.version`. */
  nodeVersion?: string;
  /** Defaults to the `version` field of the repo's package.json. */
  packageVersion?: string;
  /** Defaults to real time; injected so tests are deterministic. */
  now?: () => Date;
  /** Defaults to `runs/<runId>.json`. */
  out?: string;
  /** Upserts `puzzles/index.json` on `run:end`; omitted (or `false`) skips it. */
  updateIndex?: false | RunRecorderIndexUpdate;
}

export interface RunRecorder {
  handler: EventHandler;
  /** The record accumulated so far. */
  record(): RunRecord;
  /**
   * Resolves with the record's path once `run:end` has been written out.
   *
   * Rejects with `IndexUpsertError` when the record was written but the
   * injected `updateIndex.upsertIndexRow` failed - the record is still on
   * disk at `error.recordPath` in that case. Rejects with the underlying
   * error when the record write itself failed, and when it is called before
   * `run:end` has been seen.
   */
  written(): Promise<string>;
}

/**
 * Renders an unknown thrown value as a one-line message.
 *
 * The index writer is injected, so what it rejects with is not this module's
 * to assume: an `Error`, a string and a plain object all have to read
 * sensibly when they end up inside `IndexUpsertError`'s message.
 */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return JSON.stringify(cause) ?? 'unknown error';
}

/**
 * Rejects `written()` when the run record itself was written but the
 * `puzzles/index.json` upsert that follows it failed.
 *
 * The expected cause is the index writer's `puzzles/.index.lock` timeout
 * (spec "Library layout": 5 s, "then a clear error"), which is exactly what
 * `bench` at concurrency 2 or more produces. The record is already durable
 * at `recordPath` when this is thrown, so a caller can report the missing
 * index row without discarding the run - but it is never swallowed, because
 * a silently dropped row is the failure mode the lock exists to prevent.
 */
export class IndexUpsertError extends Error {
  /** Path of the run record that was written before the upsert failed. */
  readonly recordPath: string;

  /** The sanitised puzzle id whose `puzzles/index.json` row was not written. */
  readonly puzzleId: string;

  constructor(recordPath: string, puzzleId: string, cause: unknown) {
    super(
      `run record written to ${recordPath}, but the puzzles/index.json upsert for puzzle "${puzzleId}" failed: ${describeCause(cause)}`,
      { cause },
    );
    this.name = 'IndexUpsertError';
    this.recordPath = recordPath;
    this.puzzleId = puzzleId;
  }
}

const SAFE_ID_CHAR = /[^A-Za-z0-9._-]/g;

/**
 * B25: a character outside `[A-Za-z0-9._-]` is replaced with `-` before the
 * run id is built. The substitution is recorded in the record: the sanitised
 * value is what ends up in both the run id and `RunRecord.puzzle.id`, so a
 * reader can see the substitution just by comparing it with the source
 * puzzle's own id.
 */
function sanitiseIdComponent(raw: string): string {
  return raw.replace(SAFE_ID_CHAR, '-');
}

function formatRunTimestamp(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const year = at.getUTCFullYear();
  const month = pad(at.getUTCMonth() + 1);
  const day = pad(at.getUTCDate());
  const hours = pad(at.getUTCHours());
  const minutes = pad(at.getUTCMinutes());
  const seconds = pad(at.getUTCSeconds());
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

/**
 * B25: `${puzzleId}--${profileName}--${YYYYMMDD}T${HHmmss}Z--${shortHash}`,
 * with shortHash the first 8 hex of
 * `sha1(canonicalJson(profile) + gitCommit + repeatIndex)`.
 */
export function makeRunId(input: RunIdInput): string {
  const puzzleId = sanitiseIdComponent(input.puzzleId);
  const profileName = sanitiseIdComponent(input.profileName);
  const timestamp = formatRunTimestamp(input.at ?? new Date());
  const hashInput = `${canonicalJson(input.profile)}${input.gitCommit}${input.repeatIndex}`;
  const shortHash = sha1(hashInput).slice(0, 8);
  return `${puzzleId}--${profileName}--${timestamp}--${shortHash}`;
}

const REJECT_REASONS: readonly RejectReason[] = [
  'length',
  'charset',
  'pattern',
  'clue-echo',
  'duplicate',
  'rejected-before',
];

function zeroRejectCounts(): Record<RejectReason, number> {
  const out = {} as Record<RejectReason, number>;
  for (const reason of REJECT_REASONS) out[reason] = 0;
  return out;
}

interface MutableSlot {
  slotId: string;
  clue: string;
  length: number;
  filled: string | null;
  producedBy: ProducedByTier | null;
  batchIndex: number | null;
  truthInCandidates: boolean;
  truthRank: number | null;
  rejectCounts: Record<RejectReason, number>;
  parseFailures: number;
  latencyMs: number;
  usd: number;
  reasks: number;
  escalated: boolean;
  candidatesSeen: number;
  pickedRank: number | null;
  lastAccepted: ScoredAnswer[];
}

function newMutableSlot(slotId: string, clue: string, length: number): MutableSlot {
  return {
    slotId,
    clue,
    length,
    filled: null,
    producedBy: null,
    batchIndex: null,
    truthInCandidates: false,
    truthRank: null,
    rejectCounts: zeroRejectCounts(),
    parseFailures: 0,
    latencyMs: 0,
    usd: 0,
    reasks: 0,
    escalated: false,
    candidatesSeen: 0,
    pickedRank: null,
    lastAccepted: [],
  };
}

interface MutableTierStats {
  count: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  usdBilled: number;
  usdCounterfactual: number;
  cacheHits: number;
  latencies: number[];
}

function newMutableTierStats(): MutableTierStats {
  return {
    count: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    usdBilled: 0,
    usdCounterfactual: 0,
    cacheHits: 0,
    latencies: [],
  };
}

function finaliseTierStats(stats: MutableTierStats): TierCallStats {
  const avgLatencyMs =
    stats.latencies.length === 0
      ? 0
      : stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length;
  return {
    count: stats.count,
    promptTokens: stats.promptTokens,
    completionTokens: stats.completionTokens,
    reasoningTokens: stats.reasoningTokens,
    usdBilled: stats.usdBilled,
    usdCounterfactual: stats.usdCounterfactual,
    cacheHits: stats.cacheHits,
    avgLatencyMs,
  };
}

function readPackageVersion(): string {
  try {
    const text = readFileSync(join(repoRoot(), 'package.json'), 'utf8');
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function resolveOutPath(out: string | undefined, runId: string): string {
  if (out === undefined) return join(resolveRunsDir(), `${runId}.json`);
  return isAbsolute(out) ? out : resolvePath(repoRoot(), out);
}

/** T17: accumulates the RunRecord, writes it on `run:end`, upserts the index. */
export function createRunRecorder(opts: RunRecorderOptions): RunRecorder {
  const now = opts.now ?? (() => new Date());
  const gitCommit = opts.gitCommit ?? readGitCommit();
  const nodeVersion = opts.nodeVersion ?? process.version;
  const packageVersion = opts.packageVersion ?? readPackageVersion();

  const safePuzzleId = sanitiseIdComponent(opts.puzzle.id);
  const createdAt = now();
  const runId = makeRunId({
    puzzleId: opts.puzzle.id,
    profileName: opts.profile.name,
    profile: opts.profile,
    gitCommit,
    repeatIndex: opts.repeatIndex,
    at: createdAt,
  });

  let models = { tier1: opts.profile.tier1, tier2: opts.profile.tier2 };
  let seed: number | null = null;

  const slots = new Map<string, MutableSlot>();
  const search = { backtracks: 0, discrepancies: 0, wipeouts: 0, ac3Reductions: 0 };
  const repair = { proposals: 0, accepted: 0 };
  const budgetHits: BudgetHit[] = [];
  const calls: Record<'tier1' | 'tier2', MutableTierStats> = {
    tier1: newMutableTierStats(),
    tier2: newMutableTierStats(),
  };
  /**
   * Best-effort correlation of an `llm:usage` event (which carries no
   * slotId) back to the slot that triggered it. `cache:lookup` is emitted
   * for every attempt, hit or miss, with a slotId; a call's own events are
   * internally ordered even when interleaved with a concurrent call's, so a
   * single FIFO queue pairs them up as long as usage events arrive in the
   * same order their lookups did.
   */
  const pendingLookups: Array<{ slotId: string | null; hit: boolean }> = [];

  let accuracy: Accuracy = { letters: 0, words: 0, perfect: false, emptyCells: 0 };
  let wallMs = 0;
  let finalStatus: RunStatus = 'ok';
  // No event on the stream carries an error message (RunEndEvent has only
  // `status`); until one does, an errored run's `error` field stays unset
  // rather than fabricated.
  const finalError: string | undefined = undefined;
  let ended = false;

  function getSlot(slotId: string, clue = '', length = 0): MutableSlot {
    let slot = slots.get(slotId);
    if (slot === undefined) {
      slot = newMutableSlot(slotId, clue, length);
      slots.set(slotId, slot);
    }
    return slot;
  }

  function modelTier(model: string): 'tier1' | 'tier2' | null {
    if (model === models.tier1) return 'tier1';
    if (model === models.tier2) return 'tier2';
    return null;
  }

  function buildPerSlot(): PerSlotRecord[] {
    const rows: PerSlotRecord[] = [];
    for (const slot of slots.values()) {
      const truth = opts.truth[slot.slotId] ?? '';
      const correct =
        slot.filled !== null && truth.length > 0 && slot.filled.toUpperCase() === truth.toUpperCase();
      rows.push({
        slotId: slot.slotId,
        clue: slot.clue,
        length: slot.length,
        truth,
        filled: slot.filled,
        correct,
        producedBy: slot.producedBy,
        batchIndex: slot.batchIndex,
        truthInCandidates: slot.truthInCandidates,
        truthRank: slot.truthRank,
        rejectCounts: { ...slot.rejectCounts },
        parseFailures: slot.parseFailures,
        latencyMs: slot.latencyMs,
        usd: slot.usd,
        reasks: slot.reasks,
        escalated: slot.escalated,
        candidatesSeen: slot.candidatesSeen,
        pickedRank: slot.pickedRank,
      });
    }
    return rows;
  }

  function buildRecord(): RunRecord {
    const record: RunRecord = {
      runId,
      timestamp: createdAt.toISOString(),
      status: finalStatus,
      puzzle: {
        id: safePuzzleId,
        source: opts.puzzle.source,
        style: opts.puzzle.style,
        stratum: opts.puzzle.stratum,
        size: opts.puzzle.size,
        slots: opts.puzzle.slots,
      },
      profile: opts.profile,
      provenance: {
        gitCommit,
        nodeVersion,
        packageVersion,
        profileSource: opts.profileSource,
      },
      repeatIndex: opts.repeatIndex,
      seed,
      models,
      accuracy,
      perSlot: buildPerSlot(),
      calls: {
        tier1: finaliseTierStats(calls.tier1),
        tier2: finaliseTierStats(calls.tier2),
      },
      search: { ...search },
      repair: { ...repair },
      wallMs,
      budgetHits: [...budgetHits],
    };
    if (finalError !== undefined) record.error = finalError;
    return record;
  }

  async function writeRecord(): Promise<string> {
    const record = buildRecord();
    const path = resolveOutPath(opts.out, runId);
    await atomicWriteFile(path, `${JSON.stringify(record, null, 2)}\n`);

    const update = opts.updateIndex;
    if (update !== undefined && update !== false) {
      const previous = update.previousRow ?? null;
      const row: PuzzleIndexRow = {
        id: record.puzzle.id,
        source: record.puzzle.source,
        date: update.date,
        title: update.title,
        style: record.puzzle.style,
        width: update.width,
        height: update.height,
        slotCount: record.puzzle.slots,
        files: update.files,
        schemaVersion: 1,
        parsedBy: update.parsedBy,
        addedAt: previous?.addedAt ?? record.timestamp,
        bestLetterAccuracy:
          previous?.bestLetterAccuracy != null
            ? Math.max(previous.bestLetterAccuracy, record.accuracy.letters)
            : record.accuracy.letters,
        lastRunAt: record.timestamp,
      };
      try {
        await update.upsertIndexRow(row);
      } catch (cause) {
        // The record written above is the durable copy and stays on disk, so
        // the failure must not discard it - but it must not vanish either:
        // an index-lock timeout would otherwise lose the puzzles/index.json
        // row with no trace anywhere. Surface it through `written()`, naming
        // the record that did survive.
        throw new IndexUpsertError(path, row.id, cause);
      }
    }

    return path;
  }

  let writtenPromise: Promise<string> | null = null;
  let writtenConsumed = false;

  const handler: EventHandler = (event: SolverEvent) => {
    switch (event.type) {
      case 'run:start': {
        models = event.models;
        seed = event.seed;
        break;
      }
      case 'grid:init': {
        for (const s of event.slots) getSlot(s.id, s.clue, s.length);
        break;
      }
      case 'slot:ask': {
        const slot = getSlot(event.slotId, event.clue, event.length);
        if (slot.batchIndex === null) slot.batchIndex = event.batchIndex;
        break;
      }
      case 'slot:candidates': {
        const slot = getSlot(event.slotId);
        slot.lastAccepted = event.accepted;
        slot.candidatesSeen += event.accepted.length;
        if (!slot.truthInCandidates) {
          const truth = opts.truth[event.slotId];
          if (truth !== undefined) {
            const idx = event.accepted.findIndex(
              (c) => c.answer.toUpperCase() === truth.toUpperCase(),
            );
            if (idx !== -1) {
              slot.truthInCandidates = true;
              slot.truthRank = idx;
            }
          }
        }
        break;
      }
      case 'candidate:reject': {
        const slot = getSlot(event.slotId);
        slot.rejectCounts[event.reason] += 1;
        break;
      }
      case 'search:assign': {
        const slot = getSlot(event.slotId);
        slot.filled = event.answer;
        slot.producedBy = event.tier;
        const rank = slot.lastAccepted.findIndex(
          (c) => c.answer.toUpperCase() === event.answer.toUpperCase(),
        );
        slot.pickedRank = rank === -1 ? null : rank;
        break;
      }
      case 'search:unassign': {
        const slot = getSlot(event.slotId);
        slot.filled = null;
        slot.producedBy = null;
        slot.pickedRank = null;
        break;
      }
      case 'search:backtrack': {
        search.backtracks += 1;
        break;
      }
      case 'search:wipeout': {
        search.wipeouts += 1;
        break;
      }
      case 'ac3:reduce': {
        search.ac3Reductions += 1;
        break;
      }
      case 'lds:restart': {
        search.discrepancies = Math.max(search.discrepancies, event.discrepanciesUsed);
        break;
      }
      case 'slot:reask': {
        getSlot(event.slotId).reasks += 1;
        break;
      }
      case 'slot:escalate': {
        getSlot(event.slotId).escalated = true;
        break;
      }
      case 'repair:propose': {
        repair.proposals += 1;
        break;
      }
      case 'repair:accept': {
        repair.accepted += 1;
        const slot = getSlot(event.slotId);
        slot.filled = event.after;
        slot.producedBy = event.tier;
        break;
      }
      case 'cache:lookup': {
        pendingLookups.push({ slotId: event.slotId, hit: event.hit });
        break;
      }
      case 'llm:usage': {
        const pending = pendingLookups.shift();
        const tier = modelTier(event.model);
        if (tier !== null) {
          const stats = calls[tier];
          stats.count += 1;
          stats.promptTokens += event.usage.promptTokens;
          stats.completionTokens += event.usage.completionTokens;
          stats.reasoningTokens += event.usage.reasoningTokens ?? 0;
          stats.usdBilled += event.usdBilled;
          stats.usdCounterfactual += event.usdCounterfactual;
          stats.latencies.push(event.latencyMs);
          if (pending !== undefined && pending.hit) stats.cacheHits += 1;
        }
        if (pending !== undefined && pending.slotId !== null) {
          const slot = getSlot(pending.slotId);
          slot.usd += event.usdCounterfactual;
          slot.latencyMs += event.latencyMs;
        }
        break;
      }
      case 'budget:hit': {
        budgetHits.push({ cap: event.cap, limit: event.limit, actual: event.actual, atMs: event.tMs });
        break;
      }
      case 'score:final': {
        accuracy = event.accuracy;
        break;
      }
      case 'run:end': {
        wallMs = event.wallMs;
        // A budget hit alone is 'partial', never 'error' (decision baked
        // into this task): only an event stream whose own terminal status
        // is 'error' - an offline miss or a provider failure after retries
        // - produces 'error' here.
        if (event.status === 'error') {
          finalStatus = 'error';
        } else if (event.status === 'partial' || budgetHits.length > 0) {
          finalStatus = 'partial';
        } else {
          finalStatus = 'ok';
        }
        if (ended) break;
        ended = true;
        writtenPromise = writeRecord();
        // `written()` is where a caller is meant to see a failure. One that
        // never calls it would otherwise get an unhandled rejection (or, on
        // a process that installs a handler for those, nothing at all), so
        // report the message on stderr exactly once instead.
        void writtenPromise.catch((cause: unknown) => {
          if (!writtenConsumed) log.error(describeCause(cause));
        });
        break;
      }
      default:
        break;
    }
  };

  return {
    handler,
    record: buildRecord,
    written: () => {
      writtenConsumed = true;
      if (writtenPromise === null) {
        writtenPromise = Promise.reject(
          new Error(`RunRecorder.written() called before 'run:end' for ${runId}`),
        );
        // Prevent an unhandled rejection when nobody awaits written() before
        // run:end (for example a caller that only inspects record()).
        void writtenPromise.catch(() => undefined);
      }
      return writtenPromise;
    },
  };
}
