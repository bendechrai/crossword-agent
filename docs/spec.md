# Crossword solver specification

Spec version 2 (2026-09-03), revised after review.

Purpose: define v1 of a Node.js crossword solver that treats an LLM as a candidate oracle wrapped in a deterministic constraint search, and that is instrumented well enough to answer strategy questions with measurements rather than opinions.

Builds on: [crossword-algorithms.md](./crossword-algorithms.md) (prior art, recommended algorithm, module list, open questions), [model-selection.md](./model-selection.md) (two-tier model decision), [crossword-sources.md](./crossword-sources.md) (puzzle sources, file formats, verified parsers).

## Goals

1. Solve American-style and British cryptic crosswords from `.puz`, `.ipuz`, `.jpz` and `.xd` files, reporting letter accuracy, word accuracy and perfect-puzzle rate against the solution grid shipped in the file.
2. Keep the LLM strictly as a candidate oracle. All ordering, commitment, backtracking and repair is deterministic code.
3. Make every run reproducible and replayable: a candidate cache means a run can be re-executed with `--offline` and zero network calls.
4. Make strategy a first-class experiment. Profiles are data; `bench` runs a matrix; `report` aggregates. Changing the search policy over already-cached clues costs close to nothing.
5. One event stream drives all output. Verbosity levels, the `--watch` visual, the JSON run record and replay are all subscribers.
6. Never lose raw data. Every inference request and response is written to an always-on local log, independent of verbosity and of which command triggered it.

Cryptics are in scope for loading, solving and measurement. Every bench puzzle-set entry carries a `stratum` (`"american" | "cryptic"`), `report` groups by stratum, and both strata are measured - but the escalation-policy decision and the batch-size decision are made on the american stratum only, so a cryptic-specific weakness never silently drives a general policy choice.

## Non-goals for v1

- Cryptic-specific prompting (wordplay decomposition, indicator dictionaries). Cryptics are loaded, solved and measured with the general prompt plus a style hint; the style field is passed through so a later prompt version can branch on it.
- Loopy belief propagation. Domains of 10 unnormalised candidates give near-degenerate marginals; revisit only if a cached corpus makes domains dictionary-scale.
- A web UI. The terminal renderer is the only visual.
- Batching as the default (batchSize stays 1 until the batch-size bench justifies otherwise).
- Fitting calibration weights automatically. v1 ships `rank` calibration; weight fitting is v1.1 (M6).
- Authoring or exporting puzzles. The solver never writes a puzzle file it did not download.

v1 is M1-M5, which includes the repair pass. M6 is v1.1.

## Architecture overview

The solver core is a state machine over the grid. It is pure in spirit: given a grid, a domain store and a profile, its transitions are deterministic. Its only outward dependency is `CandidateService`, and its only outward emission is a typed `SolverEvent`. Nothing in `src/solver/` writes to stdout, reads the clock for anything but a duration field, or knows a renderer exists.

```
  sources/            fetch                       load
  guardian --.                                       .-> Grid (cells, slots, crossings)
  xd -------- >--> puzzles/<source>/<id>.{ext,json} -+-> DomainStore (trailed domains)
  file -----'      puzzles/index.json                 '-> solution (separate accessor)
                                                            |
                                                            v
                                                    +---------------+
                                                    |    solver     |
                                                    | ac3 / search  |
                                                    | repair        |
                                                    +---------------+
                                                     |            ^
                                       getCandidates |            | Candidate[]
                                                     v            |
                                            +--------------------------+
                                            |    CandidateService      |
                                            | validate -> calibrate    |
                                            +--------------------------+
                                              |        ^          |  ^
                                       lookup |        | hit      |  | parsed
                                              v        |          v  |
                                         +---------------+   +----------------+
                                         | cache (LRU +  |   | tierRouter ->  |
                                         |  disk, incl.  |   | LlmTransport ->|
                                         |  negatives)   |   | Nebius API     |
                                         +---------------+   +----------------+
                                                                     |
                                                 logs/inference/<date>.jsonl (always on)

  solver --emit--> EventBus --> ConsoleRenderer(level)
                             --> WatchRenderer
                             --> RunRecorder    --> runs/<runId>.json
                             --> JsonlEventSink --> runs/<runId>.events.jsonl --> replay
```

## Stack and development environment

| Choice | Value | Why |
| --- | --- | --- |
| Runtime | Node.js 22 LTS, ESM (`"type": "module"`) | Native fetch, stable LTS through v1. |
| Language | TypeScript 5.x, `strict: true`, `noUncheckedIndexedAccess: true`, eslint clean, no `any` | The grid model is index-heavy; the compiler should catch it. |
| CLI | `commander`, bin name `xw` (with `crossword` declared as an alias bin in `package.json`, so both names work) | Subcommand tree with per-command options, no framework. `xw` is short enough to type dozens of times an hour. |
| Tests | `vitest` | ESM-native, fast watch mode, built-in v8 coverage. |
| JSON Schema | `ajv` (+ `ajv-formats`) | Validates the LLM response, the run record, the normalised puzzle and `puzzles/index.json`. DeepSeek structured outputs consume JSON Schema directly, so the same schema object is both the request constraint and the validator. |
| Config validation | `zod` for profiles and resolved CLI config | Profiles are internal, not a wire format. `z.infer` gives one source of truth for the `Profile` type instead of a hand-written interface plus a schema, and the error messages are better for a human editing a profile file. Wire formats stay on ajv. |
| Logging | minimal custom leveled logger in `src/util/log.ts` (about 60 lines) | Leveled output is already the event stream's job. `pino` would add a second, competing output path for what is otherwise a handful of bootstrap and fatal-error lines. |
| Terminal UI | `log-update` + `chalk` | Full-frame redraw on each grid change; `chalk` respects `NO_COLOR` and non-TTY. |
| Puzzle parsing | `@xwordly/xword-parser` (v1.1.0, MIT, reads .puz/.ipuz/.jpz/.xd); fallback `xd-crossword-tools` (v14.1.0) | Both package names verified in crossword-sources.md. The loader tries `@xwordly/xword-parser` first and falls back on throw, recording which parser succeeded. |
| Package manager | `npm` | Ships with Node 22, no extra install layer in the image, single package with no workspaces. |

Development is Docker-only, and the point is that someone can clone the repo and run the solver with nothing installed on the host but Docker. The pattern is a long-running container that you exec into, not one-shot `docker compose run` invocations.

```yaml
services:
  solver:
    build: { context: ., dockerfile: Dockerfile }
    container_name: crossword-solver
    env_file: [.env]                 # NEBIUS_API_KEY, optional NEBIUS_BASE_URL
    working_dir: /app
    command: ["sleep", "infinity"]
    restart: unless-stopped
    volumes:
      - .:/app
      - node_modules:/app/node_modules
volumes: { node_modules: {} }
```

The container name stays `crossword-solver`; only the CLI is renamed.

No ports are published: this is a CLI. `node_modules` sits in a named volume so the host tree stays clean and a Linux-built install is never overwritten by a macOS one. Everything else - `puzzles/`, `runs/`, `logs/`, `data/` and `cache/candidates/` - is on the bind mount, so all fetched puzzles, run records, inference logs, word lists and cached candidates persist on the host and survive a container rebuild.

Because `node_modules` lives in a volume, it can drift from `package-lock.json`. The container entrypoint records the lock file's hash in the volume and re-runs `npm ci` whenever the current hash differs, so a dependency change is picked up without a manual step. `docker compose down -v` remains the sledgehammer if the volume is ever wedged.

The Dockerfile is `node:22-slim`, `npm ci`, then `npm link` so the package bin named `xw` (and its `crossword` alias) is on `PATH` inside the container. That bin is a `tsx` entry point (`tsx src/cli/index.ts`), so the bind-mounted source is picked up on every invocation with no build step in the dev loop; `npm run build` exists for CI and for producing `dist/`, but you never need it to try a change. Commands are:

```
docker exec -it crossword-solver xw solve guardian-cryptic-30085 -vv
docker exec -it crossword-solver npm test
docker exec -it crossword-solver npm run lint
```

`-it` matters: the `--watch` renderer needs a TTY, and without it `WatchRenderer` falls back to `ConsoleRenderer(0)`.

A one-line host-side wrapper `./xw` is committed as optional sugar over that form:

```sh
#!/bin/sh
exec docker exec -it crossword-solver xw "$@"
```

so the rest of this document can write `./xw solve <id>`. It is convenience only; the `docker exec` form is always equivalent.

Note for later: `ralph`, the autonomous Claude Code container in Ben's environment, can join this compose network so it drives the same long-running solver container. Not designed here.

### Quick start

```
git clone <repo> && cd crossword-agent
cp .env.example .env            # then add NEBIUS_API_KEY
docker compose up -d
./xw fetch guardian --series quick --limit 5
./xw solve guardian-quick-17342 -v
```

## Repository layout

```
src/
  cli/            index.ts (bin) fetch.ts list.ts show.ts solve.ts bench.ts report.ts cache.ts options.ts exit.ts
  puzzle/         loader.ts library.ts types.ts numbering.ts
  puzzle/adapters/ guardian.ts
  grid/           model.ts domains.ts pattern.ts
  llm/            types.ts client.ts tierRouter.ts prompts.ts parser.ts pricing.ts rateLimiter.ts inferenceLog.ts
  candidates/     service.ts cache.ts
  validate/       normalise.ts wordlist.ts
  score/          calibrate.ts
  solver/         solve.ts ac3.ts search.ts ordering.ts repair.ts
  policy/         escalation.ts budget.ts
  eval/           scorer.ts runRecorder.ts aggregate.ts inference.ts
  events/         types.ts bus.ts levels.ts
  render/         console.ts watch.ts jsonl.ts replay.ts
  sources/        types.ts registry.ts guardian.ts xd.ts file.ts
  profiles/       schema.ts builtins.ts loader.ts
  util/           log.ts hash.ts fs.ts
schemas/          candidate-response.schema.json  run-record.schema.json  puzzle-index.schema.json  puzzle.schema.json
sets/             mixed-30.json ... (committed puzzle sets)
config/           calibration.json (committed)
docs/benches/     committed `report --md` output, one file per bench
test/
  unit/ integration/ contract/
  fixtures/cache/ fixtures/responses/ fixtures/runs/ fixtures/wordlist.txt
puzzles/          <source>/... (gitignored) - nothing under puzzles/ is committed
corpora/          xd-puzzles.zip and friends (gitignored)
data/             wordlist/collaborative.txt (gitignored)
runs/             (gitignored)
logs/inference/   (gitignored)
cache/candidates/ (gitignored)
dist/             (gitignored)
xw                 host-side wrapper: exec docker exec -it crossword-solver xw "$@"
Dockerfile  docker-compose.yml  .env.example  models.json  crossword.config.json (optional)
```

`.gitignore` carries:

```
node_modules/
dist/
runs/
logs/
cache/
corpora/
data/
puzzles/**
!puzzles/fixtures/**
```

What is committed and what is not:

