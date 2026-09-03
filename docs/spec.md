# Crossword solver specification

Purpose: define v1 of a Node.js crossword solver that treats an LLM as a candidate oracle wrapped in a deterministic constraint search, and that is instrumented well enough to answer strategy questions with measurements rather than opinions.

Builds on: [crossword-algorithms.md](./crossword-algorithms.md) (prior art, recommended algorithm, module list, open questions), [model-selection.md](./model-selection.md) (two-tier model decision), [crossword-sources.md](./crossword-sources.md) (puzzle sources, file formats, verified parsers).

## Goals

1. Solve American-style and British cryptic crosswords from `.puz`, `.ipuz`, `.jpz` and `.xd` files, reporting letter accuracy, word accuracy and perfect-puzzle rate against the solution grid shipped in the file.
2. Keep the LLM strictly as a candidate oracle. All ordering, commitment, backtracking and repair is deterministic code.
3. Make every run reproducible and replayable: a candidate cache means a run can be re-executed with `--offline` and zero network calls.
4. Make strategy a first-class experiment. Profiles are data; `bench` runs a matrix; `report` aggregates. Changing the search policy over already-cached clues costs close to nothing.
5. One event stream drives all output. Verbosity levels, the `--watch` visual, the JSON run record and replay are all subscribers.
6. Never lose raw data. Every inference request and response is written to an always-on local log, independent of verbosity and of which command triggered it.

## Non-goals for v1

- Cryptic-specific prompting (wordplay decomposition, indicator dictionaries). Cryptics are loaded and solved with the general prompt; the style field is passed through so a later prompt version can branch on it.
- Loopy belief propagation. Domains of 10 unnormalised candidates give near-degenerate marginals; revisit only if a cached corpus makes domains dictionary-scale.
- A web UI. The terminal renderer is the only visual.
- Batching multiple clues per LLM request. One call per clue is better for cache hits, parse-failure isolation and re-asks (see the algorithms doc, "Batching under rate limits").
- Fitting calibration weights automatically. v1 ships `rank` calibration; weight fitting is M6.
- Writing puzzle files. The solver reads only.

## Architecture overview

The solver core is a state machine over the grid. It is pure in spirit: given a grid, a set of domains and a profile, its transitions are deterministic. Its only outward dependency is `CandidateService`, and its only outward emission is a typed `SolverEvent`. Nothing in `src/solver/` writes to stdout, reads the clock for anything but a duration field, or knows a renderer exists.

```
  sources/            fetch                       load
  guardian --.                                       .-> Grid (cells, slots, crossings)
  xd -------- >--> puzzles/<source>/<id>.{ext,json} -+
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
                                         |  disk, incl.  |   | llm/client ->  |
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
| CLI | `commander` | Subcommand tree with per-command options, no framework. |
| Tests | `vitest` | ESM-native, fast watch mode, built-in v8 coverage. |
| JSON Schema | `ajv` (+ `ajv-formats`) | Validates the LLM response, the run record and `puzzles/index.json`. DeepSeek structured outputs consume JSON Schema directly, so the same schema object is both the request constraint and the validator. |
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

No ports are published: this is a CLI. `node_modules` sits in a named volume so the host tree stays clean and a Linux-built install is never overwritten by a macOS one. Everything else - `puzzles/`, `runs/`, `logs/` and `cache/candidates/` - is on the bind mount, so all fetched puzzles, run records, inference logs and cached candidates persist on the host and survive a container rebuild.

The Dockerfile is `node:22-slim`, `npm ci`, then `npm link` so the package `bin` named `crossword` is on `PATH` inside the container. That bin is a `tsx` entry point (`tsx src/cli/index.ts`), so the bind-mounted source is picked up on every invocation with no build step in the dev loop; `npm run build` exists for CI and for producing `dist/`, but you never need it to try a change. Commands are:

```
docker exec -it crossword-solver crossword solve guardian-cryptic-30085 -vv
docker exec -it crossword-solver npm test
docker exec -it crossword-solver npm run lint
```

`-it` matters: the `--watch` renderer needs a TTY, and without it `WatchRenderer` falls back to `ConsoleRenderer(0)`.

A one-line host-side wrapper `./crossword` is committed as optional sugar over that form:

```sh
#!/bin/sh
exec docker exec -it crossword-solver crossword "$@"
```

so the rest of this document can write `./crossword solve <id>`. It is convenience only; the `docker exec` form is always equivalent.

Note for later: `ralph`, the autonomous Claude Code container in Ben's environment, can join this compose network so it drives the same long-running solver container. Not designed here.

### Quick start

```
git clone <repo> && cd crossword-agent
cp .env.example .env            # then add NEBIUS_API_KEY
docker compose up -d
./crossword fetch guardian --series quick --limit 5
./crossword solve guardian-quick-17342 -v
```

## Repository layout

```
src/
  cli/            index.ts (bin) fetch.ts list.ts show.ts solve.ts bench.ts report.ts cache.ts options.ts
  puzzle/         loader.ts library.ts types.ts
  grid/           model.ts pattern.ts
  llm/            client.ts tierRouter.ts prompts.ts parser.ts pricing.ts inferenceLog.ts
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
schemas/          candidate-response.schema.json  run-record.schema.json  puzzle-index.schema.json
test/             unit/ integration/ contract/ fixtures/cache/ fixtures/responses/
puzzles/          <source>/... (gitignored)  fixtures/ (committed)
runs/             (gitignored)
logs/inference/   (gitignored)
cache/candidates/ (gitignored)
crossword          host-side wrapper: exec docker exec -it crossword-solver crossword "$@"
Dockerfile  docker-compose.yml  .env.example  models.json
```

`puzzles/` is gitignored except `puzzles/fixtures/`, which holds six licence-clean puzzles taken from the pre-1965 NYT slice of `xd-puzzles.zip` (public domain by age; see crossword-sources.md). `runs/`, `logs/` and `cache/` are gitignored outright.

## Data model

```ts
// puzzle/types.ts
export type Direction = 'across' | 'down';
export type PuzzleStyle = 'american' | 'cryptic' | 'quick' | 'unknown';

