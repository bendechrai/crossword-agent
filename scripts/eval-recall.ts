/**
 * T67: the seed-only candidate recall screen.
 *
 * `package.json` is frozen after T0, so this script has no npm alias; it runs
 * inside the container as
 *
 *   docker exec -it crossword-solver npx tsx scripts/eval-recall.ts \
 *     --set sets/modern-12.json --models a,b,c [--repeat 1] [--max-usd 10] \
 *     [--out logs/recall] [--yes] [--offline]
 *
 * (or `./xw`-style, `docker compose exec solver npx tsx scripts/eval-recall.ts ...`).
 *
 * What it does, and deliberately does not do: it runs ONLY the seed pass -
 * one tier-1 ask per slot of every puzzle in the set, with the empty pattern -
 * once per model, through the real `CandidateService`, the real disk cache
 * and the real inference log. There is no AC-3 prepass, no search, no re-ask,
 * no escalation and no repair, and nothing is ever assigned to a grid. Each
 * model is the tier-1 slot of a synthetic profile derived from `baseline`,
 * which is what makes the B23 cache keys and the inference-log `purpose`
 * exactly the ones a real solve's seed pass would use: a screen run and a
 * later bench run share cache entries instead of paying twice.
 *
 * The pure half - the per-slot record type, the aggregation, the renderers
 * and the estimate formula - lives in `src/eval/recall.ts` and is unit
 * tested there. This file is the thin runner around it: argument parsing, the
 * pre-flight refusal, wiring the collaborators together and writing the
 * results out.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openCandidateCache } from '../src/candidates/cache.js';
import type { CandidateCache } from '../src/candidates/cache.js';
import { createCandidateService } from '../src/candidates/service.js';
import type { CandidateServiceDeps, RunCandidateService } from '../src/candidates/service.js';
import type {
  CandidateRequest,
  CandidateResult,
  RejectReason,
} from '../src/candidates/types.js';
import { ExitCode, isCliError, providerError, usageError } from '../src/cli/exit.js';
import {
  aggregateRecall,
  estimateRecallUsd,
  modelSlug,
  renderRecallMarkdown,
  renderRecallTable,
  zeroRecallRejectCounts,
} from '../src/eval/recall.js';
import type {
  PuzzleRecallRecord,
  RecallEstimate,
  SlotRecallRecord,
} from '../src/eval/recall.js';
import type { Emit, EmittedEvent } from '../src/events/types.js';
import { Grid } from '../src/grid/model.js';
import { createNebiusTransport } from '../src/llm/client.js';
import type { NebiusTransportOptions } from '../src/llm/client.js';
import { openInferenceLog } from '../src/llm/inferenceLog.js';
import { capabilitiesOf } from '../src/llm/pricing.js';
import type { InferenceLog, InferenceLogRecord, LlmTransport } from '../src/llm/types.js';
import { getBuiltin } from '../src/profiles/builtins.js';
import type { Profile } from '../src/profiles/schema.js';
import { loadPuzzleById, readNormalised } from '../src/puzzle/library.js';
import type { LibraryOptions } from '../src/puzzle/library.js';
import type { Puzzle, Slot, Stratum } from '../src/puzzle/types.js';
import { repoRoot, resolveCacheDir, resolveInferenceLogDir, resolvePuzzlesDir } from '../src/util/fs.js';
import { log } from '../src/util/log.js';

// ---------------------------------------------------------------------------
// Arguments.
// ---------------------------------------------------------------------------

export interface RecallArgs {
  /** `--set`: a puzzle-set JSON file, the same shape `xw bench` reads. */
  set: string;
  models: string[];
  repeat: number;
  maxUsd: number;
  out: string;
  yes: boolean;
  offline: boolean;
  offlineLenient: boolean;
  concurrency: number;
  inferenceLog: boolean;
  /** The built-in the per-model profiles derive from. */
  profile: string;
}