- **Never committed:** fetched puzzles (`puzzles/<source>/`), run records under `runs/`, inference logs, the candidate cache outside `test/fixtures/cache/`, downloaded corpora and word lists. The README states that fetched puzzles are not redistributed.
- **Committed:** the two synthetic fixture puzzles under `test/fixtures/puzzles/`; the test cache at `test/fixtures/cache/`; the 2,000-line word-list subset at `test/fixtures/wordlist.txt`; run records for those two fixtures only, under `test/fixtures/runs/`; puzzle sets under `sets/`; calibration weights under `config/`; and the aggregated `report --md` output of each bench under `docs/benches/`.

## Data model

```ts
// puzzle/types.ts
export type Direction = 'across' | 'down';
export type PuzzleStyle = 'american' | 'cryptic' | 'quick' | 'unknown';
export type Stratum = 'american' | 'cryptic';

export interface Cell { row: number; col: number; block: boolean; number?: number; }

export interface Slot {
  id: string;                 // `${number}${'A'|'D'}`, e.g. "12A"
  number: number;
  direction: Direction;
  row: number; col: number;   // start cell, [row, col] with row 0 top and col 0 left
  length: number;
  clue: string;               // verbatim from the source
  enumeration?: string;       // "(3,4)" - prompt only, never used for validation
  cells: ReadonlyArray<readonly [number, number]>;
}

export interface Puzzle {
  id: string; source: string; date?: string; title?: string; author?: string;
  style: PuzzleStyle; width: number; height: number;
  cells: Cell[][]; slots: Slot[];
  parsedBy: '@xwordly/xword-parser' | 'xd-crossword-tools' | 'guardian-json';
}

export interface PuzzleWithSolution extends Puzzle { solution: string[][]; }

export function loadPuzzle(path: string): Promise<Puzzle>;
export function loadPuzzleWithSolution(path: string): Promise<PuzzleWithSolution>;   // scorer's loader path only
```

There is no optional `solution` field on `Puzzle`. The solver is handed a `Puzzle`, which structurally cannot carry the answers; only `eval/scorer.ts` calls `loadPuzzleWithSolution`.

Cells are addressed as `[row, col]` throughout, row 0 at the top and col 0 at the left, and rendered as `r{row}c{col}` in events and error messages.

```ts
// grid/model.ts
export interface Crossing { otherSlotId: string; offsetInThis: number; offsetInOther: number; }
export interface GridSnapshot { letters: (string | null)[][]; assigned: Record<string, string>; }

export class Grid {
  constructor(puzzle: Puzzle);
  readonly slots: ReadonlyMap<string, Slot>;
  assign(slotId: string, answer: string): void;    // throws on conflict
  unassign(slotId: string): void;                  // trail-based, exact undo
  patternFor(slotId: string): string;              // "A?I?N", '?' = unknown
  regexFor(slotId: string): RegExp;                // /^A[A-Z]I[A-Z]N$/
  crossings(slotId: string): Crossing[];           // 0..n; an unchecked slot returns fewer
  isChecked(row: number, col: number): boolean;    // false for a cell in only one slot
  letterAt(row: number, col: number): string | null;
  assignmentOf(slotId: string): string | undefined;
  isComplete(): boolean;
  snapshot(): GridSnapshot;
}
```

Unchecked cells are supported rather than assumed away: `crossings()` may return an empty array, AC-3 simply has fewer arcs, the repair gate reads "the changed letter appears in some cached candidate for **any** crossing slot, or the result is in the word list", and the backtracking target falls back to the lowest-margin assignment anywhere in the grid when the failing slot has no crossings at all.

```ts
// grid/domains.ts - domains live outside Grid, with their own depth-indexed trail
export interface DomainStore {
  get(slotId: string): readonly Candidate[];
  setBase(slotId: string, candidates: readonly Candidate[]): void;   // seed result
  merge(slotId: string, candidates: readonly Candidate[]): void;     // re-ask result, joins the base domain and survives backtracking
  reduce(slotId: string, keep: (c: Candidate) => boolean): number;   // trailed; returns the number removed
  push(): void;                                                      // open a trail frame for the next search depth
  pop(): void;                                                       // undo every trailed reduction back to the previous frame
  depth(): number;
  isSuspect(slotId: string): boolean;
  markSuspect(slotId: string): void;
}
```

Forward-check and AC-3 reductions are trailed and undone exactly on backtrack. Re-ask results are merged into the slot's **base** domain and therefore persist across backtracks; the pattern filter is re-applied at every node, so a merged candidate that no longer fits is filtered again rather than lost.

```ts
// candidates/service.ts
export type Tier = 1 | 2;
export type RejectReason = 'length' | 'charset' | 'pattern' | 'clue-echo' | 'duplicate' | 'rejected-before';
export type Purpose = 'seed' | 'reask' | 'escalate' | 'repair' | 'smoke' | 'calibrate';
export type PromptKind = 'seed' | 'constrained' | 'escalate';

export interface Candidate {
  answer: string;            // normalised A-Z
  raw: string;               // as returned
  rank: number;              // 0-based position in the model's list
  selfConfidence: number;    // clamped 0..1
  votes: number;             // 1 unless samples > 1
  score: number;             // calibrated search score
  tier: Tier;
  fromCache: boolean;
}

export interface CandidateRequest {
  slotId: string; clue: string; length: number; pattern: string;
  style: PuzzleStyle; enumeration?: string; title?: string;
  rejected: ReadonlyArray<{ answer: string; reason: string }>;
  tier: Tier; purpose: Purpose; n: number; samples: number; sampleIndex: number;
  crossingContext?: Array<{ slotId: string; clue: string; fill: string | null; confidence: number }>;
}

// Wire shape returned by the model; schemas/candidate-response.schema.json
export interface CandidateResponse {
  clue_understood: number;
  candidates: Array<{ answer: string; confidence: number }>;
  notes?: string;            // may carry crossing_suspect: "<slotId>"
}

export interface CandidateService {
  getCandidates(req: CandidateRequest): Promise<{
    candidates: Candidate[]; clueUnderstood: number; notes?: string;
    cacheHit: boolean; usage?: TokenUsage;
  }>;
  peek(slotId: string): Candidate[];   // every candidate ever returned for that slot in this run
}
```

`peek` is the ledger the repair gate reads: it is deliberately not the current domain, because a candidate pruned by AC-3 or by a since-undone assignment is still evidence that a letter is plausible.

```ts
// llm/types.ts
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
}

export interface LlmRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  temperature: number; maxTokens: number; topP?: number;
  responseFormat?: unknown;             // present only when the model advertises structured_outputs
  extra?: Record<string, unknown>;      // capability-gated params (reasoning off, provider seed)
  signal?: AbortSignal;
}

export interface LlmResult {
  text: string;
  usage: TokenUsage;
  httpStatus: number;
  headers: Record<string, string>;
  latencyMs: number;
}

export interface LlmTransport { complete(req: LlmRequest): Promise<LlmResult>; }
```

`LlmTransport` is the seam that lets the candidate service and the Nebius client be built independently: the service is written against a stub transport, the client is written against the interface, and neither waits for the other.

```ts
// llm/inferenceLog.ts
export interface InferenceLogRecord {
  id: string;                       // uuid v4, one per call attempt
  ts: string;                       // ISO 8601
  runId: string | null;             // null outside a run (smoke, calibrate)
  puzzleId: string | null;
  slotId: string | null;
  purpose: Purpose;
  promptKind: PromptKind;
  tier: Tier;
  model: string;
  promptVersion: string;
  cacheKey: string;
  cacheHit: boolean;
  batchSize: number;                // 1 for a single-clue call
  batchIndex: number | null;        // clue's position within the batch; null on a cache hit
  sampleIndex: number;
  request: {
    messages: Array<{ role: 'system' | 'user'; content: string }>;
    temperature: number; maxTokens: number; topP?: number;
    responseFormat?: unknown;       // present only for structured-output calls
    extra?: Record<string, unknown>;
  } | null;                         // null on a cache hit
  rawResponse: string | null;       // verbatim text, null on a cache hit or transport error
  parsed: CandidateResponse | null;
  parseError: string | null;
  httpStatus: number | null;
  responseHeaders: Record<string, string>; // never carries authorization or any API-key header - those are request headers
  attempt: number;                  // 0-based retry index
  usage: TokenUsage | null;         // populated on cache hits too, from the cached usage blob
  usdBilled: number | null;         // 0 on a cache hit
  usdCounterfactual: number | null; // what the call would have cost cold
  latencyMs: number | null;
  error: string | null;             // transport or abort error message
}

export interface InferenceLog { write(record: InferenceLogRecord): void; }
export function openInferenceLog(opts: { dir?: string; enabled?: boolean }): InferenceLog;
```

```ts
// policy/escalation.ts
export interface EscalationContext {
  slotId: string;
  point: 'after-candidates' | 'at-termination';
  clueUnderstood: number | null;
  domainSize: number;
  parseFailures: number;
  reasksUsed: number;
  escalationsUsed: number;
  tier2CallsUsed: number;
  patternFixedLetters: number;
  lastPatternQueried: string | null;
  currentPattern: string;
  budget: ResolvedBudget;
  spent: { usd: number; tokens: number; tier2Calls: number; repairCalls: number; backtracks: number; wallMs: number };
  profile: Profile;
}

export interface EscalationDecision {
  action: 'none' | 'reask' | 'escalate' | 'give-up';
  trigger?: 1 | 2 | 3 | 4 | 5;
  reason: string;
}

export function decide(ctx: EscalationContext): EscalationDecision;
```

`decide` is a pure function of its context, which makes the whole escalation policy a table-driven unit test. It is consulted after **every** `getCandidates` return and once more at search termination for each still-empty slot.

```ts
// policy/budget.ts
export interface ResolvedBudget {
  usd: number;
  tokens: number;
  wallMs: number;
  tier2Calls: number;      // from escalation.maxTier2CallsPerPuzzle
  backtracks: number;      // from search.maxBacktracks
  repairCalls: number;     // from repair.maxCalls
}

export function resolveBudget(profile: Profile): ResolvedBudget;
```

```ts
// validate/wordlist.ts
export interface WordList {
  has(w: string): boolean;
  score(w: string): number;
  match(pattern: string, limit: number): string[];
}

export function openWordList(path?: string): WordList;   // null object when the file is absent
```

Default source is the Crossword Nexus collaborative word list (MIT), fetched by `npm run wordlist:fetch` into `data/wordlist/collaborative.txt` (gitignored). A 2,000-line subset is committed at `test/fixtures/wordlist.txt` so unit tests never depend on the download. When no word list is present, `openWordList` returns a null object: `has` is always false, `score` always 0, `match` always empty. The repair word-list gate is then disabled, the empty-slot fallback leaves blanks instead of guessing, and a one-time warning is printed.