export interface Cell { row: number; col: number; block: boolean; number?: number; }

export interface Slot {
  id: string;                 // `${number}${'A'|'D'}`, e.g. "12A"
  number: number;
  direction: Direction;
  row: number; col: number;   // start cell
  length: number;
  clue: string;
  enumeration?: string;       // "(3,4)" when the source supplies it
  cells: ReadonlyArray<readonly [number, number]>;
}

export interface Puzzle {
  id: string; source: string; date?: string; title?: string; author?: string;
  style: PuzzleStyle; width: number; height: number;
  cells: Cell[][]; slots: Slot[];
  solution?: string[][];      // never handed to the solver; see loadSolution()
  parsedBy: '@xwordly/xword-parser' | 'xd-crossword-tools';
}

export function loadPuzzle(path: string): Promise<Puzzle>;          // strips solution
export function loadSolution(path: string): Promise<string[][]>;    // scoring only
```

```ts
// grid/model.ts
export interface Crossing { slotId: string; offsetInThis: number; offsetInOther: number; }
export interface GridSnapshot { letters: (string | null)[][]; assigned: Record<string, string>; }

export class Grid {
  constructor(puzzle: Puzzle);
  readonly slots: ReadonlyMap<string, Slot>;
  assign(slotId: string, answer: string): void;    // throws on conflict
  unassign(slotId: string): void;                  // trail-based, exact undo
  patternFor(slotId: string): string;              // "A?I?N", '?' = unknown
  regexFor(slotId: string): RegExp;                // /^A[A-Z]I[A-Z]N$/
  crossings(slotId: string): Crossing[];
  letterAt(row: number, col: number): string | null;
  assignmentOf(slotId: string): string | undefined;
  isComplete(): boolean;
  snapshot(): GridSnapshot;
}
```

```ts
// candidates/service.ts
export type Tier = 1 | 2;
export type RejectReason = 'length' | 'charset' | 'pattern' | 'clue-echo' | 'duplicate' | 'rejected-before';
export type Purpose = 'seed' | 'reask' | 'escalate' | 'repair' | 'smoke' | 'calibrate';

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
  tier: Tier; purpose: Purpose; n: number; samples: number;
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
}
```

```ts
// llm/inferenceLog.ts
export interface InferenceLogRecord {
  id: string;                       // uuid v4, one per call attempt
  ts: string;                       // ISO 8601
  runId: string | null;             // null outside a run (smoke, calibrate)
  puzzleId: string | null;
  slotId: string | null;
  purpose: Purpose;
  tier: Tier;
  model: string;
  promptVersion: string;
  cacheKey: string;
  cacheHit: boolean;
  request: {
    messages: Array<{ role: 'system' | 'user'; content: string }>;
    temperature: number; maxTokens: number; topP?: number;
    responseFormat?: unknown;       // present only for structured-output calls
  } | null;                         // null on a cache hit
  rawResponse: string | null;       // verbatim text, null on a cache hit or transport error
  parsed: CandidateResponse | null;
  parseError: string | null;
  httpStatus: number | null;
  attempt: number;                  // 0-based retry index
  promptTokens: number | null;
  completionTokens: number | null;
  usd: number | null;
  latencyMs: number | null;
  error: string | null;             // transport or abort error message
}

