import { join, resolve as resolvePath } from 'node:path';

import { openCandidateCache } from '../candidates/cache.js';
import { createCandidateService } from '../candidates/service.js';
import { pathKind, loadConfig } from '../config.js';
import { createEventBus } from '../events/bus.js';
import type { CostSummaryEvent, SolverEvent } from '../events/types.js';
import { IndexUpsertError, createRunRecorder } from '../eval/runRecorder.js';
import type {
  RunRecorderIndexUpdate,
  RunRecorderOptions,
  RunRecorderPuzzleInfo,
} from '../eval/runRecorder.js';
import { score } from '../eval/scorer.js';
import { createDomainStore } from '../grid/domainStore.js';
import { Grid } from '../grid/model.js';
import { openInferenceLog } from '../llm/inferenceLog.js';
import { createNebiusTransport } from '../llm/client.js';
import type { NebiusTransportOptions } from '../llm/client.js';
import { createBudgetTracker, resolveBudget } from '../policy/budget.js';
import { resolveProfile } from '../profiles/loader.js';
import type { ProfileInput } from '../profiles/schema.js';
import { loadPuzzleById, readIndex, readNormalised, upsertIndexRow } from '../puzzle/library.js';
import type { LibraryOptions } from '../puzzle/library.js';
import { loadPuzzleWithSolution, stripSolution } from '../puzzle/loader.js';
import type { Puzzle, PuzzleIndexRow, PuzzleStyle, Slot, Stratum } from '../puzzle/types.js';
import { ConsoleRenderer } from '../render/console.js';
import { createJsonlEventSink } from '../render/jsonl.js';
import { WatchRenderer } from '../render/watch.js';
import { ac3 } from '../solver/ac3.js';
import { createSearchHooks } from '../solver/hooks.js';
import type { SearchHooksDeps } from '../solver/hooks.js';
import { repair } from '../solver/repair.js';
import { search } from '../solver/search.js';
import { solve as runSolveOrchestration } from '../solver/solve.js';
import type { SolveOrchestrationDeps } from '../solver/solve.js';
import type { SolveOptions as SolveRunOptions } from '../solver/types.js';
import { resolveCacheDir, resolveInferenceLogDir, resolvePuzzlesDir, resolveRunsDir } from '../util/fs.js';
import { openWordList } from '../validate/wordlist.js';
import { isCliError } from './exit.js';
import type { GlobalOptions, SolveOptions as SolveCliOptions } from './options.js';
import type { CandidateServiceDeps } from '../candidates/service.js';

/**
 * T45. Everything a test needs to inject to keep this thin composition root
 * from touching a real network, a real API key or the developer's own
 * working directories. The real CLI (`src/cli/index.ts`) never passes this;
 * see `CacheCommandOverrides` (src/cli/cache.ts) and `libraryOptions`
 * (src/cli/show.ts) for the same pattern elsewhere in this codebase.
 */
export interface SolveCommandOverrides {
  /** Defaults to the real orchestration (`src/solver/solve.ts`, T44). */
  solve?: typeof runSolveOrchestration;
  puzzlesDir?: string;
  cacheDir?: string;
  inferenceLogDir?: string;
  /** Where `--out`-less run records and `.events.jsonl` traces land. */
  runsDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Injected so the B31 TTY rule can be tested without a terminal. */
  isTty?: boolean;
  columns?: number;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** Forwarded to the Nebius transport so a test never opens a socket. */
  fetch?: typeof globalThis.fetch;
}

/** Stratum (A1) is derived from style: cryptic is its own stratum, everything else is american. */
function stratumOf(style: PuzzleStyle): Stratum {
  return style === 'cryptic' ? 'cryptic' : 'american';
}

/** `RunRecorderOptions.truth`: slotId -> the correct answer, read off the solution grid. */
function truthOf(slots: readonly Slot[], solution: readonly string[][]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const slot of slots) {
    out[slot.id] = slot.cells
      .map(([row, col]) => (solution[row]?.[col] ?? '').toUpperCase())
      .join('');
  }
  return out;
}