```ts
// sources/types.ts
export interface PuzzleRef { id: string; source: string; date?: string; title?: string; url: string; ext: 'puz'|'ipuz'|'jpz'|'xd'|'json'; }
export interface SourceAdapter {
  id: string;
  list(opts: { series?: string; date?: string; from?: string; to?: string; limit?: number }): Promise<PuzzleRef[]>;
  download(ref: PuzzleRef): Promise<{ bytes: Buffer; ext: PuzzleRef['ext'] }>;
  normalise(bytes: Buffer, ref: PuzzleRef): Promise<PuzzleWithSolution>;
}
```

`Profile`, `SolverEvent` and `RunRecord` are defined in their own sections below.

## Puzzle library and sources

Adapters are registered in `src/sources/registry.ts` by `id`.

- `guardian`: `GET https://www.theguardian.com/crosswords/<series>/<id>.json`. Series: `quick|cryptic|prize|quiptic|speedy|everyman|weekend`. `list()` walks ids backwards from the latest found on the series page. Style is `cryptic` for `cryptic|prize|quiptic|everyman|weekend` and `quick` for `quick|speedy`. This is an unofficial endpoint, and the adapter is deliberately constrained to personal-research volumes:
  - a descriptive `User-Agent` of `crossword-agent/<version> (+https://github.com/bendechrai/crossword-agent; personal research)`;
  - a hard ceiling of one request per second, independent of any other rate limiting;
  - `--limit` defaults to 1 and is capped at 20, with a usage error above that;
  - no archive-backfill command exists, and none will be added in v1;
  - the README states plainly that this adapter is for personal research and that fetched puzzles are not redistributed.
- `xd`: reads a local directory or a `.zip` of the xd corpus (`--path`, default `./corpora/xd-puzzles.zip`). No network.
- `file`: imports a local path or a URL to a single `.puz/.ipuz/.jpz/.xd`.

`src/puzzle/adapters/guardian.ts` converts the Guardian JSON's `crossword.entries[]` into a `PuzzleWithSolution`, and such puzzles record `parsedBy: 'guardian-json'`.

**Loading rules**, applied by every adapter and format alike:

- **Clue numbering is always recomputed from the grid.** A white cell starts a number if it begins an across run of at least 2 or a down run of at least 2; numbers run left to right, top to bottom, from 1. Where the source also supplies numbering, a mismatch is a load error (exit 3) naming the first divergent cell as `r{row}c{col}`. Trusting our own numbering while silently ignoring the source's is how a whole grid ends up off by one.
- **Minimum slot run length is 2**, configurable per style. A run with no corresponding clue in the source's clue list is not a slot.
- **Enumeration is derived**, either by matching a trailing `(3,4)`-style group on the clue text or from a structured source field. It is prompt-only and never affects validation. The clue text itself is kept verbatim, including the enumeration group.

**Storage.** The original goes to `puzzles/<source>/<id>.<ext>` and the normalised puzzle to `puzzles/<source>/<id>.json`. The normalised file is a serialised `PuzzleWithSolution` plus `schemaVersion: 1` and `fetchedAt` (ISO 8601), validated by `schemas/puzzle.schema.json`. `xw solve <id>` reads the normalised JSON only; `xw solve <path>` parses the file format.

A row is upserted into `puzzles/index.json` (validated by `schemas/puzzle-index.schema.json`) holding `{ id, source, date, title, style, width, height, slotCount, files: { original, normalised }, schemaVersion, parsedBy, addedAt, bestLetterAccuracy, lastRunAt }`. `files` paths are repo-relative and POSIX-separated. The last two fields are updated by `RunRecorder` at the end of every run.

All index writes go through a single writer that takes an `O_EXCL` lock file at `puzzles/.index.lock` (5 s timeout, then a clear error) and writes through a temp file plus atomic rename. `bench` at concurrency 2 or more otherwise loses rows.

`list` and `show` read only the index and the normalised JSON, so they work offline.

## Candidate service

`CandidateService.getCandidates` is the only route the solver has to the outside world, and it does five things in order.

**1. Cache lookup.** The key is

```
sha1(canonicalJson({
  model, promptVersion, promptKind, clue, enumeration, length, pattern, style, title,
  n, samples, sampleIndex, batchSize,
  rejected,            // sorted, so ordering never changes the key
  crossingContext,     // normalised, or null when absent
  temperature, topP, maxTokens
}))
```

where `canonicalJson` (in `src/util/hash.ts`) serialises with sorted keys and no incidental whitespace, and `promptKind` is one of `seed`, `constrained` or `escalate` - three prompt templates, with re-ask and repair both rendering `constrained`. Policy fields (escalation policy, ordering, LDS limits, budgets) stay out of the key, because they never change the text sent to the model.

The invariant is simply stated: **every field that can change the bytes of the prompt or the sampling parameters is in the key, and nothing else is.** A contract test enumerates the prompt-visible fields and asserts that mutating each one yields a different key.

Two layers: an in-process LRU (2,000 entries) and a disk cache at `<cacheDir>/<first2>/<sha1>.json` holding `{ key, keyFields, response, usage, latencyMs, model, createdAt }`, where `keyFields` is the object that was hashed, so a cache file is self-describing. Negative results (zero valid candidates) are cached in the same shape, so backtracking never re-pays for a known dead end.

Cache directory resolution, highest precedence first: `--cache-dir` > `$CROSSWORD_CACHE_DIR` > `./cache/candidates`. There is no eviction in v1; `xw cache stats` prints a warning once the directory exceeds 1 GB.

With `--offline`, a miss is **fatal**: the run exits 4 with a message naming the cache key and the clue, because a silently degraded offline run produces a number that looks like a measurement and is not. `--offline-lenient` restores the older graceful behaviour - the miss ends the current phase with whatever fill exists and the run continues to scoring - for the cases where a partial replay is genuinely what you want.

**2. Tier routing.** `tierRouter` maps `req.tier` to a model id from the profile (`tier1` default `nvidia/Nemotron-3_5-Lightning`, `tier2` default `deepseek-ai/DeepSeek-V4-Pro`) and picks the transport **by capability, not by model name**: it reads `supported_features` for that model from `models.json`, and if `structured_outputs` is present it sends `response_format: { type: 'json_schema', json_schema: { name: 'candidate_response', schema: <candidate-response.schema.json>, strict: true } }`; otherwise it puts the schema inline in the prompt with a one-shot example. The `{ name, schema, strict }` wrapper (rather than the schema document sent directly as `json_schema`) was confirmed against the live Nebius API in M2 (T49): Nebius's own request validator rejects the bare schema document with a "field required: name" error and accepts the wrapped form, which M2 also confirmed produces a real, correctly-parsed completion end to end (see docs/spikes/tier1-reliability.md section 2). Swapping either tier's model in a profile therefore cannot silently send a request form the model does not support.

Two other parameters are capability-gated the same way. For every tier-1 call when the model advertises `reasoning` (tier 2 keeps the seed-only rule until measured; see docs/spikes/tier1-reliability.md, 2026-09-04 follow-up), the router sends the provider's reasoning-off (or minimal-reasoning) parameter, because chain-of-thought on a "list ten six-letter answers" task buys nothing and is billed as completion tokens. For `nvidia/Nemotron-3_5-Lightning`, M2 (T49) found this parameter empirically: `reasoning_effort`, sent as the string `"none"`. Nebius's own request validator names the full accepted literal set (`"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`) on a 422 for an invalid value; `"none"` is the one M2 measured to actually drive the usage blob's `reasoningTokens` to 0 (the model otherwise spends its entire `sampling.maxTokens` completion budget on chain-of-thought before emitting any JSON - see docs/spikes/tier1-reliability.md section 1 for the before/after figures). When the model advertises `seed`, `--seed` is passed through; otherwise it is not.

Rate limiting is a token bucket per model seeded from `models.json` `per_request_limits` (600 RPM / 400k TPM for tier 1; 3,000 RPM / 1M TPM for tier 2); see "Rate limiting" below for the limiter design and retry behaviour.

**3. Parsing.** `llm/parser.ts` strips code fences, strips any `<think>...</think>` block and any `reasoning_content` field before scanning, then extracts the **last** balanced JSON object in the remaining text (a reasoning model that thinks out loud often emits a draft object before the real one) and validates against ajv. On failure it retries once at temperature 0; a second failure counts as a tier-1 failure and is an escalation trigger.

**4. Validation** (`validate/normalise.ts`, no model calls, in this order): normalise (uppercase, strip spaces, hyphens, apostrophes and punctuation, NFD-decompose and drop combining marks); reject any remaining non `A-Z`; length check against `slot.length`; pattern regex test; dedupe on the normalised string keeping the best score and summing votes; clue-echo rejection (normalised answer equals or is contained in the normalised clue), waived if the slot would otherwise be empty; drop anything in the slot's persistent rejection set. Every drop emits a `candidate:reject` event carrying a `RejectReason`.

**5. Calibration** (`score/calibrate.ts`). `rank` (v1 default): `score = 1 / (2 + rank)`. `votes`: `score = votes / samples`, rank as tie-break, requires `samples >= 3` at temperature 0.7. `blend`: `w1*voteFraction + w2*(1/(2+rank)) + w3*selfConfidence`, weights from `config/calibration.json` (v1 ships `[0.5, 0.4, 0.1]` as a placeholder; fitting is M6). `clue_understood` is never a score, only a routing signal.

**Cost.** Prices come from `models.json` at the repo root, loaded once by `llm/pricing.ts`, as USD-per-token decimal strings. The solver accumulates integer token counts per `(model, tier)` and never accumulates floating-point dollars; USD is computed once, at write time:

```ts
usd = Math.round(1e9 * (
  promptTokens * Number(p.prompt) +
  completionTokens * Number(p.completion) +
  calls * Number(p.request)
)) / 1e9;
```

Reasoning tokens are billed as completion tokens unless the provider is measured to do otherwise, and are logged separately either way so the assumption can be checked. A model id absent from `models.json` is a startup error, not a zero cost.

Two dollar figures are tracked, because they answer different questions. `usdBilled` is what actually left the account: zero for a cache hit. `usdCounterfactual` prices **every** call as if it were cold, reconstructing the tokens for a cache hit from the cached usage blob. All bench decision rules use `usdCounterfactual`, because otherwise the profile that happened to run second on a shared puzzle set wins on cost for no reason but ordering.

### Inference log (always on)

`llm/inferenceLog.ts` is wired into `llm/client.ts`, the transport layer, not into the solver. Every call is therefore captured whatever triggered it - seeding, re-asks, escalations, repair-pass scoring, the Nebius smoke test, and offline calibration fitting - and capture does not depend on the verbosity level or on which subcommand is running. Retries are logged as separate records distinguished by `attempt`.

Cache hits are logged too, as records with `cacheHit: true`, `request: null` and `rawResponse: null`, carrying the `cacheKey`, `purpose`, `slotId`, the cached `parsed` value and the cached `usage` (which is what makes `usdCounterfactual` computable). The log therefore shows the full sequence of what the solver asked, not only what reached the network.