export interface InferenceLog { write(record: InferenceLogRecord): void; }
export function openInferenceLog(opts: { dir?: string; enabled?: boolean }): InferenceLog;
```

```ts
// sources/types.ts
export interface PuzzleRef { id: string; source: string; date?: string; title?: string; url: string; ext: 'puz'|'ipuz'|'jpz'|'xd'|'json'; }
export interface SourceAdapter {
  id: string;
  list(opts: { series?: string; date?: string; from?: string; to?: string; limit?: number }): Promise<PuzzleRef[]>;
  download(ref: PuzzleRef): Promise<{ bytes: Buffer; ext: PuzzleRef['ext'] }>;
}
```

`Profile`, `SolverEvent` and `RunRecord` are defined in their own sections below.

## Puzzle library and sources

Adapters are registered in `src/sources/registry.ts` by `id`.

- `guardian`: `GET https://www.theguardian.com/crosswords/<series>/<id>.json`. Series: `quick|cryptic|prize|quiptic|speedy|everyman|weekend`. `list()` walks ids backwards from the latest found on the series page. Style is `cryptic` for `cryptic|prize|quiptic|everyman|weekend` and `quick` for `quick|speedy`. This is an unofficial endpoint: failures are expected and are surfaced as a clear error, never a stack trace.
- `xd`: reads a local directory or a `.zip` of the xd corpus (`--path`, default `./corpora/xd-puzzles.zip`). No network.
- `file`: imports a local path or a URL to a single `.puz/.ipuz/.jpz/.xd`.

Storage: the original goes to `puzzles/<source>/<id>.<ext>`, the normalised `Puzzle` (with solution) to `puzzles/<source>/<id>.json`, and a row is upserted into `puzzles/index.json` (validated by `schemas/puzzle-index.schema.json`) holding `{ id, source, date, title, style, width, height, slotCount, files, addedAt, bestLetterAccuracy, lastRunAt }`. The last two fields are updated by `RunRecorder` at the end of every run.

`list` and `show` read only the index and the normalised JSON, so they work offline.

## Candidate service

`CandidateService.getCandidates` is the only route the solver has to the outside world, and it does five things in order.

**1. Cache lookup.** Key: `sha1(model, promptVersion, clue, length, pattern, style, sampleIndex)` joined with a separator that cannot occur in a clue. Two layers: an in-process LRU (2,000 entries) and a disk cache at `cache/candidates/<first2>/<sha1>.json` holding `{ key, model, promptVersion, clue, length, pattern, style, sampleIndex, response, usage, latencyMs, createdAt }`. Negative results (zero valid candidates) are cached in the same shape, so backtracking never re-pays for a known dead end. With `--offline`, a miss throws `OfflineCacheMiss` and the run ends the current phase with whatever fill exists.

**2. Tier routing.** `tierRouter` maps `req.tier` to a model id from the profile (`tier1` default `nvidia/Nemotron-3_5-Lightning`, `tier2` default `deepseek-ai/DeepSeek-V4-Pro`) and picks the transport: DeepSeek gets `response_format: { type: 'json_schema', json_schema: <candidate-response.schema.json> }`; Nemotron gets the schema inline in the prompt with a one-shot example. Rate limiting is a token bucket per model seeded from `models.json` `per_request_limits` (600 RPM / 400k TPM for tier 1; 3,000 RPM / 1M TPM for tier 2). Retries: 3 attempts, exponential backoff with jitter, on 429, 5xx and timeouts only.

**3. Parsing.** `llm/parser.ts` strips code fences, extracts the first balanced JSON object, and validates against ajv. On failure it retries once at temperature 0; a second failure counts as a tier-1 failure and is an escalation trigger.

**4. Validation** (`validate/normalise.ts`, no model calls, in this order): normalise (uppercase, strip spaces, hyphens, apostrophes and punctuation, NFD-decompose and drop combining marks); reject any remaining non `A-Z`; length check against `slot.length`; pattern regex test; dedupe on the normalised string keeping the best score and summing votes; clue-echo rejection (normalised answer equals or is contained in the normalised clue), waived if the slot would otherwise be empty; drop anything in the slot's persistent rejection set. Every drop emits a `candidate:reject` event carrying a `RejectReason`.

**5. Calibration** (`score/calibrate.ts`). `rank` (v1 default): `score = 1 / (2 + rank)`. `votes`: `score = votes / samples`, rank as tie-break, requires `samples >= 3` at temperature 0.7. `blend`: `w1*voteFraction + w2*(1/(2+rank)) + w3*selfConfidence`, weights from `config/calibration.json` (v1 ships `[0.5, 0.4, 0.1]` as a placeholder; fitting is M6). `clue_understood` is never a score, only a routing signal.

