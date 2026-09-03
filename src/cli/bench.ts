import { readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';

import { openCandidateCache } from '../candidates/cache.js';
import type { CandidateCache } from '../candidates/cache.js';
import { createCandidateService } from '../candidates/service.js';
import type { CandidateServiceDeps } from '../candidates/service.js';
import { pathKind, loadConfig } from '../config.js';
import { aggregate } from '../eval/aggregate.js';
import type { Aggregation } from '../eval/aggregate.js';
import { createRunRecorder } from '../eval/runRecorder.js';
import type { RunRecorderOptions, RunRecorderPuzzleInfo } from '../eval/runRecorder.js';
import { score } from '../eval/scorer.js';
import type { RunRecord, RunStatus } from '../eval/types.js';
import { createEventBus } from '../events/bus.js';
import type { Emit } from '../events/types.js';
import { createDomainStore } from '../grid/domainStore.js';
import { Grid } from '../grid/model.js';
import { createNebiusTransport } from '../llm/client.js';
import type { NebiusTransportOptions } from '../llm/client.js';
import { openInferenceLog } from '../llm/inferenceLog.js';
import type { InferenceLog } from '../llm/types.js';
import { createBudgetTracker, resolveBudget } from '../policy/budget.js';
import { resolveProfile } from '../profiles/loader.js';
import type { Profile, ProfileSource } from '../profiles/schema.js';
import { loadPuzzleById, loadSolution } from '../puzzle/library.js';
import type { LibraryOptions } from '../puzzle/library.js';
import type { Puzzle, Slot, Stratum } from '../puzzle/types.js';
import { ac3 } from '../solver/ac3.js';
import { createSearchHooks } from '../solver/hooks.js';
import type { SearchHooksDeps } from '../solver/hooks.js';
import { repair } from '../solver/repair.js';
import { search } from '../solver/search.js';
import { solve as runSolveOrchestration } from '../solver/solve.js';
import type { SolveOrchestrationDeps } from '../solver/solve.js';
import type { SolveOptions as SolveRunOptions } from '../solver/types.js';
import {
  repoRoot,
  resolveCacheDir,
  resolveInferenceLogDir,
  resolvePuzzlesDir,
  resolveRunsDir,
} from '../util/fs.js';
import type { WordList } from '../validate/types.js';
import { openWordList } from '../validate/wordlist.js';
import { CliError, ExitCode, usageError } from './exit.js';
import type { BenchOptions, GlobalOptions } from './options.js';

/**
 * T47. Everything a test needs to inject so the `(puzzle, profile, repeat)`
 * matrix never touches a real network, a real API key or the developer's own
 * working directories - the same pattern `SolveCommandOverrides` (T45,
 * src/cli/solve.ts) uses. The real CLI (src/cli/index.ts) never passes this.
 *
 * `solve` is the seam the task's own acceptance criteria are built around
 * ("with solve() mocked ..."): it defaults to the real orchestration
 * (src/solver/solve.ts, T44), and a test substitutes a double that records
 * what it was called with and emits `run:end` itself (mirroring T45's own
 * test double), matching the precedent set in test/unit/cli/solve.test.ts.
 */
export interface BenchCommandOverrides {
  solve?: typeof runSolveOrchestration;
  puzzlesDir?: string;
  cacheDir?: string;
  inferenceLogDir?: string;
  /** Overrides `--out`'s directory resolution entirely when given. */
  runsDir?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** Forwarded to the Nebius transport so a test never opens a socket. */
  fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Small local helpers (deliberately not imported from a sibling module: T47
// must not import a wave-mate's implementation module directly, and none of
// these are exported from the T0 contract).
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return JSON.stringify(cause) ?? 'unknown error';
}

/** `RunRecorderOptions.truth`: slotId -> the correct answer (mirrors src/cli/solve.ts). */
function truthOf(slots: readonly Slot[], solution: readonly string[][]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const slot of slots) {
    out[slot.id] = slot.cells
      .map(([row, col]) => (solution[row]?.[col] ?? '').toUpperCase())
      .join('');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Minimal glob support for the `<puzzle-set>` glob form, matching the same
// "only the final path segment may be wildcarded" scope src/cli/report.ts
// uses for `--runs`.
// ---------------------------------------------------------------------------

function splitGlobPath(pattern: string): { dir: string; base: string } {
  const idx = pattern.lastIndexOf('/');
  if (idx === -1) return { dir: '.', base: pattern };
  return { dir: pattern.slice(0, idx) || '/', base: pattern.slice(idx + 1) };
}

function globPatternToRegExp(glob: string): RegExp {
  let src = '^';
  for (const ch of glob) {
    if (ch === '*') src += '[^/]*';
    else if (ch === '?') src += '[^/]';
    else src += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${src}$`);
}

function globJsonFiles(pattern: string, root: string): string[] {
  const resolvedPattern = isAbsolute(pattern) ? pattern : resolvePath(root, pattern);
  const { dir, base } = splitGlobPath(resolvedPattern);
  const regex = globPatternToRegExp(base);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => regex.test(name) && name.endsWith('.json'))
    .sort()
    .map((name) => join(dir, name));
}

// ---------------------------------------------------------------------------
// Puzzle-set loading (Deliverable: `{ name, puzzles: [{ id, stratum }] }`
// under sets/, or a glob).
// ---------------------------------------------------------------------------

interface PuzzleSetEntry {
  id: string;
  stratum: Stratum;
}

interface PuzzleSetFile {
  name: string;
  puzzles: PuzzleSetEntry[];
}

function validatePuzzleSetShape(raw: unknown, path: string): PuzzleSetFile {
  if (!isRecord(raw)) throw usageError(`puzzle set file ${path} must contain a JSON object`);
  const name = raw['name'];
  if (typeof name !== 'string' || name.length === 0) {
    throw usageError(`puzzle set file ${path} must have a non-empty string "name"`);
  }
  const puzzlesRaw = raw['puzzles'];
  if (!Array.isArray(puzzlesRaw) || puzzlesRaw.length === 0) {
    throw usageError(`puzzle set file ${path} must have a non-empty "puzzles" array`);
  }
  const puzzles: PuzzleSetEntry[] = puzzlesRaw.map((entry, index) => {
    if (!isRecord(entry)) {
      throw usageError(`puzzle set file ${path}: puzzles[${index}] must be an object`);
    }
    const id = entry['id'];
    const stratum = entry['stratum'];
    if (typeof id !== 'string' || id.length === 0) {
      throw usageError(`puzzle set file ${path}: puzzles[${index}].id must be a non-empty string`);
    }
    if (stratum !== 'american' && stratum !== 'cryptic') {
      throw usageError(
        `puzzle set file ${path}: puzzles[${index}].stratum must be "american" or "cryptic"`,
      );
    }
    return { id, stratum };
  });
  return { name, puzzles };
}

/**
 * `<puzzle-set>` is a JSON file under `sets/`, or a glob (Deliverable). An
 * existing file is parsed and validated against the set shape; otherwise the
 * argument is resolved as a glob of normalised puzzle files (the same kind
 * `xw solve <id>` reads), and each match becomes a `{ id, stratum }` entry,
 * with stratum derived from the puzzle's own style (A1: cryptic is its own
 * stratum, everything else is american) since a bare glob carries no
 * stratum of its own.
 */
async function loadPuzzleSet(target: string, repoRootDir: string): Promise<PuzzleSetFile> {
  const abs = resolvePath(target);
  if (pathKind(abs) === 'file') {
    let text: string;
    try {
      text = await readFile(abs, 'utf8');
    } catch (cause) {
      throw usageError(`cannot read puzzle set file ${abs}: ${messageOf(cause)}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (cause) {
      throw usageError(`invalid JSON in puzzle set file ${abs}: ${messageOf(cause)}`);
    }
    return validatePuzzleSetShape(raw, abs);
  }

  const files = globJsonFiles(target, repoRootDir);
  if (files.length === 0) {
    throw usageError(
      `puzzle set "${target}" is neither an existing file nor a glob that matched anything`,
    );
  }
  const puzzles: PuzzleSetEntry[] = [];
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const id = parsed['id'];
    if (typeof id !== 'string') continue;
    const stratum: Stratum = parsed['style'] === 'cryptic' ? 'cryptic' : 'american';
    puzzles.push({ id, stratum });
  }
  if (puzzles.length === 0) {
    throw usageError(`puzzle set glob "${target}" matched no valid normalised puzzle files`);
  }
  return { name: target, puzzles };
}

// ---------------------------------------------------------------------------
// The matrix.
// ---------------------------------------------------------------------------

interface ResolvedProfileEntry {
  name: string;
  profile: Profile;
  source: ProfileSource;
}

interface MatrixCell {
  puzzleId: string;
  stratum: Stratum;
  profileName: string;
  profile: Profile;
  profileSource: ProfileSource;
  /** B1: the repeat index, fed to `SolveOptions.repeatIndex` -> `sampleIndex`. */
  repeatIndex: number;
}

function buildMatrix(
  puzzles: ReadonlyArray<PuzzleSetEntry>,
  profiles: ReadonlyArray<ResolvedProfileEntry>,
  repeat: number,
): MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (const puzzle of puzzles) {
    for (const p of profiles) {
      for (let r = 0; r < repeat; r += 1) {
        cells.push({
          puzzleId: puzzle.id,
          stratum: puzzle.stratum,
          profileName: p.name,
          profile: p.profile,
          profileSource: p.source,
          repeatIndex: r,
        });
      }
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Pre-flight cost estimate (B45): puzzles x profiles x repeats x an
// estimated per-puzzle usdCounterfactual (B2), from prior runs of the same
// profile in the runs directory where available, or a static estimate
// otherwise.
// ---------------------------------------------------------------------------

/**
 * Arbitrary placeholder used only until a profile has at least one prior run
 * on disk to measure from. Deliberately small: the estimate exists to catch
 * an order-of-magnitude mistake (a mistyped `--repeat`), not to be an exact
 * forecast.
 */
const STATIC_PER_PUZZLE_USD_ESTIMATE = 0.02;

function meanPriorUsdCounterfactual(profileName: string, runsDir: string): number | undefined {
  let names: string[];
  try {
    names = readdirSync(runsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return undefined;
  }
  const values: number[] = [];
  for (const name of names) {
    let record: RunRecord;
    try {
      record = JSON.parse(readFileSync(join(runsDir, name), 'utf8')) as RunRecord;
    } catch {
      continue;
    }
    if (record.profile?.name !== profileName) continue;
    values.push(record.calls.tier1.usdCounterfactual + record.calls.tier2.usdCounterfactual);
  }
  if (values.length === 0) return undefined;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function estimateTotalUsd(matrix: ReadonlyArray<MatrixCell>, runsDir: string): number {
  const perProfile = new Map<string, number>();
  let total = 0;
  for (const cell of matrix) {
    let perPuzzle = perProfile.get(cell.profileName);
    if (perPuzzle === undefined) {
      perPuzzle = meanPriorUsdCounterfactual(cell.profileName, runsDir) ?? STATIC_PER_PUZZLE_USD_ESTIMATE;
      perProfile.set(cell.profileName, perPuzzle);
    }
    total += perPuzzle;
  }
  return total;
}

function formatEstimateLine(
  matrix: ReadonlyArray<MatrixCell>,
  puzzleCount: number,
  profileCount: number,
  repeat: number,
  estimate: number,
  maxUsd: number,
): string {
  return (
    `estimate: ${matrix.length} runs (${puzzleCount} puzzles x ${profileCount} profiles x ` +
    `${repeat} repeats) ~ $${estimate.toFixed(6)} (--max-usd ${maxUsd.toFixed(6)})`
  );
}

// ---------------------------------------------------------------------------
// One matrix cell: resolve the puzzle, build the real SolveDeps (the same
// collaborators src/cli/solve.ts wires for a single run) and run `solve()`.
// ---------------------------------------------------------------------------

interface CellSharedDeps {
  libraryOptions: LibraryOptions;
  runsDir: string;
  cache: CandidateCache;
  inferenceLog: InferenceLog;
  wordList: WordList;
  baseUrl: string | undefined;
  offline: boolean;
  offlineLenient: boolean;
  transportFetch: typeof globalThis.fetch | undefined;
  env: NodeJS.ProcessEnv;
  solve: typeof runSolveOrchestration;
  stderr: NodeJS.WritableStream;
}

interface CellOutcome {
  status: RunStatus;
  usdCounterfactual: number;
  record: RunRecord | null;
  runId: string;
}

async function executeCell(cell: MatrixCell, deps: CellSharedDeps): Promise<CellOutcome> {
  let puzzle: Puzzle | null = null;
  let solution: string[][] = [];
  let puzzleInfo: RunRecorderPuzzleInfo = {
    id: cell.puzzleId,
    source: 'unknown',
    style: 'unknown',
    stratum: cell.stratum,
    size: '0x0',
    slots: 0,
  };

  try {
    puzzle = await loadPuzzleById(cell.puzzleId, deps.libraryOptions);
    solution = await loadSolution(cell.puzzleId, deps.libraryOptions);
    puzzleInfo = {
      id: puzzle.id,
      source: puzzle.source,
      style: puzzle.style,
      stratum: cell.stratum,
      size: `${puzzle.width}x${puzzle.height}`,
      slots: puzzle.slots.length,
    };
  } catch (cause) {
    deps.stderr.write(`bench: could not load puzzle "${cell.puzzleId}": ${messageOf(cause)}\n`);
  }

  const recorderOptions: RunRecorderOptions = {
    puzzle: puzzleInfo,
    truth: puzzle !== null ? truthOf(puzzle.slots, solution) : {},
    profile: cell.profile,
    profileSource: cell.profileSource,
    repeatIndex: cell.repeatIndex,
    // bench does not touch puzzles/index.json (see docs/build-notes for T47).
    updateIndex: false,
  };
  const recorder = createRunRecorder(recorderOptions);
  const runId = recorder.record().runId;
  // `resolveOutPath` (src/eval/runRecorder.ts) reads `opts.out` when
  // `writeRecord()` runs, at `run:end`, which is always after this point -
  // so mutating the same options object bench just handed the recorder is
  // how a per-run path under bench's own `--out` directory (only knowable
  // once `runId` exists) reaches a recorder whose constructor already ran.
  recorderOptions.out = join(deps.runsDir, `${runId}.json`);

  const bus = createEventBus({ runId });
  bus.on(recorder.handler);
  const emit: Emit = (event) => { bus.emit(event); };

  async function finishAsError(): Promise<RunRecord | null> {
    try {
      bus.emit({ type: 'run:end', status: 'error', wallMs: 0 });
      await recorder.written();
      return recorder.record();
    } catch (cause) {
      deps.stderr.write(
        `bench: failed to write run record for "${cell.puzzleId}" (${runId}): ${messageOf(cause)}\n`,
      );
      return null;
    }
  }

  if (puzzle === null) {
    const record = await finishAsError();
    return { status: 'error', usdCounterfactual: 0, record, runId };
  }

  const loadedPuzzle = puzzle;
  const loadedSolution = solution;

  let record: RunRecord | null = null;
  let status: RunStatus = 'error';
  try {
    const transportOptions: NebiusTransportOptions = {
      inferenceLog: openInferenceLog({ enabled: false }),
      env: deps.env,
    };
    if (deps.baseUrl !== undefined) transportOptions.baseUrl = deps.baseUrl;
    if (deps.transportFetch !== undefined) transportOptions.fetch = deps.transportFetch;
    const transport = createNebiusTransport(transportOptions);

    const serviceOptions: CandidateServiceDeps = {
      transport,
      cache: deps.cache,
      inferenceLog: deps.inferenceLog,
      profile: cell.profile,
      emit,
      runId,
      puzzleId: loadedPuzzle.id,
      offline: deps.offline,
      offlineLenient: deps.offlineLenient,
    };
    const service = createCandidateService(serviceOptions);

    const grid = new Grid(loadedPuzzle);
    const domains = createDomainStore();
    const budget = createBudgetTracker(resolveBudget(cell.profile));

    const hooksOptions: SearchHooksDeps = {
      grid,
      domains,
      service,
      budget,
      profile: cell.profile,
      emit,
      style: loadedPuzzle.style,
      sampleIndex: cell.repeatIndex,
      parseFailures: (slotId) => service.parseFailures(slotId),
    };
    if (loadedPuzzle.title !== undefined) hooksOptions.title = loadedPuzzle.title;
    const hooks = createSearchHooks(hooksOptions);

    const solveDeps: SolveOrchestrationDeps = {
      grid,
      domains,
      service,
      hooks,
      wordList: deps.wordList,
      ac3,
      search,
      repair,
      emit,
      score: (snapshot) => score(snapshot, loadedSolution, loadedPuzzle.slots),
      puzzle: loadedPuzzle,
    };

    const solveOpts: SolveRunOptions = {
      runId,
      puzzleId: loadedPuzzle.id,
      repeatIndex: cell.repeatIndex,
      seed: null,
      offline: deps.offline,
      offlineLenient: deps.offlineLenient,
    };

    await deps.solve(solveDeps, cell.profile, solveOpts);
    await recorder.written();
    record = recorder.record();
    status = record.status;
  } catch (cause) {
    deps.stderr.write(
      `bench: run "${runId}" ("${cell.puzzleId}", "${cell.profileName}", repeat ${cell.repeatIndex}) failed: ${messageOf(cause)}\n`,
    );
    record = await finishAsError();
    status = 'error';
  }

  const usdCounterfactual =
    record !== null ? record.calls.tier1.usdCounterfactual + record.calls.tier2.usdCounterfactual : 0;

  return { status, usdCounterfactual, record, runId };
}

// ---------------------------------------------------------------------------
// Summary table (Deliverable: "produced by calling aggregate in-process, so
// bench and report can never disagree"). Acceptance 8's exact column list.
// Tab-separated: two of the required column labels ("usd per puzzle", "usd
// per correct word") contain spaces themselves, so a single delimiter that
// is never itself a header character keeps the table unambiguous to parse.
// ---------------------------------------------------------------------------

const SUMMARY_HEADER = [
  'profile',
  'n',
  'letters',
  'words',
  'perfect',
  'usd per puzzle',
  'usd per correct word',
] as const;

function renderSummaryTable(aggregation: Aggregation): string {
  const lines = [SUMMARY_HEADER.join('\t')];
  for (const g of aggregation.groups) {
    lines.push(
      [
        g.group,
        String(g.n),
        g.letters.mean.toFixed(4),
        g.words.mean.toFixed(4),
        g.perfect.mean.toFixed(4),
        g.usdPerPuzzle.toFixed(6),
        g.usdPerCorrectWord.toFixed(6),
      ].join('\t'),
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// `xw bench <puzzle-set>`.
// ---------------------------------------------------------------------------

/**
 * T47: the `bench` handler running the `(puzzle, profile, repeat)` matrix.
 *
 * Precedence (B28): profiles and the puzzle set are resolved and validated
 * before any run starts, so a usage error never costs money. The pre-flight
 * estimate (B45) and the mid-matrix ceiling both price every call as if cold
 * (`usdCounterfactual`, B2, per this task's own orchestrator note - see
 * "Deviations" in docs/build-notes for the spec-text conflict this
 * resolves), so a warm cache never makes an expensive matrix look free.
 * Concurrency is over runs, not over slots (spec): the per-model rate
 * limiter (src/llm/rateLimiter.ts) is a process-wide registry keyed by model
 * id, so every concurrent run naturally shares it with no extra wiring here.
 */
export async function benchCommand(
  puzzleSetArg: string,
  opts: BenchOptions,
  global: GlobalOptions,
  overrides: BenchCommandOverrides = {},
): Promise<void> {
  if (!Number.isInteger(opts.repeat) || opts.repeat < 1) {
    throw usageError(`--repeat must be a positive integer, got ${opts.repeat}`);
  }
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
    throw usageError(`--concurrency must be a positive integer, got ${opts.concurrency}`);
  }

  const env = overrides.env ?? process.env;
  const stdout = overrides.stdout ?? process.stdout;
  const stderr = overrides.stderr ?? process.stderr;

  const { config } = await loadConfig({ path: global.config });

  // -------------------------------------------------------------------------
  // Profiles and puzzle set, resolved and validated before any run starts
  // (B28: "a usage error ... fails before any run starts").
  // -------------------------------------------------------------------------
  const profiles: ResolvedProfileEntry[] = [];
  for (const name of opts.profiles) {
    const { profile, source } = await resolveProfile({ profile: name, config });
    profiles.push({ name: profile.name, profile, source });
  }

  const puzzlesDir = overrides.puzzlesDir ?? resolvePuzzlesDir({ config: config.puzzlesDir, env });
  const libraryOptions: LibraryOptions = { puzzlesDir };
  const puzzleSet = await loadPuzzleSet(puzzleSetArg, repoRoot());

  const runsDir = overrides.runsDir ?? resolveRunsDir({ flag: opts.out, env });

  const matrix = buildMatrix(puzzleSet.puzzles, profiles, opts.repeat);

  // -------------------------------------------------------------------------
  // Pre-flight estimate (B45).
  // -------------------------------------------------------------------------
  const estimate = estimateTotalUsd(matrix, runsDir);
  stdout.write(
    `${formatEstimateLine(matrix, puzzleSet.puzzles.length, profiles.length, opts.repeat, estimate, opts.maxUsd)}\n`,
  );
  if (estimate > opts.maxUsd && !opts.yes) {
    throw usageError(
      `estimated cost $${estimate.toFixed(6)} exceeds --max-usd ${opts.maxUsd.toFixed(6)}`,
      'pass --yes to run the matrix anyway',
    );
  }

  // -------------------------------------------------------------------------
  // Resources shared across the whole matrix (the on-disk candidate cache,
  // the inference log and the word list are meant to be shared - that is the
  // point of a cache - unlike the per-run transport/service/grid/budget,
  // which are rebuilt per cell exactly as src/cli/solve.ts builds them for a
  // single run).
  // -------------------------------------------------------------------------
  const cacheDir = overrides.cacheDir ?? resolveCacheDir({ flag: global.cacheDir, env });
  const cache = openCandidateCache({ cacheDir });
  const inferenceLog = openInferenceLog({
    dir: overrides.inferenceLogDir ?? resolveInferenceLogDir({ config: config.inferenceLogDir, env }),
    enabled: opts.inferenceLog,
  });
  const wordList = openWordList(config.wordlistPath);
  const baseUrl = env['NEBIUS_BASE_URL'] === undefined ? config.nebiusBaseUrl : undefined;
  const solve = overrides.solve ?? runSolveOrchestration;

  const cellDeps: CellSharedDeps = {
    libraryOptions,
    runsDir,
    cache,
    inferenceLog,
    wordList,
    baseUrl,
    offline: opts.offline,
    offlineLenient: opts.offlineLenient,
    transportFetch: overrides.fetch,
    env,
    solve,
    stderr,
  };

  // -------------------------------------------------------------------------
  // The matrix itself: `opts.concurrency` workers pulling from a shared
  // cursor, so at most that many runs are ever in flight (acceptance 7).
  // Cumulative `usdCounterfactual` is checked after every run; crossing
  // `--max-usd` stops any further run from starting, and already-running
  // cells are allowed to finish (their records are still written).
  // -------------------------------------------------------------------------
  const records: RunRecord[] = [];
  let cumulativeUsd = 0;
  let aborted = false;
  let anyErrored = false;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (aborted) return;
      const i = nextIndex;
      nextIndex += 1;
      if (i >= matrix.length) return;
      const cell = matrix[i];
      if (cell === undefined) return;
      const outcome = await executeCell(cell, cellDeps);
      if (outcome.record !== null) records.push(outcome.record);
      if (outcome.status === 'error') anyErrored = true;
      cumulativeUsd += outcome.usdCounterfactual;
      stdout.write(
        `${cell.puzzleId} ${cell.profileName} repeat=${cell.repeatIndex}: ${outcome.status} ` +
          `usd=${outcome.usdCounterfactual.toFixed(6)}\n`,
      );
      if (cumulativeUsd > opts.maxUsd) aborted = true;
    }
  }

  const workerCount = Math.max(1, Math.min(opts.concurrency, matrix.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  inferenceLog.close();

  if (records.length > 0) {
    const summary = aggregate(records, {
      by: 'profile',
      ...(opts.repeat > 1 ? { splitVariance: true } : {}),
    });
    stdout.write(`${renderSummaryTable(summary)}\n`);
  }

  if (aborted) {
    throw new CliError(
      ExitCode.BENCH_PARTIAL,
      `bench aborted: cumulative usdCounterfactual exceeded --max-usd ${opts.maxUsd.toFixed(6)}`,
    );
  }
  if (anyErrored) {
    throw new CliError(ExitCode.BENCH_PARTIAL, 'bench finished with at least one run errored');
  }
}