Format: append-only JSONL, one `InferenceLogRecord` per line, at `logs/inference/<YYYY-MM-DD>.jsonl`. Daily files, size-unbounded in v1 (no rotation, no compaction). Writes are fire-and-forget appends through a single write stream per process; a write failure logs a warning once and never fails the run. Each record carries `runId`, so a run's calls can be pulled with `grep` or through `report --inference --run <runId>`.

Redaction: the API key never appears. Request headers are not logged at all, which is the simplest way to guarantee that; `responseHeaders` captures only the server's response headers, and the authorization header and any header containing the API key are never present there since they are sent, not received. No other redaction in v1 - clue text, prompts and raw responses are stored verbatim, since raw data first and metrics derived later is the point.

`solve` and `bench` take `--no-inference-log` for the rare case it is unwanted; the default is on.

### Rate limiting

Motivation: `nvidia/Nemotron-3_5-Lightning` is limited to 600 RPM (10 per second) and 400,000 TPM; `deepseek-ai/DeepSeek-V4-Pro` to 3,000 RPM and 1,000,000 TPM (from `models.json`). The seed pass on a 15x15 puzzle issues about 78 requests at once, so the limit is a burst problem confined to the first seconds of each puzzle; the search phase issues re-asks at a low rate. `models.json` reports `burst_ratio: 1.0`, suggesting no allowance above steady rate, but whether Nebius enforces a per-second bucket or a sliding per-minute window is unknown and must be determined empirically from logged headers. At around 400 tokens per call, 10 rps is about 240,000 TPM, under the 400,000 limit, so RPM is the binding constraint for tier 1.

**Client-side limiter as primary control.** One token bucket per model id, held in a process-wide singleton (a `RateLimiterRegistry` keyed by model), with `requestsPerSecond` defaulting to 90% of the catalogue RPM divided by 60, a `tokensPerMinute` bucket at 90% of catalogue TPM sized against the estimated prompt tokens plus `max_tokens`, and a per-model `maxConcurrency` (default 8 for tier 1, 16 for tier 2). All callers, including parallel puzzles in `bench`, share the registry.

The seed pass has **no concurrency cap of its own**. It fires every slot's request and lets the per-model rate limiter be the single gate, because two independent throttles in series only make the effective rate hard to reason about and hard to tune from the logged headers.

```ts
// llm/rateLimiter.ts
export interface RateLimiter {
  acquire(estimatedTokens: number): Promise<void>;
  observe(signal: RateLimitSignal): void;
  snapshot(): RateLimiterState;
}

export interface RateLimitSignal {
  status: number;
  retryAfterMs?: number;
  remainingRequests?: number;
  remainingTokens?: number;
  resetRequestsMs?: number;
  resetTokensMs?: number;
}

export interface RateLimiterState {
  model: string;
  rps: number;
  inFlight: number;
  queued: number;
  lastSignal?: RateLimitSignal;
}
```

**Server signals as corrective.** The client records every response header into the inference log record (`InferenceLogRecord.responseHeaders: Record<string, string>`); `authorization` and any header containing the API key are never present there, since those are request headers, not response headers - stated here explicitly. The client parses the OpenAI-compatible headers when present (`x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests`, `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-tokens`, `retry-after`), treating all of them as optional because Nebius support is unverified.

On HTTP 429: honour `retry-after` if present, else exponential backoff with full jitter starting at 500 ms, max 5 retries; and apply multiplicative decrease to the bucket rate (halve, floor at 1 rps) with additive recovery (+0.5 rps per 10 s without a 429) back to the configured ceiling. On 5xx: retry with the same backoff, no rate change. Emit a `rate:limited` solver event (level 1) and a `rate:adjusted` event (level 2) so the console shows when throttling happens.

The Guardian adapter's 1 rps ceiling is separate from this registry and is not adjustable by profile.

### Batching clues per request

Framing: batching is a latency and cost optimisation for the seed pass, not a quota fix, since the seed pass at 10 rps is already about 8 s. Risks: cross-clue contamination, length confusion, positional degradation for later clues in a batch, one malformed object spoiling the batch, and weaker JSON adherence because tier 1 has no structured-output mode.

Design constraints (mandatory):