Prices come from `models.json` at the repo root, loaded once by `llm/pricing.ts`: `pricing.prompt` and `pricing.completion` are USD per token as decimal strings, so `usd = promptTokens * Number(pricing.prompt) + completionTokens * Number(pricing.completion)`. A model id absent from `models.json` is a startup error, not a zero cost.

### Inference log (always on)

`llm/inferenceLog.ts` is wired into `llm/client.ts`, the transport layer, not into the solver. Every call is therefore captured whatever triggered it - seeding, re-asks, escalations, repair-pass scoring, the Nebius smoke test, and offline calibration fitting - and capture does not depend on the verbosity level or on which subcommand is running. Retries are logged as separate records distinguished by `attempt`.

Cache hits are logged too, as records with `cacheHit: true`, `request: null` and `rawResponse: null`, carrying the `cacheKey`, `purpose`, `slotId` and the cached `parsed` value. The log therefore shows the full sequence of what the solver asked, not only what reached the network.

Format: append-only JSONL, one `InferenceLogRecord` per line, at `logs/inference/<YYYY-MM-DD>.jsonl`. Daily files, size-unbounded in v1 (no rotation, no compaction). Writes are fire-and-forget appends through a single write stream per process; a write failure logs a warning once and never fails the run. Each record carries `runId`, so a run's calls can be pulled with `grep` or through `report --inference --run <runId>`.

Redaction: the API key never appears. Request headers are not logged at all, which is the simplest way to guarantee that. No other redaction in v1 - clue text, prompts and raw responses are stored verbatim, since raw data first and metrics derived later is the point.

`solve` and `bench` take `--no-inference-log` for the rare case it is unwanted; the default is on.

## Solver pipeline

`solve(grid, service, profile, emit)` implements the 8 steps from the algorithms doc. Event names in brackets are emitted at that exact point.

