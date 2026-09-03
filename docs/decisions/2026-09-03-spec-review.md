Record of the resolutions applied to docs/spec.md version 2 and used to write docs/plan.md. Kept so the reasoning behind the spec is traceable.

# Spec review resolutions (2026-09-03)

Source: principal-engineer review of docs/spec.md plus Ben's answers. Every item below is DECIDED. Apply them verbatim to the spec (spec agent) and build the plan against them (plan agent).

## A. Ben's answers

A1. Cryptics: in scope for loading, solving and measurement. Bench puzzle sets carry a `stratum` per entry ("american" | "cryptic"). `report` groups by stratum. The escalation-policy decision and the batch-size decision are made on the american stratum only. Cryptic prompting stays a non-goal for v1 (general prompt with style hint).
A2. Guardian adapter: kept, constrained. Descriptive User-Agent ("crossword-agent/<version> (+https://github.com/bendechrai/crossword-agent; personal research)"), 1 request per second ceiling, `--limit` default 1, hard max 20, no archive backfill command, README line stating personal-research use.
A3. Fixtures: four hand-picked pre-1965 xd puzzles with `puzzles/fixtures/FIXTURES.md` recording per fixture the source URL, publication date, grid size and the specific public-domain basis claimed; plus two hand-authored synthetic grids (5x5 with an unchecked cell and a 2-letter entry; 7x7 with an accented answer and a multi-word enumeration) with zero licence risk. Synthetic grids are the primary unit-test fixtures; xd fixtures are for integration tests.
A4. CLI name: `xw`, with `crossword` declared as an alias bin in package.json. Docs use `xw`. Wrapper script is `./xw`. Container name stays `crossword-solver`.

## B. Orchestrator defaults (Ben may overrule later)