type PerTierCost = CostSummaryEvent['perTier'];

function newPerTierCost(): PerTierCost {
  return {
    tier1: { calls: 0, usdBilled: 0, usdCounterfactual: 0 },
    tier2: { calls: 0, usdBilled: 0, usdCounterfactual: 0 },
  };
}

/** B31: honoured only when `isTty && !CI && TERM !== 'dumb'`. */
function watchTtyHolds(env: NodeJS.ProcessEnv, isTty: boolean): boolean {
  const ci = env.CI !== undefined && env.CI !== '';
  return isTty && !ci && env.TERM !== 'dumb';
}

/**
 * B16: `xw solve <id>` reads `puzzles/<source>/<id>.json` (the normalised
 * file) only, through `puzzle/library.ts`; `xw solve <path>` parses the file
 * format through `puzzle/loader.ts`'s extension dispatch. Disambiguated the
 * same way `profiles/loader.ts` tells a built-in name from a profile file
 * path: an id is not a path that exists on disk.
 */
async function resolvePuzzle(
  target: string,
  libraryOptions: LibraryOptions,
): Promise<{ puzzle: Puzzle; solution: string[][]; indexUpdate: RunRecorderIndexUpdate | false }> {
  if (pathKind(resolvePath(target)) === 'file') {
    const withSolution = await loadPuzzleWithSolution(resolvePath(target));
    return { puzzle: stripSolution(withSolution), solution: withSolution.solution, indexUpdate: false };
  }

  const puzzle = await loadPuzzleById(target, libraryOptions);
  const file = await readNormalised(target, libraryOptions);

  // A run over a puzzle the library has never indexed (the normalised file
  // exists but no `puzzles/index.json` row does) has nothing meaningful to
  // upsert - `files.original`'s path is not derivable from the normalised
  // file alone - so the index update is skipped rather than fabricated.
  const rows = await readIndex(libraryOptions);
  const previousRow: PuzzleIndexRow | undefined = rows.find((row) => row.id === file.id);
  const indexUpdate: RunRecorderIndexUpdate | false =
    previousRow === undefined
      ? false
      : {
          upsertIndexRow: (row) => upsertIndexRow(row, libraryOptions),
          date: file.date ?? null,
          title: file.title ?? null,
          width: file.width,
          height: file.height,
          files: previousRow.files,
          parsedBy: file.parsedBy,
          previousRow,
        };

  return { puzzle, solution: file.solution, indexUpdate };
}