1. **Load.** Grid and slots built; the solution is not passed in. `[run:start, phase:start('seed')]`
2. **Seed.** For every slot, one tier-1 call with clue, length, style, empty pattern, `n = candidatesPerAsk`, `samples = profile.samples`, `purpose: 'seed'`. Concurrency is capped at 16. Domains are the validated, calibrated candidate lists. A slot empty after validation goes onto the escalation queue immediately. `[slot:ask, slot:candidates, candidate:reject, phase:end('seed')]`
3. **Prepass (AC-3).** Worklist over crossing arcs; for arc `(s,t)`, drop any candidate of `s` with no candidate of `t` agreeing at the shared cell; requeue the other arcs of `s` on any reduction. On a wipeout, restore the domain and mark the slot `suspect` - a wipeout here means a domain is missing its true answer, not that the puzzle is unsatisfiable. `[phase:start('prepass'), ac3:arc, ac3:reduce, ac3:wipeout, phase:end]`
4. **Search.** Depth-first with forward checking. Variable ordering maximises `bestScore - secondBestScore` (Dr.Fill's margin), ties broken by fewest surviving candidates, then most unassigned crossings; `ordering: 'mrv'` swaps the primary key for domain size, for ablation. Values go in calibrated score order. On assignment, intersect each crossing domain with the new pattern regex. Taking other than the first-ranked value increments the discrepancy count; exceeding `ldsLimit` abandons the branch, and when the tree is exhausted the search restarts at `ldsLimit + 1` up to `ldsLimitMax`. `[phase:start('search'), search:assign, search:unassign, search:forwardcheck, search:wipeout, search:backtrack, lds:restart, progress]`
5. **Re-ask (the sweep).** A domain that empties triggers a tier-1 re-ask (`purpose: 'reask'`) with the current pattern plus the rejected list, provided the pattern has at least one fixed letter, differs from the last pattern queried for that slot, and the slot is under `reasksPerSlot` (default 2). Merge and continue. `[slot:reask]`
6. **Escalate.** `policy/escalation.ts` is consulted at exactly three points: after seed validation (triggers 1 and 3), after a failed re-ask (triggers 2 and 4), and at search termination for still-empty slots (trigger 5). It owns all caps. `[slot:escalate, budget:hit]`
7. **Repair.** From the possibly partial fill, propose 1-2 letter edits where each changed letter appears in some cached candidate for one of the two crossing slots, or the result is in the word list. Score each proposal by re-asking tier 1 for the affected slots with the new pattern (`purpose: 'repair'`); accept improving edits until none remain or `repair.maxCalls` is spent. Fill still-empty slots with the best word-list entry matching the pattern. `[phase:start('repair'), repair:propose, repair:accept, repair:reject]`
8. **Score.** `eval/scorer.ts` compares against the solution accessor: letters correct over non-block cells, words correct over slots, perfect flag, empty cells. Always runs. `[phase:start('score'), score:final, cost:summary, grid:final, run:end]`

**Failure**, for escalation purposes, is: no parseable answer, zero candidates surviving validation, an answer of the wrong length, or a domain emptied by conflict with a crossing.

**Budget-cap behaviour.** `policy/budget.ts` tracks USD, tokens, tier-2 calls, backtracks, repair calls and wall-clock. Hitting a cap emits `budget:hit` and ends the *current phase* gracefully - the search returns its best partial fill, repair stops proposing - and the pipeline proceeds to the next phase. It never throws and never skips step 8. A partial fill still produces a measurable accuracy number.

**Backtracking target.** When a slot cannot be filled after re-ask and escalation, undo the *lowest-margin* assignment among the slots crossing it, not the chronologically last one.

## Events and verbosity

`SolverEvent` is a discriminated union on `type` in `src/events/types.ts`. Every event carries `{ runId: string; seq: number; tMs: number }` plus its own fields. `src/events/levels.ts` exports `const MIN_LEVEL: Record<SolverEvent['type'], 0 | 1 | 2 | 3>`, and a renderer subscribing at level `L` sees events whose minimum level is at most `L`. The table below is that mapping; adding an event type without a level entry is a type error.

| Event | Level | Payload / what it shows |
| --- | --- | --- |
| `run:start` | 0 | puzzleId, profile name, models, seed |
| `phase:start` / `phase:end` | 0 | phase name, durationMs on end |
| `progress` | 0 | assigned / total slots, elapsed, usd so far |
| `grid:final` | 0 | final letters |
| `score:final` | 0 | letters, words, perfect, emptyCells |
| `cost:summary` | 0 | calls and usd per tier |
| `budget:hit` | 0 | which cap, limit, actual |
| `run:end` | 0 | exit status, wallMs |
| `slot:ask` | 1 | slotId, clue, length, pattern, tier, purpose |
| `slot:candidates` | 1 | slotId, accepted list of `{answer, score}` |
| `search:assign` | 1 | slotId, answer, score, margin |
| `slot:reask` | 1 | slotId, pattern, attempt number |
| `slot:escalate` | 1 | slotId, trigger, tier-2 calls used |
| `repair:accept` | 1 | slotId, before, after, edit distance |
| `pattern:built` | 2 | slotId, pattern, regex source |
| `candidate:reject` | 2 | slotId, answer, reason |
| `domain:filtered` | 2 | slotId, surviving list after filtering |
| `search:forwardcheck` | 2 | slotId, crossing slot, survivors before and after |
| `search:wipeout` | 2 | slotId whose domain emptied |
| `search:unassign` | 2 | slotId, answer removed |
| `search:backtrack` | 2 | undone slotId, its margin, why it was chosen |
| `ac3:reduce` | 2 | arc, removed candidates |
| `ac3:wipeout` | 2 | slotId marked suspect |
| `lds:restart` | 2 | new discrepancy limit, discrepancies used |
| `repair:propose` / `repair:reject` | 2 | proposal, and the gate it passed or failed |
| `llm:request` | 3 | model, full prompt text |
| `llm:response` | 3 | raw response body |
| `cache:lookup` | 3 | key, hit or miss |
| `llm:usage` | 3 | promptTokens, completionTokens, usd, latencyMs |
| `ac3:arc` | 3 | each arc visited |
| `phase:timing` | 3 | fine-grained timings within a phase |

The level-3 `llm:*` events are for live reading. They are not the durable record - the inference log is, and it is written whatever the level.

## Renderers

All subscribe to the same `EventBus` (`on(handler)`, `emit(event)`, synchronous, ordered).

- **`ConsoleRenderer(level: 0|1|2|3, stream)`** - one line per accepted event, prefixed with elapsed ms and slot id. Level 0 additionally prints the final grid, the diff against the solution (wrong letters in red, empty cells as `.`), and the score and cost block.
- **`WatchRenderer()`** - `log-update` full-frame redraw on `search:assign`, `search:unassign`, `repair:accept` and `progress`. Cells are coloured by producing tier (tier 1 cyan, tier 2 magenta, word-list fallback grey) and confidence band (bold at 0.5 and above, normal at 0.25 and above, dim below). A status line shows phase, assigned/total, backtracks and usd. On `score:final` it overlays the diff. Falls back to `ConsoleRenderer(0)` when stdout is not a TTY.
- **`RunRecorder()`** - accumulates the `RunRecord`, writes it to `--out` (default `runs/<runId>.json`) on `run:end`, then updates `puzzles/index.json`.
- **`JsonlEventSink(path)`** - appends every event as one JSON line to `runs/<runId>.events.jsonl`. Attached automatically at `-vvv` or with `--trace`.
- **`replay(path, renderer)`** in `src/render/replay.ts` - reads a `.events.jsonl` back through any renderer, so a `--watch` playback of an old run costs nothing.

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
  reasksPerSlot: z.number().int().min(0).default(2),
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
  budget: z.object({ usd: z.number().default(0.5), wallMs: z.number().default(900000) }).default({}),
  promptVersion: z.string().default('v1'),
});
export type Profile = z.infer<typeof ProfileSchema>;
```

Built-ins in `src/profiles/builtins.ts`: `baseline` (all defaults - the recommended algorithm as researched); `eager-escalation` (`policy: 'eager'`, escalate on the first wipeout before any re-ask, `reasksPerSlot: 0`); `patient` (`policy: 'patient'`, `reasksPerSlot: 3`, `maxBacktracks: 500`, escalate only for slots still empty when search terminates); `no-repair` (`repair.enabled: false`); `tier1-only` (`maxTier2CallsPerPuzzle: 0`); `strong-only` (`tier1` set to DeepSeek-V4-Pro, as an accuracy upper bound); `votes3` (`calibration: 'votes'`, `samples: 3`).

**Why experiments are cheap.** The cache key is `(model, promptVersion, clue, length, pattern, style, sampleIndex)` and contains no policy fields. Two profiles differing only in search or escalation policy therefore share every cached query. A second profile over a puzzle set already run pays only for the `(clue, pattern)` combinations no previous run asked for - typically the re-asks that a different policy generates. `--offline` forbids the network entirely and fails any run needing an uncached query, which is what makes the integration tests deterministic.

**The open question: escalate sooner, or exhaust permutations first?** Run

```
crossword bench sets/mixed-30.json --profiles baseline,eager-escalation,patient --repeat 2
crossword report --by profile --compare baseline,eager-escalation,patient --md
```

over 30 puzzles (20 American from the xd slice, 10 Guardian cryptic), then compare perfect-puzzle rate, mean USD per puzzle and USD per correct word. **Decision rule:** pick the profile with the highest perfect-puzzle rate, unless its USD per correct word exceeds the best other profile's by more than a factor of 1.5, in which case pick that other profile. Report the letter-accuracy delta alongside, but do not decide on it - letter accuracy saturates and hides exactly the tail this question is about.

## Metrics and run records

`runs/<runId>.json`, validated by `schemas/run-record.schema.json`:

```ts
export interface RunRecord {
  runId: string;                 // `${puzzleId}-${profileName}-${ISO}-${shortHash}`
  timestamp: string;             // ISO 8601
  puzzle: { id: string; source: string; style: PuzzleStyle; size: string; slots: number };
  profile: Profile & { promptVersion: string; gitCommit: string };
  models: { tier1: string; tier2: string };
  accuracy: { letters: number; words: number; perfect: boolean; emptyCells: number };
  perSlot: Array<{
    slotId: string; clue: string; length: number;
    truth: string; filled: string | null; correct: boolean;
    producedBy: 1 | 2 | 'wordlist' | null;
    reasks: number; escalated: boolean; candidatesSeen: number; pickedRank: number | null;
  }>;
  calls: Record<'tier1' | 'tier2', {
    count: number; promptTokens: number; completionTokens: number;
    usd: number; cacheHits: number; avgLatencyMs: number;
  }>;
  search: { backtracks: number; discrepancies: number; wipeouts: number; ac3Reductions: number };
  repair: { proposals: number; accepted: number };
  wallMs: number;
  budgetHits: Array<{ cap: string; limit: number; actual: number; atMs: number }>;
}
```

`accuracy.letters` and `accuracy.words` are fractions in [0,1]. `usd` is computed by `llm/pricing.ts` from `models.json` as described above; cache hits contribute zero tokens and zero USD but are counted in `cacheHits`. Every number here is derivable from the inference log plus the event stream, which is the point of keeping both.

`report` aggregates a glob of run records (`eval/aggregate.ts`) and emits, per profile: mean and sample standard deviation of letter accuracy, word accuracy and perfect rate; mean USD per puzzle; USD per correct word (`sum(usd) / sum(correct words)`); tier-2 share of calls (`tier2.count / (tier1.count + tier2.count)`); mean wallMs; and budget-hit counts by cap. It also emits a per-slot difficulty view: clues keyed by `(puzzleId, slotId)` with the number of profiles that got them wrong, worst first, which is the fastest way to find prompt bugs. `--compare a,b` prints a paired table with deltas; `--by tier` groups by producing tier instead of profile.

## CLI reference

All commands run inside the long-running container, either as `docker exec -it crossword-solver crossword <subcommand> ...` or through the `./crossword` wrapper. Worked examples:

```
docker exec -it crossword-solver crossword fetch guardian --series cryptic --limit 10
docker exec -it crossword-solver crossword solve guardian-cryptic-30085 --profile baseline -vv --watch
docker exec -it crossword-solver crossword bench sets/mixed-30.json --profiles baseline,patient --repeat 2
```

Global options: `--config <path>`, `--no-color`, and `--json` where a command supports it. Exit codes: `0` success; `2` usage or validation error; `3` puzzle or run record not found, or parse failure; `4` `--offline` cache miss; `5` provider failure after retries; `6` `bench` completed but at least one run errored.

**`crossword fetch <source>`** `--series <s>` `--date <YYYY-MM-DD>` `--from <d>` `--to <d>` `--limit <n>` (default 1) `--out <dir>` (default `puzzles/`) `--path <dir|zip>` (xd adapter). Downloads, normalises, writes both files, upserts the index. Prints one line per puzzle: `fetched guardian-cryptic-30085  15x15  cryptic  32 slots`. Exit 3 if the source returns nothing.

**`crossword list`** `--source <id>` `--style <s>` `--solved` (only puzzles with a run at 100% letters) `--json`. Table columns: id, source, date, size, style, slots, best letters, last run.

**`crossword show <id>`** `--solution`. Prints the numbered grid (blocks as `#`, letters as `.` unless `--solution`) and the across and down clue lists.