const DEFAULTS = {
  repeat: 1,
  maxUsd: 10,
  out: 'logs/recall',
  /** "puzzles with the same concurrency as bench (2)". */
  concurrency: 2,
  profile: 'baseline',
} as const;

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) {
    throw usageError(`${flag} needs a value`);
  }
  return value;
}

function positiveInt(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw usageError(`${flag} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function nonNegativeNumber(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw usageError(`${flag} must be a non-negative number, got "${raw}"`);
  }
  return value;
}

/**
 * Deliberately hand-rolled rather than commander: `src/cli/options.ts` is
 * frozen and owns the CLI's flag surface, and this is a script, not a
 * subcommand. Unknown flags are a usage error rather than being ignored, so a
 * typo never silently runs the default matrix and spends money.
 */
export function parseRecallArgs(argv: readonly string[]): RecallArgs {
  const args: RecallArgs = {
    set: '',
    models: [],
    repeat: DEFAULTS.repeat,
    maxUsd: DEFAULTS.maxUsd,
    out: DEFAULTS.out,
    yes: false,
    offline: false,
    offlineLenient: false,
    concurrency: DEFAULTS.concurrency,
    inferenceLog: true,
    profile: DEFAULTS.profile,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === undefined) continue;
    switch (flag) {
      case '--set':
        args.set = requireValue(flag, argv[i + 1]);
        i += 1;
        break;
      case '--models':
        args.models = requireValue(flag, argv[i + 1])
          .split(',')
          .map((m) => m.trim())
          .filter((m) => m.length > 0);
        i += 1;
        break;
      case '--repeat':
        args.repeat = positiveInt(flag, requireValue(flag, argv[i + 1]));
        i += 1;
        break;
      case '--max-usd':
        args.maxUsd = nonNegativeNumber(flag, requireValue(flag, argv[i + 1]));
        i += 1;
        break;
      case '--out':
        args.out = requireValue(flag, argv[i + 1]);
        i += 1;
        break;
      case '--concurrency':
        args.concurrency = positiveInt(flag, requireValue(flag, argv[i + 1]));
        i += 1;
        break;
      case '--profile':
        args.profile = requireValue(flag, argv[i + 1]);
        i += 1;
        break;
      case '--yes':
        args.yes = true;
        break;
      case '--offline':
        args.offline = true;
        break;
      case '--offline-lenient':
        args.offlineLenient = true;
        break;
      case '--no-inference-log':
        args.inferenceLog = false;
        break;
      default:
        throw usageError(`unknown flag "${flag}"`, 'see the header comment in scripts/eval-recall.ts');
    }
  }

  if (args.set === '') throw usageError('--set <puzzle-set.json> is required');
  if (args.models.length === 0) throw usageError('--models <comma list> is required');
  const duplicate = args.models.find((m, i) => args.models.indexOf(m) !== i);
  if (duplicate !== undefined) throw usageError(`--models lists "${duplicate}" twice`);
  return args;
}

// ---------------------------------------------------------------------------
// The puzzle set: the same `{ name, puzzles: [{ id, stratum }] }` file
// `xw bench` reads (B36). Only the file form is supported here; a glob has no
// stratum of its own, and the screen's decision rule is stratum-specific.
// ---------------------------------------------------------------------------

export interface RecallPuzzleEntry {
  id: string;
  stratum: Stratum;
}

export interface RecallPuzzleSet {
  name: string;
  puzzles: RecallPuzzleEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return 'unknown error';
}

export function parsePuzzleSet(raw: unknown, path: string): RecallPuzzleSet {
  if (!isRecord(raw)) throw usageError(`puzzle set file ${path} must contain a JSON object`);
  const name = raw['name'];
  if (typeof name !== 'string' || name.length === 0) {
    throw usageError(`puzzle set file ${path} must have a non-empty string "name"`);
  }
  const puzzlesRaw = raw['puzzles'];
  if (!Array.isArray(puzzlesRaw) || puzzlesRaw.length === 0) {
    throw usageError(`puzzle set file ${path} must have a non-empty "puzzles" array`);
  }
  const puzzles = puzzlesRaw.map((entry, index): RecallPuzzleEntry => {
    if (!isRecord(entry)) {
      throw usageError(`puzzle set file ${path}: puzzles[${String(index)}] must be an object`);
    }
    const id = entry['id'];
    const stratum = entry['stratum'];
    if (typeof id !== 'string' || id.length === 0) {
      throw usageError(
        `puzzle set file ${path}: puzzles[${String(index)}].id must be a non-empty string`,
      );
    }
    if (stratum !== 'american' && stratum !== 'cryptic') {
      throw usageError(
        `puzzle set file ${path}: puzzles[${String(index)}].stratum must be "american" or "cryptic"`,
      );
    }
    return { id, stratum };
  });
  return { name, puzzles };
}

function resolveAgainstRepo(target: string): string {
  if (isAbsolute(target)) return target;
  const fromCwd = resolvePath(target);
  if (existsSync(fromCwd)) return fromCwd;
  return join(repoRoot(), target);
}

async function loadPuzzleSetFile(target: string): Promise<RecallPuzzleSet> {
  const path = resolveAgainstRepo(target);
  if (!existsSync(path)) throw usageError(`puzzle set file not found: ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (cause) {
    throw usageError(`invalid JSON in puzzle set file ${path}: ${messageOf(cause)}`);
  }
  return parsePuzzleSet(raw, path);
}

// ---------------------------------------------------------------------------
// Collaborators.
// ---------------------------------------------------------------------------

export interface RecallOverrides {
  puzzlesDir?: string;
  cacheDir?: string;
  inferenceLogDir?: string;
  /** Overrides `--out`'s directory resolution entirely when given. */
  outDir?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** Forwarded to the Nebius transport so a test never opens a socket. */
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  /** Injected in place of the real transport; the offline paths never call one. */
  transport?: LlmTransport;
}

/**
 * A transport that cannot be called. Under `--offline` a cache miss is fatal
 * before any request is built (B6) and under `--offline-lenient` it degrades
 * to an empty domain, so the screen genuinely never reaches the provider -
 * which means an offline replay must not require `NEBIUS_API_KEY` just to
 * construct a client it will not use.
 */
function unreachableTransport(): LlmTransport {
  return {
    complete(): Promise<never> {
      return Promise.reject(
        providerError(
          'eval-recall: the transport was called during an offline run',
          'this is a bug: --offline must serve every slot from the cache or fail with exit 4',
        ),
      );
    },
  };
}

/**
 * The real inference log, plus an in-memory copy of the records written
 * through it. The service writes one record per clue per attempt carrying
 * `slotId`, the (per-clue share of the) usage blob, both USD figures, the
 * latency and the parse error, which is the only place a batched call's
 * per-clue numbers exist at all; the event stream carries no `slotId` on
 * `llm:usage`.
 */
interface RecordingLog {
  log: InferenceLog;
  /** Everything written through this wrapper, keyed by slot id, in write order. */
  bySlot(): Map<string, InferenceLogRecord[]>;
}

/**
 * One of these per (model, puzzle, repeat) cell rather than one for the whole
 * run: at `--concurrency 2` two cells are in flight at once, and a single
 * shared buffer would interleave their records with no way to tell them
 * apart. `close()` is a no-op here; the run owns `inner` and closes it once.
 */
function recordingLog(inner: InferenceLog): RecordingLog {
  const seen: InferenceLogRecord[] = [];
  return {
    log: {
      write(record: InferenceLogRecord): void {
        seen.push(record);
        inner.write(record);
      },
      close(): void {
        // The run closes the underlying log once, after every cell.
      },
    },
    bySlot(): Map<string, InferenceLogRecord[]> {
      const out = new Map<string, InferenceLogRecord[]>();
      for (const record of seen) {
        if (record.slotId === null) continue;
        const list = out.get(record.slotId) ?? [];
        list.push(record);
        out.set(record.slotId, list);
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// One (model, puzzle, repeat) cell.
// ---------------------------------------------------------------------------

/** slotId -> the correct answer, exactly as `src/cli/bench.ts` derives it. */
function truthOf(slots: readonly Slot[], solution: readonly string[][]): Map<string, string> {
  const out = new Map<string, string>();
  for (const slot of slots) {
    out.set(
      slot.id,
      slot.cells.map(([row, col]) => (solution[row]?.[col] ?? '').toUpperCase()).join(''),
    );
  }
  return out;
}

/** What the event stream tells us about one slot, accumulated exactly as `RunRecorder` does. */
interface SlotAccumulator {
  truthInCandidates: boolean;
  truthRank: number | null;
  candidatesSeen: number;
  clueUnderstood: number | null;
  rejectCounts: Record<RejectReason, number>;
}

function newAccumulator(): SlotAccumulator {
  return {
    truthInCandidates: false,
    truthRank: null,
    candidatesSeen: 0,
    clueUnderstood: null,
    rejectCounts: zeroRecallRejectCounts(),
  };
}

/**
 * The seed request for one slot, field for field the one
 * `src/solver/solve.ts` builds in its seed phase - which is what makes the
 * B23 cache key identical, so a screen run warms the cache a later bench run
 * reads and a re-run of the screen costs nothing.
 */
function seedRequest(
  slot: Slot,
  grid: Grid,
  puzzle: Puzzle,
  profile: Profile,
  repeat: number,
): CandidateRequest {
  const req: CandidateRequest = {
    slotId: slot.id,
    clue: slot.clue,
    length: slot.length,
    pattern: grid.patternFor(slot.id),
    style: puzzle.style,
    rejected: [],
    tier: 1,
    purpose: 'seed',
    n: profile.candidatesPerAsk,
    samples: profile.samples,
    sampleIndex: repeat,
  };
  if (slot.enumeration !== undefined) req.enumeration = slot.enumeration;
  if (puzzle.title !== undefined) req.title = puzzle.title;
  return req;
}

/** The seed pass itself: one ask per slot, mirroring `solve()`'s batching choice (B3). */
async function runSeedPass(
  requests: readonly CandidateRequest[],
  profile: Profile,
  service: RunCandidateService,
): Promise<Map<string, CandidateResult>> {
  if (profile.batchSize > 1) return service.getCandidatesBatch(requests);
  const results = new Map<string, CandidateResult>();
  const settled = await Promise.all(requests.map((req) => service.getCandidates(req)));
  requests.forEach((req, index) => {
    const result = settled[index];
    if (result !== undefined) results.set(req.slotId, result);
  });
  return results;
}

function slotRecordOf(
  slot: Slot,
  truth: string,
  accumulator: SlotAccumulator,
  records: readonly InferenceLogRecord[],
  parseFailures: number,
): SlotRecallRecord {
  let rawCandidates = 0;
  let latencyMs = 0;
  let usdCounterfactual = 0;
  let usdBilled = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let reasoningTokens = 0;
  let liveCalls = 0;
  for (const record of records) {
    rawCandidates += record.parsed?.candidates.length ?? 0;
    latencyMs += record.latencyMs ?? 0;
    usdCounterfactual += record.usdCounterfactual ?? 0;
    usdBilled += record.usdBilled ?? 0;
    if (record.usage !== null) {
      promptTokens += record.usage.promptTokens;
      completionTokens += record.usage.completionTokens;
      totalTokens += record.usage.totalTokens;
      reasoningTokens += record.usage.reasoningTokens ?? 0;
    }
    if (!record.cacheHit) liveCalls += 1;
  }
  return {
    slotId: slot.id,
    clue: slot.clue,
    length: slot.length,
    truth,
    truthInCandidates: accumulator.truthInCandidates,
    truthRank: accumulator.truthRank,
    candidatesSeen: accumulator.candidatesSeen,
    rawCandidates,
    rejectCounts: { ...accumulator.rejectCounts },
    // The service emits `slot:candidates` with an empty list for a slot whose
    // every attempt failed to parse, so the event stream cannot tell a parse
    // failure from a model that answered with nothing usable. The inference
    // records can: the LAST record for the slot carries the outcome of the
    // last attempt, and a non-null `parseError` there is the tier-1 failure
    // the escalation policy would act on.
    parseFailure: (records[records.length - 1]?.parseError ?? null) !== null,
    parseFailures,
    clueUnderstood: accumulator.clueUnderstood,
    latencyMs,
    cacheHit: records.length > 0 && liveCalls === 0,
    tokens: { promptTokens, completionTokens, totalTokens, reasoningTokens },
    usdCounterfactual: Math.round(1e9 * usdCounterfactual) / 1e9,
    usdBilled: Math.round(1e9 * usdBilled) / 1e9,
  };
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

/** `<out>/<model-slug>/<puzzle>--r<repeat>.json`, plus the fields that name the run. */
export interface RecallCellFile extends PuzzleRecallRecord {
  generatedAt: string;
  profile: string;
  promptVersion: string;
  offline: boolean;
}

export interface RecallRunResult {
  records: PuzzleRecallRecord[];
  estimate: RecallEstimate;
  outDir: string;
}

export async function runRecall(
  args: RecallArgs,
  overrides: RecallOverrides = {},
): Promise<RecallRunResult> {
  const env = overrides.env ?? process.env;
  const stdout = overrides.stdout ?? process.stdout;
  const stderr = overrides.stderr ?? process.stderr;
  const now = overrides.now ?? ((): Date => new Date());

  const base = getBuiltin(args.profile);
  for (const model of args.models) {
    try {
      capabilitiesOf(model);
    } catch (cause) {
      throw usageError(`--models: ${messageOf(cause)}`, 'model ids come from models.json');
    }
  }

  const set = await loadPuzzleSetFile(args.set);
  const puzzlesDir = overrides.puzzlesDir ?? resolvePuzzlesDir({ env });
  const libraryOptions: LibraryOptions = { puzzlesDir };

  // Every puzzle is loaded before anything is asked for, so a missing puzzle
  // or an unreadable solution is a usage-time failure and never a half-spent
  // matrix (B28, the same precedence `xw bench` keeps).
  interface LoadedPuzzle {
    entry: RecallPuzzleEntry;
    puzzle: Puzzle;
    grid: Grid;
    truth: Map<string, string>;
  }
  const loaded: LoadedPuzzle[] = [];
  for (const entry of set.puzzles) {
    const puzzle = await loadPuzzleById(entry.id, libraryOptions);
    const file = await readNormalised(entry.id, libraryOptions);
    loaded.push({
      entry,
      puzzle,
      grid: new Grid(puzzle),
      truth: truthOf(puzzle.slots, file.solution),
    });
  }

  const totalSlots = loaded.reduce((sum, p) => sum + p.puzzle.slots.length, 0);

  // -------------------------------------------------------------------------
  // Pre-flight estimate (B45), mirroring bench: printed always, and above
  // `--max-usd` the run refuses to start without `--yes`.
  // -------------------------------------------------------------------------
  const estimate = estimateRecallUsd({
    slots: totalSlots,
    models: args.models,
    repeat: args.repeat,
  });
  stdout.write(
    `estimate: ${String(totalSlots)} slots x ${String(args.models.length)} models x ` +
      `${String(args.repeat)} repeats = ${String(estimate.callsPerModel * args.models.length)} calls ` +
      `~ $${estimate.totalUsd.toFixed(6)} (--max-usd ${args.maxUsd.toFixed(6)})\n`,
  );
  for (const row of estimate.perModel) {
    stdout.write(`  ${row.model}: ${String(row.calls)} calls ~ $${row.usd.toFixed(6)}\n`);
  }
  if (estimate.totalUsd > args.maxUsd && !args.yes) {
    throw usageError(
      `estimated cost $${estimate.totalUsd.toFixed(6)} exceeds --max-usd ${args.maxUsd.toFixed(6)}`,
      'pass --yes to run the screen anyway',
    );
  }

  const offline = args.offline || args.offlineLenient;
  const outDir = overrides.outDir ?? resolveAgainstRepo(args.out);
  const cache = openCandidateCache({
    cacheDir: overrides.cacheDir ?? resolveCacheDir({ env }),
  });
  const inferenceLog = openInferenceLog({
    dir: overrides.inferenceLogDir ?? resolveInferenceLogDir({ env }),
    enabled: args.inferenceLog,
  });
  let transport: LlmTransport;
  if (overrides.transport !== undefined) transport = overrides.transport;
  else if (offline) transport = unreachableTransport();
  else {
    const transportOptions: NebiusTransportOptions = {
      // The service writes the richer record (it alone knows purpose,
      // promptKind, cacheKey and slotId), so the transport's own log is off
      // and the real sink goes to the service (T45's wiring note).
      inferenceLog: openInferenceLog({ enabled: false }),
      env,
    };
    if (overrides.fetch !== undefined) transportOptions.fetch = overrides.fetch;
    transport = createNebiusTransport(transportOptions);
  }

  const records: PuzzleRecallRecord[] = [];

  // Models run one after another (task decision): the rate limiter is a
  // process-wide registry keyed by model id, so two models in flight at once
  // would share nothing but the wall clock and make each other's latency
  // numbers meaningless.
  for (const model of args.models) {
    const profile: Profile = { ...base, name: `recall-${modelSlug(model)}`, tier1: model };
    const slug = modelSlug(model);
    const modelDir = join(outDir, slug);
    await mkdir(modelDir, { recursive: true });

    for (let repeat = 0; repeat < args.repeat; repeat += 1) {
      // Results land at the puzzle's own index rather than in completion
      // order, so `records` (and therefore summary.json) is the same file
      // whichever cell finished first at `--concurrency 2`.
      const cellRecords: Array<PuzzleRecallRecord | undefined> = new Array<
        PuzzleRecallRecord | undefined
      >(loaded.length).fill(undefined);
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const index = next;
          next += 1;
          const target = loaded[index];
          if (target === undefined) return;
          const record = await runCell(target, model, profile, repeat, {
            cache,
            // One recorder per cell: at --concurrency 2 two cells are in
            // flight and a shared buffer would interleave their records.
            logs: recordingLog(inferenceLog),
            transport,
            offline: args.offline,
            offlineLenient: args.offlineLenient,
            now,
          });
          cellRecords[index] = record;
          const file: RecallCellFile = {
            ...record,
            generatedAt: now().toISOString(),
            profile: args.profile,
            promptVersion: profile.promptVersion,
            offline,
          };
          await writeFile(
            join(modelDir, `${target.entry.id}--r${String(repeat)}.json`),
            `${JSON.stringify(file, null, 2)}\n`,
            'utf8',
          );
          stdout.write(
            `${model} ${target.entry.id} repeat=${String(repeat)}: ` +
              `${String(record.slots.length)} slots, truth-in-candidates ` +
              `${shareOf(record).toFixed(4)}\n`,
          );
        }
      };
      const workers = Math.max(1, Math.min(args.concurrency, loaded.length));
      await Promise.all(Array.from({ length: workers }, () => worker()));
      for (const record of cellRecords) {
        if (record !== undefined) records.push(record);
      }
    }
  }

  inferenceLog.close();

  const aggregation = aggregateRecall(records);
  stdout.write(`\n${renderRecallTable(aggregation.byModel)}\n`);
  stdout.write(`\n${renderRecallTable(aggregation.byModelStratum)}\n`);

  const markdown = renderRecallMarkdown(aggregation, {
    setName: set.name,
    models: args.models,
    repeat: args.repeat,
    generatedAt: now().toISOString(),
    currentTier1: base.tier1,
    offline,
  });
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'summary.md'), markdown, 'utf8');
  await writeFile(
    join(outDir, 'summary.json'),
    `${JSON.stringify(
      {
        set: set.name,
        models: args.models,
        repeat: args.repeat,
        profile: args.profile,
        offline,
        generatedAt: now().toISOString(),
        estimate,
        aggregation,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  stderr.write(`wrote ${join(outDir, 'summary.md')}\n`);

  return { records, estimate, outDir };
}

function shareOf(record: PuzzleRecallRecord): number {
  if (record.slots.length === 0) return 0;
  return record.slots.filter((s) => s.truthInCandidates).length / record.slots.length;
}

interface CellContext {
  cache: CandidateCache;
  logs: RecordingLog;
  transport: LlmTransport;
  offline: boolean;
  offlineLenient: boolean;
  now: () => Date;
}

async function runCell(
  target: { entry: RecallPuzzleEntry; puzzle: Puzzle; grid: Grid; truth: Map<string, string> },
  model: string,
  profile: Profile,
  repeat: number,
  ctx: CellContext,
): Promise<PuzzleRecallRecord> {
  const accumulators = new Map<string, SlotAccumulator>();
  const accumulatorFor = (slotId: string): SlotAccumulator => {
    const existing = accumulators.get(slotId);
    if (existing !== undefined) return existing;
    const created = newAccumulator();
    accumulators.set(slotId, created);
    return created;
  };

  const emit: Emit = (event: EmittedEvent): void => {
    if (event.type === 'slot:candidates') {
      const acc = accumulatorFor(event.slotId);
      acc.candidatesSeen += event.accepted.length;
      acc.clueUnderstood = event.clueUnderstood;
      if (!acc.truthInCandidates) {
        const truth = target.truth.get(event.slotId);
        if (truth !== undefined) {
          const at = event.accepted.findIndex((c) => c.answer.toUpperCase() === truth.toUpperCase());
          if (at !== -1) {
            acc.truthInCandidates = true;
            acc.truthRank = at;
          }
        }
      }
      return;
    }
    if (event.type === 'candidate:reject') {
      accumulatorFor(event.slotId).rejectCounts[event.reason] += 1;
    }
  };

  // A run id per cell, so the inference log can be sliced back apart by
  // (model, puzzle, repeat) after the fact exactly as a solve's can.
  const runId = `recall--${modelSlug(model)}--${target.entry.id}--r${String(repeat)}--${String(
    ctx.now().getTime(),
  )}`;
  const serviceDeps: CandidateServiceDeps = {
    transport: ctx.transport,
    cache: ctx.cache,
    inferenceLog: ctx.logs.log,
    profile,
    emit,
    runId,
    puzzleId: target.entry.id,
    offline: ctx.offline,
    offlineLenient: ctx.offlineLenient,
  };
  const service = createCandidateService(serviceDeps);
  const requests = target.puzzle.slots.map((slot) =>
    seedRequest(slot, target.grid, target.puzzle, profile, repeat),
  );
  await runSeedPass(requests, profile, service);
  const perSlotLogs = ctx.logs.bySlot();

  const slots = target.puzzle.slots.map((slot) =>
    slotRecordOf(
      slot,
      target.truth.get(slot.id) ?? '',
      accumulators.get(slot.id) ?? newAccumulator(),
      perSlotLogs.get(slot.id) ?? [],
      service.parseFailures(slot.id),
    ),
  );

  return { model, puzzleId: target.entry.id, stratum: target.entry.stratum, repeat, slots };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    await runRecall(parseRecallArgs(argv));
    return ExitCode.OK;
  } catch (cause) {
    if (isCliError(cause)) {
      log.error(cause.message);
      if (cause.hint !== undefined) log.error(cause.hint);
      return cause.code;
    }
    log.error(`eval-recall: ${messageOf(cause)}`);
    return ExitCode.UNEXPECTED;
  }
}

/**
 * Only when run as a script. A test importing this module for
 * `parseRecallArgs` or `runRecall` must not kick off a matrix, so the
 * top-level call is gated on this file being the process entry point.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exitCode = await main();
}