/**
 * T45: the `xw solve` handler. A thin composition root - it contains no
 * solving logic of its own. It resolves the profile (T23) and the puzzle
 * (B16), constructs the real `SolveDeps` (transport, candidate service,
 * grid, domain store, ac3, search, hooks, repair), attaches the renderers
 * per `-v/-vv/-vvv`, `--watch` (B31) and `--trace`, runs `solve()` (T44) and
 * writes the run record (T17).
 *
 * Wiring rules baked in here (see docs/build-notes for the source tasks):
 *  - The Nebius transport (T33) is built with its own inference log disabled
 *    and the real sink handed to the candidate service instead, so a cold
 *    call is never logged twice (T44's own doc comment on `SolveDeps`).
 *  - Nebius base URL precedence is `$NEBIUS_BASE_URL` > `config.nebiusBaseUrl`
 *    > the transport's own default: `config.nebiusBaseUrl` is passed as
 *    `opts.baseUrl` only when the env var is unset, since the transport
 *    itself treats a given `opts.baseUrl` as the highest-precedence layer.
 *  - A missing `NEBIUS_API_KEY` surfaces as the transport's own
 *    `providerError` (exit 5) at construction time, before `solve()` is ever
 *    called; it is not caught here, so it propagates to the CLI's one
 *    top-level catch.
 *  - `solve()` never throws (T44's whole point is that step 8 - scoring -
 *    always runs); a run that ended in error is reported via
 *    `SolveOrchestrationResult.errorCause`, rethrown here when it is a
 *    `CliError` so the right exit code survives (B6: offline miss is 4,
 *    provider failure is 5), or wrapped when it is not.
 *  - `RunRecorder.written()` can reject with `IndexUpsertError` (the run
 *    record itself is safely on disk, but the `puzzles/index.json` upsert
 *    failed, e.g. a lock timeout); that is reported to stderr, not treated
 *    as a lost run.
 *  - `--watch`: when B31's TTY conditions hold, only `WatchRenderer` reads
 *    the live event stream (a plain `ConsoleRenderer` writing to the same
 *    stream at the same time would corrupt `log-update`'s redraw region).
 *    Once `solve()` returns, `WatchRenderer.finish()` releases the held-open
 *    frame, and the whole event stream is then replayed through a fresh
 *    `ConsoleRenderer` at the requested level, so the terminal keeps a
 *    permanent, scrollable record ending in the usual final grid/diff/score/
 *    cost block. When the TTY conditions do not hold, `WatchRenderer`'s own
 *    B31 fallback (one stderr line, every event to an internal
 *    `ConsoleRenderer(0)`) is the only renderer - see `src/render/watch.ts`.
 */