**`crossword solve <id|path>`** `--profile <name|path>` (default `baseline`) `--tier1 <model>` `--tier2 <model>` `-v|-vv|-vvv` `--watch` `--offline` `--budget-usd <n>` `--seed <n>` (seeds tie-breaks and sampling temperature jitter) `--trace` `--no-inference-log` `--out <run.json>`. Prints the final grid, the diff against the solution with wrong letters marked, the accuracy block and the cost block; writes the run record. Exit 0 even on a partial fill.

**`crossword bench <puzzle-set>`** `--profiles a,b,c` (required) `--repeat <n>` (default 1) `--offline` `--concurrency <n>` (default 2) `--no-inference-log` `--out <dir>` (default `runs/`). `<puzzle-set>` is a JSON file of puzzle ids or a glob. One run record per `(puzzle, profile, repeat)`. Prints a progress line per run and a summary table at the end: profile, n, letters, words, perfect, usd per puzzle, usd per correct word.

**`crossword report`** `--runs <glob>` (default `runs/*.json`) `--compare a,b` `--by profile|puzzle|tier` (default `profile`) `--json|--md`. Prints the aggregates above.

**`crossword report --inference`** reads `logs/inference/*.jsonl` instead of run records and answers the basic operational questions: calls per model per day, USD per day, parse-failure rate per model (`parseError != null` over total non-cache-hit calls), cache-hit rate, and the 20 slowest calls by `latencyMs`. Additional filters: `--since <date>` `--until <date>` `--model <id>` `--run <runId>` `--slot <slotId>` `--dump` (print full matching records as JSON, for feeding a parser fixture or debugging a single clue).