- Each clue in a batched request carries an `id`, and the response is an array of objects each carrying that `id`; the parser realigns by id and never by position.
- The candidate cache stays per clue: each clue's result is stored under its own key, and `batchSize` is part of the cache key (see "Cache lookup" above), so batch-1 and batch-5 results never mix.
- Each element of the response is validated independently; a malformed or missing element costs only that clue, which is re-asked singly.
- The inference log record carries `batchSize` and `batchIndex` (the clue's position within the batch), and so does `RunRecord.perSlot`, so positional accuracy can be measured after the fact.
- **Batching applies only to `purpose: 'seed'` in v1.** Re-asks, escalations and repair calls are always single-clue. A batched re-ask would mix slots whose patterns are changing under each other mid-search, and the accounting is not worth the few seconds it would save.

Request and response schema for the batched form - the prompt carries an array of clues, and the response is an array of results keyed by the same ids:

```json
// prompt (batched)
{ "clues": [{ "id": "12A", "clue": "...", "length": 6, "pattern": "A??I?N", "style": "american" }] }

// response (batched)
{ "results": [{ "id": "12A", "clue_understood": 0.8, "candidates": [{ "answer": "ANIMAL", "confidence": 0.6 }] }] }
```

The single-clue form is the `batchSize: 1` case of the same schema, so there is one parser for both.

Profile field: `batchSize: number`, default 1, allowed range 1-8. The eval design for choosing a batch size is in "Strategy profiles" below, next to the escalation-policy bench.

## Solver pipeline

`solve(grid, domains, service, profile, emit)` implements the 8 steps from the algorithms doc. Event names in brackets are emitted at that exact point.

1. **Load.** Grid, slots and the empty `DomainStore` built; the solution is not passed in. `[run:start, grid:init, phase:start('seed')]`
2. **Seed.** For every slot, one tier-1 call with clue, length, style, empty pattern, `n = candidatesPerAsk`, `samples = profile.samples`, `purpose: 'seed'`. Requests are gated only by the per-model rate limiter. Base domains are the validated, calibrated candidate lists. A slot empty after validation goes onto the escalation queue immediately. `[slot:ask, slot:candidates, candidate:reject, phase:end('seed')]`
3. **Prepass (AC-3).** Worklist over crossing arcs; for arc `(s,t)`, drop any candidate of `s` with no candidate of `t` agreeing at the shared cell; requeue the other arcs of `s` on any reduction. On a wipeout: restore the domain, mark the slot suspect, and remove **every arc incident on that slot** from the worklist for the rest of the prepass, emitting `ac3:wipeout` once per slot. A wipeout here means a domain is missing its true answer, not that the puzzle is unsatisfiable, so a suspect slot must stop propagating its bad domain into its neighbours rather than being re-visited until it does. `[phase:start('prepass'), ac3:arc, ac3:reduce, ac3:wipeout, phase:end]`
4. **Search.** Depth-first with forward checking, over the trailed `DomainStore`. Variable ordering maximises `bestScore - secondBestScore` (Dr.Fill's margin), ties broken by fewest surviving candidates, then most unassigned crossings; `ordering: 'mrv'` swaps the primary key for domain size, for ablation. Values go in calibrated score order. On assignment, intersect each crossing domain with the new pattern regex, as a trailed reduction. Taking other than the first-ranked value increments the discrepancy count; exceeding `ldsLimit` abandons the branch, and when the tree is exhausted the search restarts at `ldsLimit + 1` up to `ldsLimitMax`. `[phase:start('search'), search:assign, search:unassign, search:forwardcheck, search:wipeout, search:backtrack, lds:restart, progress]`
5. **Re-ask (the sweep).** A domain that empties triggers a tier-1 re-ask (`purpose: 'reask'`, `promptKind: 'constrained'`) with the current pattern plus the rejected list, provided the pattern has at least one fixed letter, differs from the last pattern queried for that slot, and the slot is under `reasksPerSlot` (default 2). The result merges into the base domain and survives backtracking. `[slot:reask]`
6. **Escalate.** `policy/escalation.ts` exposes the pure `decide(ctx)` above, consulted after every `getCandidates` return and once at search termination for each still-empty slot. It owns all caps. `[slot:escalate, budget:hit]`
7. **Repair.** From the possibly partial fill, propose 1-2 letter edits where each changed letter appears in some candidate returned by `service.peek()` for any crossing slot, or the result is in the word list. Score each proposal by re-asking tier 1 for the affected slots with the new pattern (`purpose: 'repair'`); accept improving edits until none remain or `repair.maxCalls` is spent. Fill still-empty slots with the best word-list entry matching the pattern, or leave them blank when no word list is loaded. `[phase:start('repair'), repair:propose, repair:accept, repair:reject]`
8. **Score.** The orchestrator loads the solution and hands it to the injected scorer (`eval/scorer.ts`), which compares: letters correct over non-block cells, words correct over slots, perfect flag, empty cells. Always runs. `[phase:start('score'), score:final, cost:summary, grid:final, run:end]`

**Failure**, for escalation purposes, is: no parseable answer, zero candidates surviving validation, an answer of the wrong length, or a domain emptied by conflict with a crossing.

**Budget-cap behaviour.** `policy/budget.ts` resolves a `ResolvedBudget` from the profile and tracks USD, tokens, tier-2 calls, backtracks, repair calls and wall-clock against it. Hitting a cap emits `budget:hit` and ends the *current phase* gracefully - the search returns its best partial fill, repair stops proposing - and the pipeline proceeds to the next phase. It never throws and never skips step 8. A partial fill still produces a measurable accuracy number.

**Backtracking target.** When a slot cannot be filled after re-ask and escalation, undo the *lowest-margin* assignment among the slots crossing it; when the slot has no crossings, undo the lowest-margin assignment anywhere in the grid.

## Events and verbosity

`SolverEvent` is a discriminated union on `type` in `src/events/types.ts`. Every event carries `{ runId: string; seq: number; tMs: number }` plus its own fields. `src/events/levels.ts` exports `const MIN_LEVEL: Record<SolverEvent['type'], 0 | 1 | 2 | 3>`, and a renderer subscribing at level `L` sees events whose minimum level is at most `L`. The table below is that mapping; adding an event type without a level entry is a type error.

| Event | Level | Payload / what it shows |
| --- | --- | --- |
| `run:start` | 0 | puzzleId, profile name, models, seed |
| `grid:init` | 0 | `{ width, height, blocks: boolean[][], numbers: (number\|null)[][], slots: [{ id, row, col, length, direction, clue }] }` |
| `phase:start` / `phase:end` | 0 | phase name, durationMs on end |
| `progress` | 0 | assigned / total slots, elapsed, usd so far |
| `grid:final` | 0 | final letters |
| `score:final` | 0 | letters, words, perfect, emptyCells |
| `cost:summary` | 0 | calls, usdBilled and usdCounterfactual per tier |
| `budget:hit` | 0 | which cap, limit, actual |
| `run:end` | 0 | exit status, wallMs |
| `slot:ask` | 1 | slotId, clue, length, pattern, tier, purpose, promptKind, batchIndex |
| `slot:candidates` | 1 | slotId, accepted list of `{answer, score}` |
| `search:assign` | 1 | slotId, answer, score, margin, `tier: 1 \| 2 \| 'wordlist'`, producedBy |
| `slot:reask` | 1 | slotId, pattern, attempt number |
| `slot:escalate` | 1 | slotId, trigger, reason, tier-2 calls used |
| `repair:accept` | 1 | slotId, before, after, edit distance, `tier: 1 \| 2 \| 'wordlist'`, producedBy |
| `pattern:built` | 2 | slotId, pattern, regex source |
| `candidate:reject` | 2 | slotId, answer, reason |
| `domain:filtered` | 2 | slotId, surviving list after filtering |
| `search:forwardcheck` | 2 | slotId, crossing slot, survivors before and after |
| `search:wipeout` | 2 | slotId whose domain emptied |
| `search:unassign` | 2 | slotId, answer removed |
| `search:backtrack` | 2 | undone slotId, its margin, why it was chosen |
| `ac3:reduce` | 2 | arc, removed candidates |
| `ac3:wipeout` | 2 | slotId marked suspect (once per slot) |
| `lds:restart` | 2 | new discrepancy limit, discrepancies used |
| `repair:propose` / `repair:reject` | 2 | proposal, and the gate it passed or failed |
| `llm:request` | 3 | model, full prompt text |
| `llm:response` | 3 | raw response body |
| `cache:lookup` | 3 | key, hit or miss |
| `llm:usage` | 3 | TokenUsage, usdBilled, usdCounterfactual, latencyMs |
| `ac3:arc` | 3 | each arc visited |
| `phase:timing` | 3 | fine-grained timings within a phase |

`grid:init` exists so a renderer, a replay or an offline analysis tool can draw the grid without loading the puzzle file. `tier` and `producedBy` on `search:assign` and `repair:accept` are what let `WatchRenderer` colour a cell by its source and let `report --by tier` be derived from the event stream alone.

`progress` is emitted on every phase transition and otherwise at most once every 250 ms, coalesced - a search that backtracks thousands of times must not turn the event stream into a progress-bar firehose.

The level-3 `llm:*` events are for live reading. They are not the durable record - the inference log is, and it is written whatever the level.

## Renderers

All subscribe to the same `EventBus` (`on(handler)`, `emit(event)`, synchronous, ordered).

- **`ConsoleRenderer(level: 0|1|2|3, stream)`** - one line per accepted event, prefixed with elapsed ms and slot id. Level 0 additionally prints the final grid, the diff against the solution (wrong letters in red, empty cells as `.`), and the score and cost block.
- **`WatchRenderer()`** - `log-update` full-frame redraw on `search:assign`, `search:unassign`, `repair:accept` and `progress`. Cells are coloured by producing tier (tier 1 cyan, tier 2 magenta, word-list fallback grey) and confidence band (bold at 0.5 and above, normal at 0.25 and above, dim below). A status line shows phase, assigned/total, backtracks and usd. On `score:final` it overlays the diff.
- **`RunRecorder()`** - accumulates the `RunRecord`, writes it to `--out` (default `runs/<runId>.json`) on `run:end`, then updates `puzzles/index.json` through the locked writer.
- **`JsonlEventSink(path)`** - appends every event as one JSON line to `runs/<runId>.events.jsonl`. Attached automatically at `-vvv` or with `--trace`.
- **`replay(path, renderer)`** in `src/render/replay.ts` - reads a `.events.jsonl` back through any renderer, so a `--watch` playback of an old run costs nothing.

`--watch` is honoured only when `process.stdout.isTTY && !process.env.CI && process.env.TERM !== 'dumb'`. Otherwise the flag prints one explanatory line to stderr and falls back to `ConsoleRenderer(0)`, which is what keeps a `--watch` left in a CI script from producing megabytes of escape codes. `NO_COLOR` and `--no-color` are respected, and a terminal width of 80 columns is assumed when `process.stdout.columns` is undefined.

## Strategy profiles

A profile is JSON (or a TS module exporting the same object) validated by `src/profiles/schema.ts`:

```ts
export const ProfileSchema = z.object({
  name: z.string(),
  tier1: z.string().default('nvidia/Nemotron-3_5-Lightning'),
  tier2: z.string().default('deepseek-ai/DeepSeek-V4-Pro'),
  candidatesPerAsk: z.number().int().min(1).max(25).default(10),
  calibration: z.enum(['rank', 'votes', 'blend']).default('rank'),
  samples: z.number().int().min(1).max(5).default(1),
  batchSize: z.number().int().min(1).max(8).default(1),
  reasksPerSlot: z.number().int().min(0).default(2),
  sampling: z.object({
    temperature: z.number().min(0).max(2).default(0.2),
    topP: z.number().min(0).max(1).optional(),
    maxTokens: z.number().int().min(64).max(4096).default(512),
  }).default({}),
  escalation: z.object({
    policy: z.enum(['reask-first', 'eager', 'patient']).default('reask-first'),
    clueUnderstoodThreshold: z.number().default(0.4),
    maxTier2CallsPerPuzzle: z.number().int().default(15),
    escalationsPerSlot: z.number().int().default(1),
  }).default({}),
  search: z.object({
    ordering: z.enum(['margin', 'mrv']).default('margin'),
    ldsLimitStart: z.number().int().default(0),
    ldsLimitMax: z.number().int().default(3),
    maxBacktracks: z.number().int().default(200),
  }).default({}),
  repair: z.object({
    enabled: z.boolean().default(true),
    maxCalls: z.number().int().default(30),
    maxEditDistance: z.number().int().min(1).max(2).default(2),
  }).default({}),
  budget: z.object({
    usd: z.number().default(0.5),
    tokens: z.number().int().default(2_000_000),
    wallMs: z.number().default(900_000),
  }).default({}),
  rateLimit: z.object({
    rpsFraction: z.number().default(0.9),
    maxConcurrencyTier1: z.number().int().default(8),
    maxConcurrencyTier2: z.number().int().default(16),
  }).default({}),
  promptVersion: z.string().default('v1'),
}).refine(
  (p) => p.calibration !== 'votes' || (p.samples >= 3 && p.sampling.temperature === 0.7),
  { message: "calibration 'votes' requires samples >= 3 and sampling.temperature 0.7" },
);
export type Profile = z.infer<typeof ProfileSchema>;
```

**Profile resolution**, lowest precedence to highest: zod defaults < named built-in < profile file (a full profile, or one with `"extends": "<builtin>"`) < values from the config file passed to `--config` < explicit CLI flags. The fully resolved profile is what gets stored in the run record, so a run is never ambiguous about what it actually ran.

**Config file** resolution, highest first: `--config <path>` > `$CROSSWORD_CONFIG` > `./crossword.config.json` > absent. Its schema is `{ defaultProfile?, cacheDir?, runsDir?, puzzlesDir?, inferenceLogDir?, wordlistPath?, nebiusBaseUrl? }`. No secrets live in the config file - the API key comes from the environment only - and the file is never read from `$HOME`, so a run inside the container and a run on a colleague's machine resolve the same way.

Built-ins live in `src/profiles/builtins.ts` as complete literal objects typechecked against `Profile`, not as prose descriptions of deltas. Every field is written out, so reading a profile never requires mentally applying a diff to `baseline`:

```ts
// src/profiles/builtins.ts
export const baseline: Profile = {
  name: 'baseline',
  tier1: 'nvidia/Nemotron-3_5-Lightning',
  tier2: 'deepseek-ai/DeepSeek-V4-Pro',
  candidatesPerAsk: 10,
  calibration: 'rank',
  samples: 1,
  batchSize: 1,
  reasksPerSlot: 2,
  sampling: { temperature: 0.2, maxTokens: 512 },
  escalation: { policy: 'reask-first', clueUnderstoodThreshold: 0.4, maxTier2CallsPerPuzzle: 15, escalationsPerSlot: 1 },
  search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
  repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
  budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
  rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
  promptVersion: 'v1',
};

export const eagerEscalation: Profile = {
  name: 'eager-escalation',
  tier1: 'nvidia/Nemotron-3_5-Lightning',
  tier2: 'deepseek-ai/DeepSeek-V4-Pro',
  candidatesPerAsk: 10,
  calibration: 'rank',
  samples: 1,
  batchSize: 1,
  reasksPerSlot: 0,
  sampling: { temperature: 0.2, maxTokens: 512 },
  escalation: { policy: 'eager', clueUnderstoodThreshold: 0.4, maxTier2CallsPerPuzzle: 15, escalationsPerSlot: 1 },
  search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
  repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
  budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
  rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
  promptVersion: 'v1',
};

export const patient: Profile = {
  name: 'patient',
  tier1: 'nvidia/Nemotron-3_5-Lightning',
  tier2: 'deepseek-ai/DeepSeek-V4-Pro',
  candidatesPerAsk: 10,
  calibration: 'rank',
  samples: 1,
  batchSize: 1,
  reasksPerSlot: 3,
  sampling: { temperature: 0.2, maxTokens: 512 },
  escalation: { policy: 'patient', clueUnderstoodThreshold: 0.4, maxTier2CallsPerPuzzle: 15, escalationsPerSlot: 1 },
  search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 500 },
  repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
  budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
  rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
  promptVersion: 'v1',
};

export const noRepair: Profile = {
  name: 'no-repair',
  tier1: 'nvidia/Nemotron-3_5-Lightning',
  tier2: 'deepseek-ai/DeepSeek-V4-Pro',
  candidatesPerAsk: 10,
  calibration: 'rank',
  samples: 1,
  batchSize: 1,
  reasksPerSlot: 2,
  sampling: { temperature: 0.2, maxTokens: 512 },
  escalation: { policy: 'reask-first', clueUnderstoodThreshold: 0.4, maxTier2CallsPerPuzzle: 15, escalationsPerSlot: 1 },
  search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
  repair: { enabled: false, maxCalls: 30, maxEditDistance: 2 },
  budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
  rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
  promptVersion: 'v1',
};

export const tier1Only: Profile = {
  name: 'tier1-only',
  tier1: 'nvidia/Nemotron-3_5-Lightning',
  tier2: 'deepseek-ai/DeepSeek-V4-Pro',
  candidatesPerAsk: 10,
  calibration: 'rank',
  samples: 1,
  batchSize: 1,
  reasksPerSlot: 2,
  sampling: { temperature: 0.2, maxTokens: 512 },
  escalation: { policy: 'reask-first', clueUnderstoodThreshold: 0.4, maxTier2CallsPerPuzzle: 0, escalationsPerSlot: 0 },
  search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
  repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
  budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
  rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
  promptVersion: 'v1',
};

export const strongOnly: Profile = {
  name: 'strong-only',
  tier1: 'deepseek-ai/DeepSeek-V4-Pro',
  tier2: 'deepseek-ai/DeepSeek-V4-Pro',
  candidatesPerAsk: 10,
  calibration: 'rank',
  samples: 1,
  batchSize: 1,
  reasksPerSlot: 2,
  sampling: { temperature: 0.2, maxTokens: 512 },
  escalation: { policy: 'reask-first', clueUnderstoodThreshold: 0.4, maxTier2CallsPerPuzzle: 15, escalationsPerSlot: 1 },
  search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
  repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
  budget: { usd: 2.0, tokens: 2_000_000, wallMs: 900_000 },
  rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 16, maxConcurrencyTier2: 16 },
  promptVersion: 'v1',
};

export const votes3: Profile = {
  name: 'votes3',
  tier1: 'nvidia/Nemotron-3_5-Lightning',
  tier2: 'deepseek-ai/DeepSeek-V4-Pro',
  candidatesPerAsk: 10,
  calibration: 'votes',
  samples: 3,
  batchSize: 1,
  reasksPerSlot: 2,
  sampling: { temperature: 0.7, maxTokens: 512 },
  escalation: { policy: 'reask-first', clueUnderstoodThreshold: 0.4, maxTier2CallsPerPuzzle: 15, escalationsPerSlot: 1 },
  search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
  repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
  budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
  rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
  promptVersion: 'v1',
};

// batch1 is baseline under another name, so the batch bench reads as one family.
const batchProfile = (n: 1 | 2 | 3 | 5 | 8): Profile => ({
  name: `batch${n}`,
  tier1: 'nvidia/Nemotron-3_5-Lightning',
  tier2: 'deepseek-ai/DeepSeek-V4-Pro',
  candidatesPerAsk: 10,
  calibration: 'rank',
  samples: 1,
  batchSize: n,
  reasksPerSlot: 2,
  sampling: { temperature: 0.2, maxTokens: 512 },
  escalation: { policy: 'reask-first', clueUnderstoodThreshold: 0.4, maxTier2CallsPerPuzzle: 15, escalationsPerSlot: 1 },
  search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
  repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
  budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
  rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
  promptVersion: 'v1',
});

export const batch1 = batchProfile(1);
export const batch2 = batchProfile(2);
export const batch3 = batchProfile(3);
export const batch5 = batchProfile(5);
export const batch8 = batchProfile(8);

export const builtins: Record<string, Profile> = {
  baseline, 'eager-escalation': eagerEscalation, patient, 'no-repair': noRepair,
  'tier1-only': tier1Only, 'strong-only': strongOnly, votes3,
  batch1, batch2, batch3, batch5, batch8,
};
```

`batchProfile` is a typed factory over a single varying field, not an inheritance mechanism; every profile it returns is still a complete literal, and a unit test parses every entry in `builtins` through `ProfileSchema` so a drifted default is a test failure rather than a surprise at run time.

**Why experiments are cheap.** The cache key contains every prompt-visible field and no policy fields (see "Cache lookup"), so two profiles differing only in search or escalation policy share every cached query. A second profile over a puzzle set already run pays only for the `(clue, pattern, batchSize)` combinations no previous run asked for - typically the re-asks that a different policy generates. `--offline` forbids the network entirely and fails any run needing an uncached query, which is what makes the integration tests deterministic.

**Repeats.** `--repeat N` runs the matrix N times, and repeat index `r` feeds `sampleIndex`, so each repeat is a genuinely fresh sample rather than N reads of the same cache entry. Default bench recipes use `--repeat 1`; `report` reports the sample standard deviation across puzzles, and when repeat > 1 it reports within-puzzle and across-puzzle variance separately, since they answer different questions (model nondeterminism versus puzzle difficulty spread).

**The open question: escalate sooner, or exhaust permutations first?** Run

```
xw bench sets/mixed-30.json --profiles baseline,eager-escalation,patient
xw report --by profile --compare baseline,eager-escalation,patient --md
xw report --by stratum --compare baseline,eager-escalation,patient --md
```

over 30 puzzles (20 American from the xd slice, 10 Guardian cryptic), then compare perfect-puzzle rate, mean USD per puzzle and USD per correct word, all on `usdCounterfactual`. **Decision rule:** on the **american stratum only**, pick the profile with the highest perfect-puzzle rate, unless its USD per correct word exceeds the best other profile's by more than a factor of 1.5, in which case pick that other profile. Report the letter-accuracy delta and the cryptic stratum alongside, but do not decide on either - letter accuracy saturates and hides exactly the tail this question is about, and the cryptic stratum is measuring an acknowledged prompting gap rather than the policy.

**The batch-size question: does batching clues degrade accuracy, and where is the crossover?** Run

```
xw bench sets/mixed-30.json --profiles batch1,batch2,batch3,batch5,batch8
xw report --by batchIndex --compare batch1,batch2,batch3,batch5,batch8 --md
```

over the same 30-puzzle set. Metrics per clue, all derived from `RunRecord.perSlot`: truth-in-top-k recall (`truthInCandidates`, `k = candidatesPerAsk`), top-1 accuracy (`truthRank === 0`), length-error rate and parse-failure rate (`rejectCounts`, `parseFailures`), latency per clue, USD per clue, and accuracy by `batchIndex` to detect positional drop-off; then downstream letter, word and perfect-puzzle accuracy. **Decision rule:** on the **american stratum only**, pick the largest batch size whose top-k recall is within 2 percentage points of `batch1` and whose positional accuracy shows no monotonic decline across positions; otherwise stay at 1.

Both benches are run again in M6 with the repair pass enabled, because a policy that looks worse before repair may be the one repair rescues best.

## Metrics and run records

`runs/<runId>.json`, validated by `schemas/run-record.schema.json`. The run id is

```
${puzzleId}--${profileName}--${YYYYMMDD}T${HHmmss}Z--${shortHash}
```

with `shortHash` the first 8 hex characters of `sha1(canonicalJson(profile) + gitCommit + repeatIndex)`, and `puzzleId` and `profileName` constrained to `[A-Za-z0-9._-]+`. The double-dash separator survives ids that contain single dashes, which every Guardian id does.

```ts
export interface RunRecord {
  runId: string;
  timestamp: string;             // ISO 8601
  status: 'ok' | 'partial' | 'error';
  error?: string;                // present when status is 'error'
  puzzle: { id: string; source: string; style: PuzzleStyle; stratum: Stratum; size: string; slots: number };
  profile: Profile;              // the fully resolved profile, exactly as the run used it
  provenance: {
    gitCommit: string;           // "unknown" rather than a failed run
    nodeVersion: string;
    packageVersion: string;
    profileSource: 'builtin' | 'file' | string;   // 'builtin', or the profile file path
  };
  repeatIndex: number;
  seed: number | null;
  models: { tier1: string; tier2: string };
  accuracy: { letters: number; words: number; perfect: boolean; emptyCells: number };
  perSlot: Array<{
    slotId: string; clue: string; length: number;
    truth: string; filled: string | null; correct: boolean;
    producedBy: 1 | 2 | 'wordlist' | null;
    batchIndex: number | null;
    truthInCandidates: boolean;
    truthRank: number | null;
    rejectCounts: Record<RejectReason, number>;
    parseFailures: number;
    latencyMs: number;
    usd: number;
    reasks: number; escalated: boolean; candidatesSeen: number; pickedRank: number | null;
  }>;
  calls: Record<'tier1' | 'tier2', {
    count: number;
    promptTokens: number; completionTokens: number; reasoningTokens: number;
    usdBilled: number; usdCounterfactual: number;
    cacheHits: number; avgLatencyMs: number;
  }>;
  search: { backtracks: number; discrepancies: number; wipeouts: number; ac3Reductions: number };
  repair: { proposals: number; accepted: number };
  wallMs: number;
  budgetHits: Array<{ cap: string; limit: number; actual: number; atMs: number }>;
}
```

`profile` is the resolved `Profile` and nothing else; `promptVersion` lives inside it and `gitCommit` moved to `provenance`, so the profile object in a run record round-trips through `ProfileSchema` unchanged and can be fed straight back to `solve --profile <file>`. There is no `gitDirty` flag in v1 - it is easy to get wrong inside a bind-mounted container and nothing depends on it yet.

`provenance.gitCommit` is read without a git binary, because the container does not have one: read `.git/HEAD`, follow the ref (falling back to `.git/packed-refs`), else use `$GIT_COMMIT`, else record `"unknown"`. Provenance never fails a run.

`accuracy.letters` and `accuracy.words` are fractions in [0,1]. Cache hits contribute zero tokens to `usdBilled` and are counted in `cacheHits`, while `usdCounterfactual` prices them as if cold. Every number here is derivable from the inference log plus the event stream, which is the point of keeping both.

`status` is `ok` for a completed run, `partial` when a budget cap ended a phase early but scoring still ran, and `error` when the run aborted (an offline cache miss under `--offline`, or a provider failure after retries); `error` carries the message.

`report` aggregates a glob of run records (`eval/aggregate.ts`) and emits, per group: mean and sample standard deviation of letter accuracy, word accuracy and perfect rate; mean USD per puzzle; USD per correct word (`sum(usdCounterfactual) / sum(correct words)`); tier-2 share of calls (`tier2.count / (tier1.count + tier2.count)`); mean wallMs; and budget-hit counts by cap. It also emits a per-slot difficulty view: clues keyed by `(puzzleId, slotId)` with the number of profiles that got them wrong, worst first, which is the fastest way to find prompt bugs. `--compare a,b` prints a paired table with deltas. `--by tier` groups by producing tier, `--by stratum` groups by the puzzle's stratum (american versus cryptic), and `--by batchIndex` groups by the clue's position within its batch, to check for positional drop-off in the batch-size bench.

## CLI reference

All commands run inside the long-running container, either as `docker exec -it crossword-solver xw <subcommand> ...` or through the `./xw` wrapper. `crossword` is declared as an alias bin in `package.json`, so `crossword <subcommand>` remains a working synonym for anyone with the old name in muscle memory; the documented name is `xw`. Worked examples:

```
docker exec -it crossword-solver xw fetch guardian --series cryptic --limit 10
docker exec -it crossword-solver xw solve guardian-cryptic-30085 --profile baseline -vv --watch
docker exec -it crossword-solver xw bench sets/mixed-30.json --profiles baseline,patient
```

Global options: `--config <path>`, `--cache-dir <path>`, `--no-color`, and `--json` where a command supports it. `--config` selects the config file described under "Strategy profiles"; `--cache-dir` overrides `$CROSSWORD_CACHE_DIR` and the `./cache/candidates` default, and is what lets an integration test point at `test/fixtures/cache/` without touching the developer's working cache.

Exit codes are defined once, in `src/cli/exit.ts`, alongside a typed `CliError { code: number; message: string; hint?: string }`. There is exactly one top-level catch, which prints `message` (and `hint` if present) to stderr and exits with `code`; nothing else in the codebase calls `process.exit`.

| Code | Name | Class | When |
| --- | --- | --- | --- |
| 0 | `OK` | success | Command completed, including a partial fill. |
| 1 | - | unexpected | An error that is not a `CliError`; a stack trace is printed. This is a bug. |
| 2 | `USAGE` | usage | Bad flags, unknown profile, invalid profile or config file, `--limit` over the source's cap. |
| 3 | `NOT_FOUND` | data | Puzzle, run record, puzzle set or fixture not found; parse failure; clue-numbering mismatch. |
| 4 | `OFFLINE_MISS` | data | `--offline` and the cache lacks the query. Message names the cache key and the clue. |
| 5 | `PROVIDER` | provider | Transport failure after retries, or a provider error the retry policy does not cover. |
| 6 | `BENCH_PARTIAL` | aggregate | `bench` finished (or aborted on `--max-usd`) with at least one run errored. |

Precedence inside `bench` is explicit, because a matrix has many places to fail: a usage error (exit 2) is raised **before any run starts**, so a typo in `--profiles` never costs money; a per-run exit 4 or 5 marks that run's record `status: 'error'` with the message in `error` and the matrix continues; and `bench` exits 6 if any run errored. A `--max-usd` abort also exits 6.

**`xw fetch <source>`** `--series <s>` `--date <YYYY-MM-DD>` `--from <d>` `--to <d>` `--limit <n>` (default 1) `--out <dir>` (default `puzzles/`) `--path <dir|zip>` (xd adapter). Downloads, normalises, writes both files, upserts the index. Prints one line per puzzle: `fetched guardian-cryptic-30085  15x15  cryptic  32 slots`. Exit 3 if the source returns nothing. For the `guardian` source, `--limit` has a hard maximum of 20 and a value above that is a usage error (exit 2); requests are additionally spaced at one per second.

**`xw list`** `--source <id>` `--style <s>` `--solved` (only puzzles with a run at 100% letters) `--json`. Table columns: id, source, date, size, style, slots, best letters, last run; null metrics render as `-` rather than `null` or a blank. On an empty index it prints `no puzzles yet - try: xw fetch xd --limit 5` and exits 0 - an empty library is a state, not an error - while `--json` prints `[]` and exits 0.

**`xw show <id>`** `--solution` `--run [runId]`. Prints the numbered grid (blocks as `#`, letters as `.` unless `--solution` or `--run`) and the across and down clue lists. `--run` renders the grid a past `solve` run produced instead of the true solution, using the same renderer and clue lists as `--solution`, preceded by one header line naming the run id, its timestamp, its profile and its accuracy. Omitting the run id (`--run` with no value) uses the most recent run recorded for this puzzle; giving one selects by full run id or a unique prefix. `--run` and `--solution` together is a usage error (exit 2).

**`xw solve <id|path>`** `--profile <name|path>` (default `baseline`) `--tier1 <model>` `--tier2 <model>` `-v|-vv|-vvv` `--watch` `--offline` `--offline-lenient` `--budget-usd <n>` `--seed <n>` `--trace` `--no-inference-log` `--out <run.json>`. Prints the final grid, the diff against the solution with wrong letters marked, the accuracy block and the cost block; writes the run record. Exit 0 even on a partial fill.

`--offline` forbids the network and makes a cache miss fatal (exit 4). `--offline-lenient` implies `--offline` but degrades gracefully instead: the miss ends the current phase, the run continues to scoring, and the record is written with `status: 'partial'`.

`--seed <n>` seeds only a local PRNG used for tie-breaks and backoff jitter, and is passed to the provider only when `models.json` advertises a `seed` capability for that model. It is recorded in the run record. Replay determinism comes from the cache, not from the seed, and the spec does not pretend otherwise.

**`xw bench <puzzle-set>`** `--profiles a,b,c` (required) `--repeat <n>` (default 1) `--offline` `--offline-lenient` `--concurrency <n>` (default 2) `--max-usd <n>` (default 25) `--yes` `--no-inference-log` `--out <dir>` (default `runs/`). `<puzzle-set>` is a JSON file `{ name, puzzles: [{ id, stratum }] }` under `sets/`, or a glob. One run record per `(puzzle, profile, repeat)`; repeat index `r` feeds `sampleIndex`.

Before any run, `bench` prints an estimate: puzzles x profiles x repeats, and the projected total `usdCounterfactual` from prior runs of the same profiles where available, or a static per-puzzle estimate where not. If the estimate exceeds `--max-usd`, the command refuses to start unless `--yes` is given. During the matrix, cumulative `usdBilled` is checked against `--max-usd` after every run; exceeding it aborts the remaining matrix, writes what has been run, and exits 6. Then it prints a progress line per run and a summary table at the end: profile, stratum, n, letters, words, perfect, usd per puzzle, usd per correct word.

**`xw report`** `--runs <glob>` (default `runs/*.json`) `--compare a,b` `--by profile|puzzle|tier|stratum|batchIndex` (default `profile`) `--json|--md`. Prints the aggregates above. `--md` output for each documented bench is committed under `docs/benches/`.

**`xw report --inference`** reads `logs/inference/*.jsonl` instead of run records and answers the basic operational questions: calls per model per day, USD per day (billed and counterfactual), parse-failure rate per model (`parseError != null` over total non-cache-hit calls), cache-hit rate, and the 20 slowest calls by `latencyMs`. Additional filters: `--since <date>` `--until <date>` `--model <id>` `--run <runId>` `--slot <slotId>` `--dump` (print full matching records as JSON, for feeding a parser fixture or debugging a single clue).

**`xw cache stats|clear|export <file>|import <file>`** - `stats` prints entry count, disk bytes, last-run hit rate, and a breakdown by model and promptVersion, and warns when the directory exceeds 1 GB; `clear` takes `--model` and `--prompt-version` filters; `export` and `import` move a tarball of the resolved cache directory, which is how the committed test cache is produced.

## Testing

**Fixtures.** No real puzzle is committed to this repository in any form (see the decisions log's "Fixtures" and "What is committed" rows and the 2026-09-04 addendum in `docs/decisions/2026-09-03-spec-review.md`). `test/fixtures/puzzles/` holds two hand-authored synthetic grids with no licence risk at all: a 5x5 containing an unchecked cell and a 2-letter entry, and a 7x7 containing an accented answer and a multi-word enumeration. These are both the **primary unit-test fixtures** and the only integration-test fixtures, because the awkward cases the grid model must handle are far easier to author deliberately than to find in a corpus, and because owning zero real puzzles means owning zero licence risk.

**Unit tests** (no network, no filesystem beyond fixtures): grid model (slot extraction, crossing index, unchecked cells, exactness of the assign/unassign trail, `isComplete`); `DomainStore` trail semantics, including that a merged re-ask result survives a `pop()` and that a trailed reduction does not; loader normalisation across all four formats plus the Guardian JSON adapter; recomputed clue numbering, including the mismatch error; `patternFor` and the regex builder; the validation chain including every `RejectReason`; AC-3 including the wipeout-restore path and the arc-removal rule; margin ordering and its tie-breaks; LDS discrepancy counting and restart; repair proposal gating with and without a word list; `decide()` as a table of contexts to decisions; the scorer; the canonical-JSON cache key; and USD calculation from `models.json` against hand-computed values.

**Loader post-condition test**, run over every format and every fixture: no `Slot.clue` contains any slot's solution as a substring. This is the test that catches a loader leaking answers into clue text, which would silently inflate every accuracy number in the project. The `.xd` loader strips everything from ` ~ ` onward in a clue line, which is where the xd format puts the answer.

**Integration tests:** run `solve` end to end with `--offline` (or, where a fixture cannot replay strict `--offline`, `--offline-lenient`; `test/fixtures/runs/bounds.json` records which per fixture) against each of the two synthetic fixtures under `test/fixtures/puzzles/`, backed by the committed cache at `test/fixtures/cache/` and the committed word-list subset. Each asserts two things: an accuracy **bound** (for example `letters >= 0.92`), which states the property that must hold, and a regenerable **exact snapshot**, which makes any behaviour change show up as a diff. They cover the baseline profile on the two synthetic fixtures.

`npm run fixtures:refresh` regenerates the committed cache and the snapshots together, so the two can never drift apart. A `promptVersion` bump invalidates every cached entry and is therefore a single-owner action: it lands with the regenerated cache in one commit, never as a code-only change that leaves the fixtures stale.

**Contract tests:** `llm/parser.ts` against recorded raw responses in `test/fixtures/responses/`, including fenced JSON, a leading prose paragraph, trailing commentary, a `<think>` block wrapping a draft object before the real one, a truncated object, a wrong-typed `confidence`, and answers containing spaces and accents. These fixtures are harvested from the inference log - `report --inference --dump` filtered to records with a non-null `parseError` is the intended source of new malformed-response cases, so every parser bug seen in the wild becomes a regression test. A second contract test asserts the cache-key invariant: mutating any prompt-visible field changes the key, and mutating any policy field does not.

**Build smoke test:** one test runs `node dist/cli/index.js --version` in a subprocess, so `dist/` is exercised by the suite rather than only by CI. The dev loop runs from `tsx` and would otherwise never notice a build that has been broken for weeks.

**Nebius smoke test:** one real clue against Nebius on tier 1, `describe.skipIf(!process.env.NEBIUS_API_KEY)`.

Coverage target: 80% lines and 75% branches overall, 95% lines for `src/grid/`, `src/validate/` and `src/eval/scorer.ts`.

**CI** is a single GitHub Actions workflow with two jobs, running on push and pull request with no `NEBIUS_API_KEY` in the environment so the Nebius smoke test is skipped:

1. **checks** - `actions/setup-node` at Node 22, `npm ci`, then `npm run lint`, `npm run typecheck` and `npm test -- --coverage`. This runs on the runner directly, not through Docker, because a container build on every push buys nothing and costs minutes.
2. **image** - `docker compose build` only, to prove the image still builds. It does not run the suite a second time.

**Spec touch-ups recorded.** Implementation surfaced a few places where this document does not match the shipped contracts; recorded here rather than silently rewritten elsewhere in this file (see `docs/build-notes/` for the full account from the task that found each one): the rate-limiter events named earlier in this spec as `rate.limited` and `rate.adjusted` are actually emitted as `rate:limited` and `rate:adjusted` (colon, not dot); `ProfileSchema` (`src/profiles/schema.ts`) uses zod's `.prefault({})` rather than `.default({})` for nested option groups, because under zod 4 a `.default()` must be the fully-populated output object while `.prefault()` feeds `{}` through the group's own field defaults; `SolveDeps`/`SolveResult` (`src/solver/types.ts`) were widened with additional optional fields (`puzzle`, `now`, `costs` on the former; `error`, `errorCause` on the latter) during solve orchestration, all additive so the frozen `SolveFn` shape still holds; `npm run typecheck` runs `tsc --noEmit -p tsconfig.check.json`, a superset of `tsconfig.json` covering `test/`, `scripts/` and the tool configs, not a bare `tsc --noEmit` against `tsconfig.json` alone; and the scorer (`src/eval/scorer.ts`) takes the solution as a `score()` argument, per its task's binding Deliverable, rather than loading it itself via `loadPuzzleWithSolution` as the "Solver pipeline" section above still says.

## Milestones

- **M0 - contracts.** A single owner lands every shared type and interface with no implementations behind them, so the parallel workstreams below compile against a fixed shape from day one: puzzle types (`Puzzle`, `PuzzleWithSolution`, `Slot`, `Cell`); `Grid` and `DomainStore` interfaces; the `SolverEvent` union and the `MIN_LEVEL` map; candidate service types and interface; `LlmTransport` and `TokenUsage`; `SourceAdapter`, `PuzzleRef` and the normalise hook; `ProfileSchema`; the JSON schemas (candidate-response, run-record, puzzle-index, puzzle); the CLI commander tree with every subcommand, option and help string declared and every handler stubbed; exit codes; `util/hash` (`canonicalJson`, `cacheKey`); `util/fs` (repo root, atomic write, resolved paths); `InferenceLogRecord` and the `InferenceLog` interface; `EscalationContext` and `EscalationDecision`; `ResolvedBudget`; and the `WordList` interface. Nothing here calls a network or reads a puzzle.
- **M1** - grid model and `DomainStore`, puzzle loader for all four formats plus the Guardian JSON adapter, source adapters, `fetch`, `list`, `show`, the puzzle index with its locked writer, and the committed synthetic fixtures.
- **M2** - `CandidateService`: prompts, Nebius client behind `LlmTransport`, per-model rate limiter with AIMD backoff, inference log, capability-driven tier router, parser, validation chain, cache with negatives, `cache` subcommand, rank calibration, batching support behind the `batchSize` profile field (default 1). The reasoning-off parameter for Nemotron is discovered here and recorded in this spec.
- **M3** - event bus and taxonomy, AC-3 prepass, search with margin ordering and LDS, re-ask, escalation policy, budgets, `solve` with `-v/-vv/-vvv`.
- **M4** - `WatchRenderer`, `JsonlEventSink`, replay.
- **M5** - repair pass and word list; `RunRecorder` and run-record schema, `bench` with its cost ceiling, `report` and its aggregates, `report --inference`; then the batch-size bench. **This completes v1.**
- **M6 (v1.1)** - `votes` and `blend` calibration with offline weight fitting against the fixture solutions, then the escalation-policy bench and the batch-size bench re-run with the repair pass on, and their decisions recorded.

Repair moved into M5 because the Berkeley ablation puts most of the perfect-puzzle headroom in the repair pass: shipping v1 without it would ship a solver measured well below what the architecture can do, and every bench run before it would have to be repeated anyway.

## Decisions log

| Decision | Choice | Reason |
| --- | --- | --- |
| Language | TypeScript, strict, ESM | Index-heavy grid code; `strict` plus `noUncheckedIndexedAccess` catches the class of bug this project is most exposed to. |
| Package manager | npm | Ships with Node 22; no extra layer in the image; single package, no workspaces. |
| CLI name | `xw`, with `crossword` as an alias bin; wrapper `./xw`; container still `crossword-solver` | The command is typed dozens of times an hour and the docs are full of examples; two characters beats nine. The alias means no muscle memory is broken and no script silently stops working. |
| Logger | minimal custom leveled logger | Leveled output is the event stream's job; `pino` would be a second competing output path for a handful of bootstrap lines. |
| Schema library | ajv for wire formats, zod for profiles | DeepSeek structured outputs need JSON Schema, so ajv is required anyway; profiles are internal, and `z.infer` avoids a duplicate hand-written type. |
| Solution handling | two types, `Puzzle` and `PuzzleWithSolution`, with separate loaders | An optional `solution?` field is a leak waiting to happen. Making the solver's input structurally incapable of carrying answers is a compiler guarantee rather than a code-review convention. |
| Domains | `DomainStore` separate from `Grid`, with a depth-indexed trail | The grid holds letters, the store holds beliefs, and they have different undo semantics: a trailed AC-3 reduction must vanish on backtrack while a merged re-ask result must not. Fusing them into one class is how that distinction gets lost. |
| LLM granularity | one call per clue | Better cache hit rate, isolates parse failures, and re-asks are per-slot by nature; 80 clues at 600 RPM is not throughput-bound. |
| Cache key | `sha1(canonicalJson({...}))` over every prompt-visible field, with policy fields excluded | Canonical JSON removes the separator-collision problem a joined string has, and hashing the exact set of fields that can change the prompt bytes makes the invariant testable: change anything the model sees, get a new key; change a policy, share the cache. |
| Transport selection | by advertised capability from `models.json`, never by model name | A model-name branch quietly sends the wrong request form the moment someone swaps a tier in a profile. Reading `supported_features` makes the router correct for models nobody has tried yet. |
| Offline strictness | `--offline` cache miss is fatal (exit 4); `--offline-lenient` for graceful degradation | A silently degraded offline run produces a number that looks like a measurement and is not. Failing loudly with the key and the clue in the message makes the missing entry a one-line fix; the lenient flag keeps the old behaviour for partial replays. |
| Cost accounting | integer tokens accumulated, USD computed once at write time; `usdBilled` and `usdCounterfactual` both recorded | Floating-point dollars accumulated per call drift. Two figures because they answer different questions: what left the account, and what the strategy actually costs - only the second is comparable between a profile run cold and one run over a warm shared cache. |
| Architecture | pure solver core emitting typed events | Verbosity, `--watch`, run records, replay and metrics all become subscribers; the solver stays testable and has one outward dependency. |
| Raw inference log always on | JSONL at `logs/inference/<date>.jsonl`, written in `llm/client` | Debugging and after-the-fact reporting. Metrics in run records are derived, so they can be recomputed from this log if the run-record schema changes; a metric not captured today is still recoverable tomorrow. |
| Dev environment | Docker only: long-running container plus `docker exec`; CI runs the suite on the runner | Anyone can clone and run the solver with only Docker installed - no Node on the host. A container that stays up means fast repeated commands with no per-invocation start-up, a TTY for `--watch`, and one place for `NEBIUS_API_KEY` via `env_file`. Source, puzzles, runs, logs and cache are bind-mounted, so edits apply immediately and data survives a rebuild. The `node_modules` volume is re-installed by the entrypoint when the lock file hash changes, which removes the one recurring papercut of the volume approach. |
| Confidence | self-reported `clue_understood` is a routing signal, never a score | LLM self-reports are poorly calibrated; the search orders on rank-derived scores instead. |
| Rate limiting | process-wide per-model token bucket, tuned from logged headers, AIMD on 429; the seed pass adds no cap of its own | The seed pass fires dozens of requests at once, so the risk is a burst against an unverified header contract; a client-side bucket is the primary control and is corrected from whatever Nebius actually reports. Two throttles in series would make the effective rate impossible to tune from the logs. |
| Batching | seed pass only, default 1, realign by id, per-clue cache with batchSize in key, evaluated by bench | The seed pass at 10 rps is not slow enough to force batching, so it stays off by default; restricting it to seeding avoids batching slots whose patterns are changing under each other mid-search, and the crossover is a measurement, not a guess. |
| Cryptics | loaded, solved and measured; every set entry carries a stratum; policy decisions made on the american stratum only | Excluding cryptics would throw away the data cheaply available from the Guardian adapter. Deciding policy on them would let an acknowledged prompting gap masquerade as an escalation or batching result. |
| Guardian adapter | kept, but constrained: descriptive User-Agent, 1 rps, `--limit` default 1 and max 20, no backfill command, README statement | It is an unofficial endpoint. A personal-research tool should look like one from the server's side, and the absence of a backfill command is what keeps a convenience from turning into a scrape. |
| Fixtures (superseded 2026-09-04, see decisions addendum) | two hand-authored synthetic grids only (5x5 with an unchecked cell and a 2-letter entry; 7x7 with an accented answer and a multi-word enumeration); no real puzzle is committed in any form | Zero real puzzles committed means zero licence risk, full stop, which is a stronger position than any "public domain by age" provenance claim can offer. The synthetic grids carry the awkward cases (unchecked cell, 2-letter entry, accent, multi-word enumeration) that would be tedious to find in a corpus, and serve as both the primary unit-test fixtures and the only integration-test fixtures. |
| What is committed (superseded 2026-09-04, see decisions addendum) | the two synthetic fixtures, the test cache and run records for those two fixtures only, word-list subset, sets, calibration, bench markdown; never fetched puzzles, real-puzzle-derived cache or run-record data, or inference logs | The repo should hold what makes tests deterministic and what documents a decision, and nothing that is redownloadable, that identifies a real puzzle, or that we have no right to redistribute. |
| Repeat semantics | `--repeat N` feeds `sampleIndex`; `report` separates within-puzzle from across-puzzle variance | Otherwise a repeat is N reads of one cache entry, which measures nothing. Separating the two variances distinguishes model nondeterminism from puzzle difficulty spread. |
| Bench cost ceiling | `--max-usd` default 25 with a pre-flight estimate and `--yes` to override | A profile matrix multiplies out fast, and the failure mode of a mistyped `--repeat` is a bill rather than an error. The estimate makes the cost visible before the first call, not after the last. |
| Exit codes | one table in `src/cli/exit.ts`, typed `CliError`, one top-level catch | Scripts and CI need stable codes, and scattered `process.exit` calls make them impossible to keep stable. |
| CI | two jobs: checks on the runner (`npm ci` + lint + typecheck + test), and `docker compose build` to prove the image builds | Running the suite inside a freshly built image on every push costs minutes to prove something the image job already proves. |

## Open questions

Carried forward from the algorithms doc and not settled here:

- ~~What is the exact Nebius parameter to disable (or minimise) reasoning on `nvidia/Nemotron-3_5-Lightning`?~~ Answered in M2 (T49): `reasoning_effort: "none"` (see "Candidate service" step 2 above and docs/spikes/tier1-reliability.md).
- How well calibrated is Nemotron's `clue_understood`? Measure against fixture solutions before the escalation threshold of 0.4 is trusted (M2 produces the data; the `perSlot` records and the inference log make the measurement a query, not an experiment).
- Is 3-sample self-consistency on tier 1 a better use of budget than one escalation to tier 2? They cost roughly the same. `votes3` against `baseline` in `bench` answers it.
- Do themed puzzles need special handling? The title is stored and passed on escalation only; whether it belongs in the first-pass prompt is unmeasured.
- Is loopy belief propagation worth adding once the cache makes domains dictionary-scale?
- What is the right repair-pass scorer? v1 re-asks tier 1 per proposal. A character n-gram model trained on the xd corpus may be an adequate free substitute, as it was for Proverb and WebCrow.
- Does the inference log need rotation or compaction? v1 says no; revisit once a full bench matrix has been run and the daily file sizes are known.
- Which rate-limit headers does Nebius actually send, and is the limit a per-second bucket or a per-minute window?
- What is the batch-size crossover on Nemotron-3_5-Lightning?
- Are reasoning tokens billed as completion tokens by Nebius? v1 assumes yes and logs them separately so the assumption can be checked against an invoice.