export async function solveCommand(
  target: string,
  opts: SolveCliOptions,
  global: GlobalOptions,
  overrides: SolveCommandOverrides = {},
): Promise<void> {
  const env = overrides.env ?? process.env;
  const stdout = overrides.stdout ?? process.stdout;
  const stderr = overrides.stderr ?? process.stderr;
  const colorOverride: boolean | undefined = global.color ? undefined : false;

  const { config } = await loadConfig({ path: global.config });

  // -------------------------------------------------------------------------
  // Profile (T23, B26): `--tier1`/`--tier2`/`--budget-usd` are the highest
  // precedence layer, applied as explicit CLI overrides.
  // -------------------------------------------------------------------------
  const profileOverrides: Partial<ProfileInput> = {};
  if (opts.tier1 !== undefined) profileOverrides.tier1 = opts.tier1;
  if (opts.tier2 !== undefined) profileOverrides.tier2 = opts.tier2;
  if (opts.budgetUsd !== undefined) profileOverrides.budget = { usd: opts.budgetUsd };
  const { profile, source: profileSource } = await resolveProfile({
    profile: opts.profile,
    config,
    overrides: profileOverrides,
  });

  // -------------------------------------------------------------------------
  // Puzzle (B16).
  // -------------------------------------------------------------------------
  const puzzlesDir = overrides.puzzlesDir ?? resolvePuzzlesDir({ config: config.puzzlesDir, env });
  const libraryOptions: LibraryOptions = { puzzlesDir };
  const { puzzle, solution, indexUpdate } = await resolvePuzzle(target, libraryOptions);

  const puzzleInfo: RunRecorderPuzzleInfo = {
    id: puzzle.id,
    source: puzzle.source,
    style: puzzle.style,
    stratum: stratumOf(puzzle.style),
    size: `${puzzle.width}x${puzzle.height}`,
    slots: puzzle.slots.length,
  };

  // -------------------------------------------------------------------------
  // Run recorder (T17). Constructed first so its own `makeRunId` computation
  // is the single source of truth for this run's id: the event bus, the
  // candidate service and the jsonl trace all read it back rather than each
  // recomputing it, which would risk two different strings for one run.
  // -------------------------------------------------------------------------
  const recorderOptions: RunRecorderOptions = {
    puzzle: puzzleInfo,
    truth: truthOf(puzzle.slots, solution),
    profile,
    profileSource,
    repeatIndex: 0,
    updateIndex: indexUpdate,
  };
  if (opts.out !== undefined) recorderOptions.out = opts.out;
  const recorder = createRunRecorder(recorderOptions);
  const runId = recorder.record().runId;

  const bus = createEventBus({ runId });
  bus.on(recorder.handler);

  // -------------------------------------------------------------------------
  // Cost tally (T44's `SolveDeps` doc comment): `solve()` prices only the
  // seed pass it makes itself. Every re-ask, escalation and repair call is
  // priced solely on the `llm:usage` event the candidate service emits
  // straight to the bus, which never passes through `solve()`. Subscribing
  // here and handing `() => costTally` back as `deps.costs` below replaces
  // (rather than adds to) `solve()`'s own seed-only tally, since the seed
  // pass's calls emit `llm:usage` too - see `CandidateService.callTransport`
  // (src/candidates/service.ts) - and reach this same handler. This mirrors
  // `RunRecorder`'s own `modelTier` (src/eval/runRecorder.ts), which is why
  // the printed cost block agrees with the run record.
  // -------------------------------------------------------------------------
  const costTally = newPerTierCost();
  bus.on((event) => {
    if (event.type !== 'llm:usage') return;
    const tier =
      event.model === profile.tier1 ? 'tier1' : event.model === profile.tier2 ? 'tier2' : null;
    if (tier === null) return;
    const stats = costTally[tier];
    stats.calls += 1;
    stats.usdBilled += event.usdBilled;
    stats.usdCounterfactual += event.usdCounterfactual;
  });

  // -------------------------------------------------------------------------
  // Renderers: `ConsoleRenderer(level)` normally; `WatchRenderer` in place of
  // it when `--watch` and B31 hold (see the doc comment above); `JsonlEventSink`
  // at `-vvv` or `--trace`.
  // -------------------------------------------------------------------------
  const level = opts.verbose;
  let watchRenderer: WatchRenderer | null = null;
  let eventLog: SolverEvent[] | null = null;

  if (opts.watch) {
    const isTty = overrides.isTty ?? process.stdout.isTTY === true;
    const ttyHolds = watchTtyHolds(env, isTty);
    watchRenderer = new WatchRenderer({
      isTty,
      env,
      color: colorOverride,
      columns: overrides.columns,
      stdout,
      stderr,
      solution,
    });
    if (ttyHolds) {
      // Only the live branch needs a replay buffer: the B31 fallback branch
      // already drives its own internal ConsoleRenderer(0) live, and
      // replaying on top of that would print everything twice.
      eventLog = [];
      const log = eventLog;
      bus.on((event) => { log.push(event); });
    }
    const watcher = watchRenderer;
    bus.on((event) => { watcher.handle(event); });
  } else {
    const consoleRenderer = new ConsoleRenderer(level, stdout, {
      color: colorOverride,
      columns: overrides.columns,
      solution,
    });
    bus.on((event) => { consoleRenderer.handle(event); });
  }

  let jsonlSink: ReturnType<typeof createJsonlEventSink> | null = null;
  if (level === 3 || opts.trace) {
    const runsDir = overrides.runsDir ?? resolveRunsDir({ env });
    jsonlSink = createJsonlEventSink(join(runsDir, `${runId}.events.jsonl`));
    const sink = jsonlSink;
    bus.on(sink.handler);
  }

  // -------------------------------------------------------------------------
  // Candidate service (T34) over the Nebius transport (T33).
  // -------------------------------------------------------------------------
  const cacheDir = overrides.cacheDir ?? resolveCacheDir({ flag: global.cacheDir, env });
  const cache = openCandidateCache({ cacheDir });

  // Base URL precedence is $NEBIUS_BASE_URL > config.nebiusBaseUrl > the
  // transport's own default (see the doc comment above): only pass the
  // config value through when the env var is unset, since the transport
  // treats a given `opts.baseUrl` as the highest-precedence layer of all.
  const baseUrl = env['NEBIUS_BASE_URL'] === undefined ? config.nebiusBaseUrl : undefined;
  const transportOptions: NebiusTransportOptions = {
    // Disabled here and handed to the service instead (see the doc comment
    // above), so a cold call is logged exactly once.
    inferenceLog: openInferenceLog({ enabled: false }),
    env,
  };
  if (baseUrl !== undefined) transportOptions.baseUrl = baseUrl;
  if (overrides.fetch !== undefined) transportOptions.fetch = overrides.fetch;
  // Not caught: a missing NEBIUS_API_KEY throws the transport's own
  // `providerError` (exit 5) here, before `solve()` is ever called.
  const transport = createNebiusTransport(transportOptions);

  const serviceInferenceLog = openInferenceLog({
    dir: overrides.inferenceLogDir ?? resolveInferenceLogDir({ config: config.inferenceLogDir, env }),
    enabled: opts.inferenceLog,
  });

  const serviceOptions: CandidateServiceDeps = {
    transport,
    cache,
    inferenceLog: serviceInferenceLog,
    profile,
    emit: (event) => { bus.emit(event); },
    runId,
    puzzleId: puzzle.id,
    offline: opts.offline,
    offlineLenient: opts.offlineLenient,
  };
  if (opts.seed !== undefined) serviceOptions.seed = opts.seed;
  const service = createCandidateService(serviceOptions);

  // -------------------------------------------------------------------------
  // Grid, domains, budget, search hooks, word list.
  // -------------------------------------------------------------------------
  const grid = new Grid(puzzle);
  const domains = createDomainStore();
  const budget = createBudgetTracker(resolveBudget(profile));

  const hooksOptions: SearchHooksDeps = {
    grid,
    domains,
    service,
    budget,
    profile,
    emit: (event) => { bus.emit(event); },
    style: puzzle.style,
    sampleIndex: 0,
    parseFailures: (slotId) => service.parseFailures(slotId),
  };
  if (puzzle.title !== undefined) hooksOptions.title = puzzle.title;
  const hooks = createSearchHooks(hooksOptions);

  const wordList = openWordList(config.wordlistPath);

  const deps: SolveOrchestrationDeps = {
    grid,
    domains,
    service,
    hooks,
    wordList,
    ac3,
    search,
    repair,
    emit: (event) => { bus.emit(event); },
    score: (snapshot) => score(snapshot, solution, puzzle.slots),
    puzzle,
    costs: () => costTally,
  };

  const solveOpts: SolveRunOptions = {
    runId,
    puzzleId: puzzle.id,
    repeatIndex: 0,
    seed: opts.seed ?? null,
    offline: opts.offline,
    offlineLenient: opts.offlineLenient,
  };

  const solve = overrides.solve ?? runSolveOrchestration;

  try {
    const result = await solve(deps, profile, solveOpts);

    if (watchRenderer !== null) {
      const watcher = watchRenderer;
      watcher.finish();
      if (eventLog !== null) {
        const replay = new ConsoleRenderer(level, stdout, { color: colorOverride, solution });
        for (const event of eventLog) replay.handle(event);
      }
    }

    let recordPath: string;
    try {
      recordPath = await recorder.written();
    } catch (cause) {
      if (cause instanceof IndexUpsertError) {
        // The run record itself is safe on disk (see `cause.recordPath`);
        // only the puzzles/index.json upsert failed. Reported, not fatal -
        // the run is not lost.
        stderr.write(`${cause.message}\n`);
        recordPath = cause.recordPath;
      } else {
        throw cause;
      }
    }
    stdout.write(`run record written to ${recordPath}\n`);

    if (result.status === 'error') {
      if (isCliError(result.errorCause)) throw result.errorCause;
      throw new Error(result.error ?? `solve failed for "${target}"`);
    }
  } finally {
    if (jsonlSink !== null) await jsonlSink.close();
  }
}