**`crossword cache stats|clear|export <file>|import <file>`** - `stats` prints entry count, disk bytes, last-run hit rate, and a breakdown by model and promptVersion; `clear` takes `--model` and `--prompt-version` filters; `export` and `import` move a tarball of `cache/candidates/`, which is how the committed test cache is produced.

## Testing

Unit tests (no network, no filesystem beyond fixtures): grid model (slot extraction, crossing index, exactness of the assign/unassign trail, `isComplete`); loader normalisation across all four formats; `patternFor` and the regex builder; the validation chain including every `RejectReason`; AC-3 including the wipeout-restore path; margin ordering and its tie-breaks; LDS discrepancy counting and restart; repair proposal gating; the scorer; and USD calculation from `models.json` against hand-computed values.

Integration tests: run `solve` end to end with `--offline` against each puzzle in `puzzles/fixtures/`, backed by a committed cache at `test/fixtures/cache/` (produced with `cache export`). These assert exact accuracy numbers, so any behaviour change shows up as a diff. They cover `baseline`, `no-repair` and `tier1-only`.

Contract tests: `llm/parser.ts` against recorded raw responses in `test/fixtures/responses/`, including fenced JSON, a leading prose paragraph, trailing commentary, a truncated object, a wrong-typed `confidence`, and answers containing spaces and accents. These fixtures are harvested from the inference log - `report --inference --dump` filtered to records with a non-null `parseError` is the intended source of new malformed-response cases, so every parser bug seen in the wild becomes a regression test.