B1. `--repeat N`: repeat index r feeds `sampleIndex` so each repeat is a fresh sample. Default bench recipes use `--repeat 1`; `report` reports stdev across puzzles, and when repeat > 1 reports within-puzzle and across-puzzle variance separately.
B2. Cost: RunRecord.calls records `usdBilled` (network spend) and `usdCounterfactual` (every call priced as if cold, including cache hits, from the cached usage blob). All bench decision rules use `usdCounterfactual`.
B3. Batching applies to `purpose: "seed"` only in v1. Remove the re-ask clause.
B4. v1 = M1-M5. Repair pass moves from M6 into M5. M6 (v1.1) = votes/blend calibration with offline weight fitting, then the escalation-policy bench and batch-size bench are run with repair on.
B5. Seed pass has no concurrency cap of its own; the per-model rate limiter is the only gate.
B6. `--offline` cache miss is fatal: exit 4, message names the cache key and the clue. Add `--offline-lenient` flag for graceful degradation.
B7. Grid model supports unchecked cells: `crossings(slotId)` returns 0..n crossings; `Grid.isChecked(row, col)`; repair gate reads "for any crossing slot, or the result is in the word list"; AC-3 simply has fewer arcs; backtrack target falls back to the lowest-margin assignment anywhere when a slot has no crossings.
B8. Built-in profiles are complete literal objects in `src/profiles/builtins.ts` typechecked against `Profile`; the spec shows them as code, not prose.
B9. Transport selection by capability: `tierRouter` reads `supported_features` from models.json; `structured_outputs` present -> `response_format` json_schema; otherwise in-prompt schema plus one-shot example.
B10. Non-goal reworded: "authoring or exporting puzzles; the solver never writes a puzzle file it did not download".
B11. Two puzzle types: `Puzzle` (no solution field) and `PuzzleWithSolution extends Puzzle { solution: string[][] }`, the latter returned only by the scorer's loader path.
B12. RunRecord: `profile: Profile` plus sibling `provenance: { gitCommit: string; nodeVersion: string; packageVersion: string; profileSource: "builtin" | "file" | string }`. No gitDirty in v1.
B13. Escalation is a pure function `decide(ctx: EscalationContext): EscalationDecision` consulted after every getCandidates return and once at search termination. `EscalationDecision = { action: "none" | "reask" | "escalate" | "give-up"; trigger?: 1|2|3|4|5; reason: string }`.
B14. RunRecord.perSlot gains: `batchIndex: number | null`, `truthInCandidates: boolean`, `truthRank: number | null`, `rejectCounts: Record<RejectReason, number>`, `parseFailures: number`, `latencyMs: number`, `usd: number`. `report --by batchIndex` and the batch-bench metrics derive from perSlot.
B15. `TokenUsage { promptTokens; completionTokens; reasoningTokens?; totalTokens }` in `src/llm/types.ts`.
B16. Normalised puzzle JSON (`puzzles/<source>/<id>.json`) = `PuzzleWithSolution` serialised plus `schemaVersion: 1` and `fetchedAt` ISO; validated by `schemas/puzzle.schema.json`. `xw solve <id>` reads the normalised JSON only; `xw solve <path>` parses the file format.
B17. Guardian JSON loader: `src/puzzle/adapters/guardian.ts` converts Guardian `crossword.entries[]` to `PuzzleWithSolution`; `parsedBy` gains `"guardian-json"`.
B18. Cells addressed as `[row, col]` (row 0 top, col 0 left), rendered `r{row}c{col}` in events and errors. `Crossing.otherSlotId` (renamed from slotId).
B19. Clue numbering always recomputed from the grid (white cell starts a number if it begins an across run >= 2 or a down run >= 2; numbered left-to-right, top-to-bottom from 1). Where the source supplies numbering, mismatch is a load error (exit 3) naming the first divergent cell.
B20. Minimum slot run length 2 (configurable per style); a run with no clue in the source's clue list is not a slot.
B21. `enumeration` derived by matching a trailing `(3,4)`-style group on the clue text or from a structured source field; prompt-only, never affects validation. Clue text kept verbatim.
B22. Profile gains `sampling: { temperature: 0.2, topP?: number, maxTokens: 512 }`; `votes` calibration forces temperature 0.7 via zod refine.
B23. Cache key = sha1(canonicalJson({ model, promptVersion, promptKind, clue, enumeration, length, pattern, style, title, n, samples, sampleIndex, batchSize, rejected: sorted, crossingContext: normalised or null, temperature, topP, maxTokens })) where `promptKind` is "seed" | "constrained" | "escalate" (three templates; reask and repair both render "constrained"). Policy fields stay out. Contract test: any prompt-visible field change yields a different key. Update every occurrence in the spec.
B24. Cache dir resolution: `--cache-dir` > `$CROSSWORD_CACHE_DIR` > `./cache/candidates`. No eviction in v1; `xw cache stats` warns above 1 GB.
B25. Run id: `${puzzleId}--${profileName}--${YYYYMMDD}T${HHmmss}Z--${shortHash}`, shortHash = first 8 hex of sha1(canonicalJson(profile) + gitCommit + repeatIndex). puzzleId and profileName constrained to `[A-Za-z0-9._-]+`.
B26. Profile resolution, lowest to highest: zod defaults < named built-in < profile file (full profile; `"extends": "<builtin>"` allowed) < `--config` values < explicit CLI flags. Resolved profile stored in RunRecord.
B27. Config file: `--config` > `$CROSSWORD_CONFIG` > `./crossword.config.json` > absent. Schema `{ defaultProfile?, cacheDir?, runsDir?, puzzlesDir?, inferenceLogDir?, wordlistPath?, nebiusBaseUrl? }`. No secrets in config; never read from $HOME.
B28. Exit codes in `src/cli/exit.ts`: OK 0, unexpected 1, USAGE 2, NOT_FOUND 3, OFFLINE_MISS 4, PROVIDER 5, BENCH_PARTIAL 6. Typed `CliError { code, message, hint? }`; one top-level catch. In bench: usage error fails before any run; per-run 4/5 marks that run errored and continues; exit 6 if any run errored. RunRecord gains `status: "ok" | "partial" | "error"` and `error?: string`.
B29. Cost formula: solver accumulates integer token counts per (model, tier); USD computed once at write time as `Math.round(1e9 * (promptTokens * Number(p.prompt) + completionTokens * Number(p.completion) + calls * Number(p.request))) / 1e9`. Reasoning tokens billed as completion unless measured otherwise; logged separately.
B30. Git commit inside Docker: read `.git/HEAD` and follow refs (packed-refs fallback), no git binary; else `$GIT_COMMIT`; else "unknown". Never fail a run over provenance.
B31. `--watch` honoured only when `process.stdout.isTTY && !process.env.CI && process.env.TERM !== "dumb"`; otherwise one stderr line and fall back to ConsoleRenderer(0). NO_COLOR and --no-color respected. Assume 80 columns when undefined.
B32. New level-0 event `grid:init` after `run:start` carrying `{ width, height, blocks: boolean[][], numbers: (number|null)[][], slots: [{id,row,col,length,direction,clue}] }`. `search:assign` and `repair:accept` payloads gain `tier: 1 | 2 | "wordlist"` and `producedBy`.
B33. `xw list` on empty index prints `no puzzles yet - try: xw fetch xd --limit 5`, exit 0; `--json` prints `[]`; null metrics render as `-`.
B34. Index row gains `files: { original, normalised }` (repo-relative POSIX), `schemaVersion: 1`, `parsedBy`. Index writes serialised through one writer with an O_EXCL lock file `puzzles/.index.lock` (5 s timeout) and atomic tmp+rename.
B35. Word list: interface `WordList { has(w): boolean; score(w): number; match(pattern, limit): string[] }`; default source Crossword Nexus collaborative word list (MIT); `npm run wordlist:fetch` into `data/wordlist/collaborative.txt` (gitignored); 2,000-line subset committed at `test/fixtures/wordlist.txt`; when absent, null object, repair word-list gate disabled, empty-slot fallback leaves blanks with a one-time warning.
B36. Layout additions: `sets/` (committed; puzzle-set file `{ name, puzzles: [{ id, stratum }] }`), `config/` (committed; calibration.json), `corpora/`, `data/`, `dist/`, `logs/` (gitignored). `.gitignore` updated accordingly.
B37. `progress` events emitted on phase transitions and otherwise at most every 250 ms, coalesced.
B38. `--seed` seeds only a local PRNG (tie-breaks, backoff jitter); passed to provider only if models.json advertises it; recorded in RunRecord. Replay determinism comes from the cache, not the seed.
B39. Domains live in a `DomainStore` separate from `Grid`, with a depth-indexed trail. Forward-check and AC-3 reductions are trailed and undone on backtrack. Re-ask results merge into the slot's base domain and persist across backtracks; pattern filter re-applied at each node.
B40. AC-3 wipeout: restore domain, mark slot suspect, remove every arc incident on that slot from the worklist for the rest of the prepass; emit `ac3:wipeout` once per slot.
B41. Reasoning tokens on tier 1: send the provider's reasoning-off/minimal parameter when the model advertises `reasoning` and purpose is seed (exact parameter name to be discovered in M2 and recorded in the spec); parser strips `<think>...</think>` and any `reasoning_content` before scanning and takes the LAST balanced JSON object; `reasoningTokens` logged separately.
B42. Loader post-condition test (all formats, all fixtures): no `Slot.clue` contains any slot's solution as a substring. `.xd` loader strips everything from ` ~ ` onward in clue lines.
B43. CandidateService gains `peek(slotId): Candidate[]` returning every candidate ever returned for that slot in this run (the ledger the repair gate reads).
B44. `ResolvedBudget` type derived from Profile in `policy/budget.ts`; Profile gains `budget.tokens`.
B45. Bench cost ceiling: `xw bench --max-usd <n>` default 25, aborts matrix and exits 6; pre-flight printed estimate (puzzles x profiles x repeats x estimated per-puzzle usdCounterfactual from prior runs or a static estimate); `--yes` required when estimate exceeds the ceiling.
B46. Fetched puzzles are never committed. README states it. `.gitignore` covers `puzzles/**` except `puzzles/fixtures/**`.
B47. Run records and inference logs are gitignored. Committed: aggregated `report --md` output per bench under `docs/benches/`, and run records for fixture puzzles only under `test/fixtures/runs/`.
B48. CI (GitHub Actions): job 1 `actions/setup-node` 22 + `npm ci` + lint + typecheck + test; job 2 `docker compose build` only. Document `docker compose down -v` after dependency changes; container entrypoint re-runs `npm ci` when `package-lock.json` hash differs from the one recorded in the volume.
B49. Integration tests assert accuracy bounds (e.g. letters >= 0.92) plus a regenerable exact snapshot; `npm run fixtures:refresh` regenerates the committed cache and snapshots together; `promptVersion` bumps are a single-owner action landing with the regenerated cache in one commit.
B50. One smoke test runs `node dist/cli/index.js --version` so `dist/` is exercised.
B51. `LlmTransport` interface in `src/llm/types.ts`: `complete(req: LlmRequest): Promise<LlmResult>` with `LlmResult { text; usage: TokenUsage; httpStatus; headers: Record<string,string>; latencyMs }`, so the candidate service and the Nebius client are built by different agents against a stub.
B52. M0 contracts task (single owner, no implementations): puzzle types; Grid + DomainStore interfaces; SolverEvent union + MIN_LEVEL map; candidate service types + interface; LlmTransport + TokenUsage; SourceAdapter + PuzzleRef + normalise hook; ProfileSchema; JSON schemas (candidate-response, run-record, puzzle-index, puzzle); CLI commander tree with all subcommands/options/help declared and handlers stubbed; exit codes; util/hash (canonicalJson, cacheKey); util/fs (repo root, atomic write, resolved paths); InferenceLogRecord + InferenceLog interface; EscalationContext/EscalationDecision; ResolvedBudget; WordList interface.

## C. Parallel workstreams once M0 lands (from the review)

A Puzzle loading; B Grid + DomainStore; C Sources + fetch/list/show; D Transport (client, rateLimiter, inferenceLog, pricing); E Prompting + parsing + tierRouter; F Candidate service + cache + normalise + calibrate; G Solver (ac3, search, repair, policy) built against a fixture-backed CandidateService; H Renderers built from a hand-written events.jsonl fixture; I Eval (scorer, runRecorder, aggregate, inference report, bench, report) from hand-written RunRecord fixtures; J Infrastructure (Dockerfile, compose, wrapper, tsconfig, eslint, vitest, npm scripts, CI).
Remaining edges: G integration tests need B's Grid (stub then swap); F's disk cache format feeds G's integration tests; I's inference report needs only D's record shape.