Smoke test: one real clue against Nebius on tier 1, `describe.skipIf(!process.env.NEBIUS_API_KEY)`.

Coverage target: 80% lines and 75% branches overall, 95% lines for `src/grid/`, `src/validate/` and `src/eval/scorer.ts`. CI is a single GitHub Actions workflow that runs `docker compose up -d --build` and then `docker exec crossword-solver npm run lint`, `... npm run typecheck` and `... npm test -- --coverage` on push and pull request (no `-it`, since CI has no TTY), with no `NEBIUS_API_KEY` in the environment so the smoke test is skipped.

## Milestones

- **M1** - grid model, puzzle loader for all four formats, source adapters, `fetch`, `list`, `show`, the puzzle index, and the committed fixtures.
- **M2** - `CandidateService`: prompts, Nebius client, inference log, tier router, parser, validation chain, cache with negatives, `cache` subcommand, rank calibration.
- **M3** - event bus and taxonomy, AC-3 prepass, search with margin ordering and LDS, re-ask, escalation policy, budgets, `solve` with `-v/-vv/-vvv`.
- **M4** - `WatchRenderer`, `JsonlEventSink`, replay.
- **M5** - `RunRecorder` and run-record schema, `bench`, `report` and its aggregates, `report --inference`.
- **M6** - repair pass, `votes` and `blend` calibration with offline weight fitting against the fixture solutions, then the escalation-policy bench and its decision.

## Decisions log

| Decision | Choice | Reason |
| --- | --- | --- |
| Language | TypeScript, strict, ESM | Index-heavy grid code; `strict` plus `noUncheckedIndexedAccess` catches the class of bug this project is most exposed to. |
| Package manager | npm | Ships with Node 22; no extra layer in the image; single package, no workspaces. |
| Logger | minimal custom leveled logger | Leveled output is the event stream's job; `pino` would be a second competing output path for a handful of bootstrap lines. |
| Schema library | ajv for wire formats, zod for profiles | DeepSeek structured outputs need JSON Schema, so ajv is required anyway; profiles are internal, and `z.infer` avoids a duplicate hand-written type. |
| LLM granularity | one call per clue | Better cache hit rate, isolates parse failures, and re-asks are per-slot by nature; 80 clues at 600 RPM is not throughput-bound. |
| Cache key | `(model, promptVersion, clue, length, pattern, style, sampleIndex)` | Excludes all policy fields, so different strategies share cached queries and only pay for genuinely new `(clue, pattern)` pairs. |
| Architecture | pure solver core emitting typed events | Verbosity, `--watch`, run records, replay and metrics all become subscribers; the solver stays testable and has one outward dependency. |
| Raw inference log always on | JSONL at `logs/inference/<date>.jsonl`, written in `llm/client` | Debugging and after-the-fact reporting. Metrics in run records are derived, so they can be recomputed from this log if the run-record schema changes; a metric not captured today is still recoverable tomorrow. |
| Dev environment | Docker only: long-running container plus `docker exec` | Anyone can clone and run the solver with only Docker installed - no Node on the host. A container that stays up means fast repeated commands with no per-invocation start-up, a TTY for `--watch`, and one place for `NEBIUS_API_KEY` via `env_file`. Source, puzzles, runs, logs and cache are bind-mounted, so edits apply immediately and data survives a rebuild. |
| Confidence | self-reported `clue_understood` is a routing signal, never a score | LLM self-reports are poorly calibrated; the search orders on rank-derived scores instead. |

## Open questions

Carried forward from the algorithms doc and not settled here:

- How well calibrated is Nemotron's `clue_understood`? Measure against fixture solutions before the escalation threshold of 0.4 is trusted (M2 produces the data; the `perSlot` records and the inference log make the measurement a query, not an experiment).
- Is 3-sample self-consistency on tier 1 a better use of budget than one escalation to tier 2? They cost roughly the same. `votes3` against `baseline` in `bench` answers it.
- Do themed puzzles need special handling? The title is stored and passed on escalation only; whether it belongs in the first-pass prompt is unmeasured.
- Is loopy belief propagation worth adding once the cache makes domains dictionary-scale?
- What is the right repair-pass scorer? v1 re-asks tier 1 per proposal. A character n-gram model trained on the xd corpus may be an adequate free substitute, as it was for Proverb and WebCrow.
- Do cryptics need their own prompt version and escalation threshold? v1 uses the general prompt and records the style, so the split can be measured from run records already collected.
- Batch size on the first pass: v1 fixes one call per clue. Revisit only if measured per-request latency, rather than quota, dominates wall time.
- Does the inference log need rotation or compaction? v1 says no; revisit once a full bench matrix has been run and the daily file sizes are known.
