# Implementation plan

Purpose: turn [spec.md](./spec.md) into a queue of small, independently verifiable tasks that many coding agents can work in parallel, one task per agent, first time, with no file contention. The plan is built on spec.md as it stands after the 2026-09-03 spec review resolutions (decisions A1-A4, B1-B52, C); where a decision id is cited below, it is the authority.

Task ids (`T0`, `T1`, ...) are stable. Use them in branch names (`task/<id>-<slug>`) and in commit subjects (`<id>: <subject>`). Never renumber a task; if a task is dropped, leave the id retired.

Related reading: [crossword-algorithms.md](./crossword-algorithms.md) for the algorithm the solver implements.

## How to work a task

1. Read the spec sections named in your task, plus this file's "Wave 0" section so you know what the contracts guarantee. Do not read the whole spec end to end unless your task says to.
2. Work only inside your task's **Owns** list. Files in **Reads** are read-only for you. If you believe a file outside your list must change, stop and say so in the PR instead of changing it (see "Merge order and conflict rules").
3. Where the task says "tests first", write the failing test before the implementation, and say so in the PR.
4. Run `npm run lint && npm run typecheck && npm test`. Inside the container that is `docker exec -it crossword-solver npm run preflight`, where `preflight` is defined in T0 as exactly that chain. Paste the tail of the output into the PR description.
5. Commit subject: `<id>: <short imperative subject>`. One PR per task, branch `task/<id>-<slug>`.
6. If the task text conflicts with spec.md, **follow the task text** and add a "Spec conflict" section to the PR naming the spec heading and the difference. Do not edit spec.md (only T49 may).
7. Never bump `promptVersion`. It is `"1"` for all of v1 and only T31 owns it (B49: a bump lands with a regenerated cache in one commit, as a separate single-owner action).
8. Never commit anything under `puzzles/` except `puzzles/fixtures/**` (B46). Never commit `runs/`, `logs/`, `cache/`, `data/`, `corpora/`, `dist/` (B36, B47).
9. No network in tests. The only tasks allowed to touch the network are T49 (M2 spike) and T50 (fixture refresh), and both are marked **NETWORK**.
10. ASCII only in source, tests and docs: no em dashes, no curly quotes.

## Dependency overview

```
Wave 0            Wave 1                     Wave 2                    Wave 3                   Wave 4
--------          ----------------------     --------------------      ------------------       ---------------------
                  J  T1  docker              A  T24 loader puz/ipuz    G  T42 repair            J  T50 cache fixtures
                  J  T2  ci                  A  T25 loader xd          F  T43 wordlist             + integration (NET)
                  B  T3  grid model          A  T26 guardian puzzle    G  T44 solve()           J  T51 e2e + dist smoke
                  B  T4  domain store        C  T27 xd source          J  T45 cli solve         I  T52 benches + sets
   T0             B  T5  pattern             C  T28 guardian source    I  T46 cli report        -- deferred (v1.1) --
 contracts  --->  A  T6  normalise      ---> C  T29 cli fetch      ---> I  T47 cli bench   --->  F  T53 votes/blend
 (opus)           A  T7  numbering+enum      C  T30 cli list/show      A  T48 xd fixtures       I  T54 M6 bench runs
                  D  T8  pricing             E  T31 prompts (opus)     E  T49 M2 spike (NET)
                  D  T9  rate limiter        E  T32 tier router
                  D  T10 inference log       D  T33 nebius client
                  E  T11 parser (opus)       F  T34 candidate svc
                  F  T12 cache               F  T35 cli cache
                  F  T13 calibrate rank      G  T36 ac3 (opus)
                  H  T14 console renderer    G  T37 search core (opus)
                  H  T15 bus/jsonl/replay    G  T38 search hooks (opus)
                  I  T16 scorer              H  T39 watch renderer
                  I  T17 run recorder        I  T40 aggregate
                  G  T18 escalation          I  T41 inference report
                  G  T19 budget
                  G  T20 ordering
                  C  T21 library/index
                  C  T22 file source
                  J  T23 profiles
```

Gate between waves:

| Wave | Starts when | Tasks |
| --- | --- | --- |
| 0 | now | 1 |
| 1 | T0 is merged to `main` | 23 |
| 2 | every Wave 1 task is merged | 18 |
| 3 | every Wave 2 task is merged | 9 |
| 4 | every Wave 3 task is merged | 5 (2 of them deferred to v1.1) |

Within a wave, every task can run concurrently with every other task in the same wave: no two tasks in a wave own the same file. A task may **read** any file owned by an earlier wave (already merged) or declared by T0.

Two intra-wave dependencies are deliberate and safe because the contract they cross is declared in T0, not in the sibling task: T38 (search hooks) implements an interface T37 (search core) calls; T44 (solve orchestration) composes T36/T37/T38/T42 through the `SolveDeps` record declared in T0 and tests them with fakes. Do not import a sibling wave-mate's implementation module directly; go through the T0 contract.

## Wave 0: contracts (single owner, opus)

### T0: Contracts, scaffold and synthetic fixtures
- Workstream: J (Infrastructure) with contract authority over all workstreams
- Model: opus
- Depends on: nothing
- Estimate: **4-6 hours**. This is the biggest task in the plan and it **cannot be split**: the types are mutually referential (a `SolverEvent` payload names `Candidate`, which names `Tier`, which the `Profile` schema constrains, which the `RunRecord` embeds, which the run-record JSON schema must match), so two agents splitting it would deadlock on each other's type names.
- Owns (creates all of the following; nothing here exists yet):

  Repo config
  - `package.json` - all dependencies pinned to exact versions (no `^`, no `~`): `commander`, `zod`, `ajv`, `ajv-formats`, `chalk`, `log-update`, `lru-cache`, `@xwordly/xword-parser@1.1.0`, `xd-crossword-tools@14.1.0`, `adm-zip` (or `yauzl`) for the xd corpus zip, `uuid`; dev: `typescript@5.x`, `tsx`, `vitest`, `@vitest/coverage-v8`, `eslint`, `typescript-eslint`, `@types/node`. `"type": "module"`, `"engines": { "node": ">=22" }`, `bin: { "xw": "./bin/xw.js", "crossword": "./bin/xw.js" }` (A4).
  - `package-lock.json` - generated by `npm install`, committed.
  - `tsconfig.json` - `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride`, `exactOptionalPropertyTypes: false`, `module: "NodeNext"`, `target: "ES2023"`, `outDir: "dist"`.
  - `eslint.config.js` - flat config, typescript-eslint recommended-type-checked, `@typescript-eslint/no-explicit-any: error`, `no-console: error` outside `src/render/` and `src/cli/`.
  - `vitest.config.ts` - `environment: "node"`, `include: ["test/**/*.test.ts"]`, v8 coverage thresholds from the spec's Testing section (80% lines / 75% branches global; 95% lines for `src/grid/`, `src/validate/`, `src/eval/scorer.ts`).
  - `.gitignore` - per B36/B46/B47: ignore `node_modules/`, `dist/`, `runs/`, `logs/`, `cache/`, `data/`, `corpora/`, `.env`, and `puzzles/**` with a negation for `puzzles/fixtures/**`. `sets/` and `config/` are committed.
  - `bin/xw.js` - executable shim, `#!/usr/bin/env -S npx tsx` style entry that imports `../src/cli/index.ts`.
  - `scripts/wordlist-fetch.ts`, `scripts/fixtures-refresh.ts` - stubs that throw NotImplemented (so the npm scripts exist from day one and no later task edits `package.json`).

  npm scripts (all declared now; **no later task may edit `package.json`**):
  `build` (`tsc -p tsconfig.json`), `lint` (`eslint .`), `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `test:watch`, `coverage` (`vitest run --coverage`), `preflight` (`npm run lint && npm run typecheck && npm test`), `wordlist:fetch` (`tsx scripts/wordlist-fetch.ts`), `fixtures:refresh` (`tsx scripts/fixtures-refresh.ts`), `smoke:dist` (`node dist/cli/index.js --version`).

  Contract modules - **fully implemented** (they are tiny, everything depends on them, and later tasks must be able to write real tests in Wave 1):
  - `src/util/hash.ts` - `canonicalJson(v: unknown): string` (recursively key-sorted, no whitespace, `undefined` fields dropped), `sha1(s: string): string`, `cacheKey(input: CacheKeyInput): string` implementing B23 exactly.
  - `src/util/fs.ts` - `repoRoot()`, `atomicWriteFile(path, data)` (tmp + rename), `resolveCacheDir(opts)` (B24), `resolveRunsDir`, `resolvePuzzlesDir`, `resolveInferenceLogDir`, `ensureDir`.
  - `src/util/log.ts` - the ~60-line leveled logger from the spec's stack table.
  - `src/cli/exit.ts` - `ExitCode` enum and `CliError` per B28.
  - `src/profiles/schema.ts` - `ProfileSchema` (zod) including B22 `sampling`, B44 `budget.tokens`, `promptVersion` default `"1"`, and the refine that forces `temperature: 0.7` when `calibration === "votes"`.
  - `src/events/types.ts` - the `SolverEvent` discriminated union including `grid:init` (B32) and the `tier`/`producedBy` additions to `search:assign` and `repair:accept`.
  - `src/events/levels.ts` - `MIN_LEVEL: Record<SolverEvent["type"], 0|1|2|3>` covering every member (a missing member must be a type error).
  - `src/cli/index.ts` - the full commander tree: `fetch`, `list`, `show`, `solve`, `bench`, `report`, `cache` with every option and help string from the spec's CLI reference, plus global `--config`, `--no-color`, `--json`, and one top-level catch mapping `CliError` to an exit code. Handlers are imported from the stub handler modules.
  - `src/cli/options.ts` - shared option builders and parsers (int, usd, level counting for `-v/-vv/-vvv`).
  - `src/puzzle/loader.ts` - the dispatcher (extension -> adapter) and `src/puzzle/adapters/index.ts` - the adapter registry. Both real, ~20 lines each, so no later task edits them.
  - `src/sources/registry.ts` - the `id -> SourceAdapter` registry, real.

  Type-only contract modules (real types, no behaviour):
  - `src/puzzle/types.ts` - `Direction`, `PuzzleStyle`, `Cell`, `Slot` (with `enumeration`), `Puzzle` (no `solution`), `PuzzleWithSolution extends Puzzle { solution: string[][] }` (B11), `NormalisedPuzzleFile` (B16: `PuzzleWithSolution & { schemaVersion: 1; fetchedAt: string }`), `parsedBy` union including `"guardian-json"` (B17).
  - `src/grid/types.ts` - `Crossing { otherSlotId; offsetInThis; offsetInOther }` (B18), `GridSnapshot`, `DomainStore` interface (B39).
  - `src/candidates/types.ts` - `Tier`, `RejectReason`, `Purpose`, `Candidate`, `CandidateRequest`, `CandidateResponse`, `BatchedCandidateResponse`, `CandidateService` including `peek(slotId): Candidate[]` (B43).
  - `src/llm/types.ts` - `TokenUsage` (B15), `LlmRequest`, `LlmResult`, `LlmTransport` (B51), `InferenceLogRecord`, `InferenceLog`, `RateLimiter`, `RateLimitSignal`, `RateLimiterState`.
  - `src/policy/types.ts` - `EscalationContext`, `EscalationDecision` (B13), `ResolvedBudget` (B44), `BudgetCap`.
  - `src/solver/types.ts` - `SolveOptions`, `SolveResult`, `SearchHooks` (the interface T37 calls and T38 implements: `onEmptyDomain`, `onCandidatesReturned`, `onSearchTermination`, `chargeBudget`), `SolveDeps` (the record T44 composes: `{ ac3, search, repair, service, grid, domains, emit }`). **This is an addition beyond B52's list, made deliberately so T37 and T38 can run concurrently.**
  - `src/eval/types.ts` - `RunRecord` including B12 `provenance`, B14 `perSlot` additions, B28 `status`/`error`, B2 `usdBilled`/`usdCounterfactual`.
  - `src/sources/types.ts` - `PuzzleRef`, `SourceAdapter`, and the normalise hook signature.
  - `src/validate/types.ts` - `RejectReason` re-export point and `WordList` interface (B35).

  Stub modules - each exports the real signature with a body of `throw new NotImplemented("<file>")` (`NotImplemented` lives in `src/util/errors.ts`, also T0's):
  `src/puzzle/{numbering,enumeration,library}.ts`, `src/puzzle/adapters/{xwordly,xd,guardian}.ts`, `src/grid/{model,domainStore,pattern}.ts`, `src/events/bus.ts`, `src/candidates/{service,cache}.ts`, `src/llm/{client,tierRouter,prompts,parser,pricing,inferenceLog,rateLimiter}.ts`, `src/validate/{normalise,wordlist}.ts`, `src/score/calibrate.ts`, `src/solver/{solve,ac3,search,ordering,repair,hooks}.ts`, `src/policy/{escalation,budget}.ts`, `src/eval/{scorer,runRecorder,aggregate,inference}.ts`, `src/render/{console,watch,jsonl,replay}.ts`, `src/sources/{guardian,xd,file}.ts`, `src/profiles/{builtins,loader}.ts`, `src/util/git.ts`, `src/config.ts`, `src/cli/{fetch,list,show,solve,bench,report,cache}.ts`.

  JSON schemas (real, draft 2020-12, `$id` set):
  - `schemas/candidate-response.schema.json` - both the single and the batched (`{ results: [...] }`) form, one schema with `oneOf`.
  - `schemas/run-record.schema.json`, `schemas/puzzle-index.schema.json` (with B34 `files`, `schemaVersion`, `parsedBy`), `schemas/puzzle.schema.json` (B16).

  Fixtures and contract tests:
  - `test/fixtures/puzzles/synthetic-5x5.json` and `test/fixtures/puzzles/synthetic-7x7.json` (A3), authored **as our normalised JSON** (`NormalisedPuzzleFile`), not as `.ipuz`. Reason: every Wave 1 unit test needs a `Puzzle` object, and the loaders that would turn an `.ipuz` into one do not land until Wave 2; normalised JSON also gets validated against `schemas/puzzle.schema.json` as part of this task, which exercises the schema. Format-specific fixtures (`.ipuz`, `.puz`, `.jpz`, `.xd`) are authored by their own loader tasks in Wave 2 and asserted equal to these two files. The 5x5 has an unchecked cell and a 2-letter entry; the 7x7 has an accented answer and a multi-word enumeration `(3,4)`.
  - `test/contract/schemas.test.ts` - ajv-compiles all four schemas and validates the worked example objects that appear in spec.md (the batched prompt/response pair, an index row, a `RunRecord`) plus both synthetic fixtures.
  - `test/contract/cache-key.test.ts` - the B23 contract test skeleton: a base `CacheKeyInput`, and for every prompt-visible field a mutated copy asserting a different key; for `policy`-only fields (not in the input type) there is nothing to assert, which the test comments record.
  - `test/unit/util/hash.test.ts`, `test/unit/util/fs.test.ts`.

- Reads (must not edit): `docs/spec.md`, `docs/crossword-algorithms.md`, `models.json`.
- Spec sections: all of "Data model", "Candidate service", "Events and verbosity", "Strategy profiles", "Metrics and run records", "CLI reference", "Repository layout".
- Deliverable: a repository that installs, typechecks, lints and runs `npm test` green, where every module named in the spec exists with its real signature and a `NotImplemented` body, every JSON schema validates the spec's own examples, the CLI prints correct help for every subcommand, and the two synthetic puzzles are on disk. No behaviour beyond `util/hash`, `util/fs`, `util/log`, `cli/exit`, `profiles/schema`, `events/levels`, the CLI tree and the two registries.
- Decisions baked in:
  - Rule: **T0 creates every file that two or more later tasks would otherwise both need to edit.** That is why the dispatcher, both registries, every npm script and `.gitignore` are all T0's and are frozen afterwards.
  - `promptVersion` default is the string `"1"` (B23 lists it as a cache-key field; the spec's zod default of `'v1'` is superseded - use `"1"` everywhere).
  - `Crossing.otherSlotId`, cells as `[row, col]`, rendered `r{row}c{col}` (B18).
  - Exit codes exactly B28: OK 0, unexpected 1, USAGE 2, NOT_FOUND 3, OFFLINE_MISS 4, PROVIDER 5, BENCH_PARTIAL 6.
  - `CacheKeyInput` fields exactly and only those in B23, in that order in the type, with `rejected` sorted and `crossingContext` normalised or `null`.
  - `SolverEvent` gets `grid:init` at level 0 (B32).
  - Dependencies are pinned exactly; the lockfile is committed because the container entrypoint hashes it (B48).
- Acceptance:
  1. `npm ci && npm run preflight` passes from a clean checkout.
  2. `npx tsc --noEmit` reports zero errors with `strict` and `noUncheckedIndexedAccess` on.
  3. `test/contract/schemas.test.ts` validates every example object from spec.md against its schema and both synthetic fixtures against `schemas/puzzle.schema.json`.
  4. `test/contract/cache-key.test.ts` proves that changing any one of the B23 fields changes the key, and that reordering the `rejected` array does not.
  5. `node bin/xw.js --help` lists all seven subcommands; `node bin/xw.js solve --help` lists every option in the spec's `solve` line.
  6. Every stub module, when called, throws `NotImplemented` with its own file path in the message.
  7. `MIN_LEVEL` covers every `SolverEvent["type"]`; deleting one entry produces a compile error (assert with a `satisfies Record<SolverEvent["type"], Level>`).
- Out of scope: any behaviour in a stub; Dockerfile and compose (T1); CI (T2); README (T1); the xd fixtures (T48).

## Wave 1: infrastructure and pure modules

Starts once T0 is merged. Every task below reads T0's contracts and owns files no sibling touches.

### T1: Docker image, compose, `./xw` wrapper and README quick start
- Workstream: J (Infrastructure)
- Model: sonnet
- Depends on: T0
- Owns: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `docker/entrypoint.sh`, `xw` (host wrapper, executable), `.env.example`, `README.md`
- Reads (must not edit): `package.json`, `package-lock.json`
- Spec sections: "Stack and development environment", "Quick start", "Repository layout"
- Deliverable: `docker compose up -d` builds a `node:22-slim` image, installs with `npm ci`, `npm link`s the package so `xw` (and the `crossword` alias) is on `PATH` inside the container named `crossword-solver`, and stays up on `sleep infinity`. The entrypoint compares the sha256 of the bind-mounted `package-lock.json` with the hash recorded at `/app/node_modules/.lockhash` and re-runs `npm ci` when they differ, then rewrites the hash (B48). `./xw <args>` execs `docker exec -it crossword-solver xw <args>`. README has the quick start, the `docker compose down -v` note for dependency changes, the B46 line that fetched puzzles are never committed, and the A2 line stating the Guardian adapter is for personal research with a descriptive User-Agent and a 1 rps ceiling.
- Decisions baked in:
  - `node_modules` is a named volume; everything else is the bind mount (spec).
  - No published ports.
  - Container name `crossword-solver` even though the CLI is `xw` (A4).
  - Entrypoint never fails the container on a hash mismatch it cannot fix; it logs and continues.
- Acceptance:
  1. `docker compose build` succeeds.
  2. `docker compose up -d && docker exec crossword-solver xw --version` prints the version from `package.json`.
  3. `docker exec crossword-solver crossword --version` prints the same (alias bin).
  4. Touching `package-lock.json` on the host and running `docker compose restart solver` causes the entrypoint to log `lockfile changed, running npm ci` exactly once; a second restart with no change logs `lockfile unchanged`.
  5. `./xw --help` from the host produces the same output as the `docker exec` form.
  6. `sh -n docker/entrypoint.sh` and `sh -n xw` both pass; the wrapper is `#!/bin/sh` with no bashisms.
- Out of scope: CI (T2); any src change.

### T2: GitHub Actions CI workflow
- Workstream: J (Infrastructure)
- Model: haiku
- Depends on: T0
- Owns: `.github/workflows/ci.yml`
- Reads (must not edit): `package.json`, `Dockerfile`, `docker-compose.yml`
- Spec sections: "Testing" (CI paragraph)
- Deliverable: one workflow on `push` and `pull_request` with exactly two jobs (B48). Job `node`: `actions/checkout`, `actions/setup-node` with `node-version: 22` and `cache: npm`, `npm ci`, `npm run lint`, `npm run typecheck`, `npm test -- --coverage`. Job `image`: `actions/checkout` then `docker compose build` only (no `up`, no tests inside the container). No `NEBIUS_API_KEY` in the environment so the smoke test skips.
- Decisions baked in:
  - Two jobs, not one; the container job builds only (B48), superseding the spec's older single-job description.
  - Jobs run in parallel; neither `needs` the other.
  - Pin action versions to major tags (`actions/checkout@v4`).
- Acceptance:
  1. `yq` or `python -c "import yaml,sys;yaml.safe_load(open('.github/workflows/ci.yml'))"` parses the file.
  2. The file declares exactly two jobs named `node` and `image`.
  3. The `node` job runs lint, typecheck and test as three separate steps, so a failure names the stage.
  4. No step references a secret.
- Out of scope: release workflows; coverage upload services.

### T3: Grid model
- Workstream: B (Grid + DomainStore)
- Model: sonnet
- Depends on: T0
- Owns: `src/grid/model.ts`, `test/unit/grid/model.test.ts`
- Reads (must not edit): `src/grid/types.ts`, `src/puzzle/types.ts`, `test/fixtures/puzzles/*.json`
- Spec sections: "Data model" (grid/model.ts block), "Solver pipeline" (backtracking target)
- Deliverable: the `Grid` class over a `Puzzle`. Builds a cell -> slots index, exposes `slots`, `crossings(slotId)` returning 0..n `Crossing` records (B7 - an unchecked cell contributes no crossing), `isChecked(row, col)`, `letterAt`, `assignmentOf`, `patternFor(slotId)`, `assign`/`unassign` with an explicit trail giving exact undo, `isComplete()` and `snapshot()`. Written tests-first against both synthetic fixtures.
- Decisions baked in:
  - Cells are `[row, col]`, row 0 top, col 0 left; errors and event payloads render a cell as `r{row}c{col}` (B18).
  - `Crossing.otherSlotId` (B18).
  - `assign` throws a `CliError` with `NOT_FOUND`-free semantics (it is a programming error, code 1) when a letter conflicts with an existing fixed letter.
  - `unassign` restores exactly the letters that `assign` wrote and no others: a letter fixed by a crossing assignment survives.
  - The Grid does not know about domains, scores, tiers or the LLM; `regexFor` lives in T5's `pattern.ts` and Grid delegates to it.
- Acceptance:
  1. On `synthetic-5x5`, `crossings("1A")` returns the expected list, and the slot containing the unchecked cell returns a crossing list one shorter than its length.
  2. `isChecked` is false for exactly the one unchecked cell in the 5x5 fixture.
  3. `patternFor` of an unassigned slot is all `?`; after assigning one crossing it has exactly one fixed letter at the right offset.
  4. Assign A, assign B (crossing A), unassign B, then `patternFor(A)` and `snapshot()` are byte-identical to their values before B was assigned.
  5. Assign/unassign in a randomised order 1,000 times (seeded PRNG, no network) and assert `snapshot()` returns to the empty snapshot.
  6. Assigning a conflicting letter throws, and the grid is unchanged after the throw.
  7. `isComplete()` is true only when every non-block cell has a letter.
- Out of scope: domains, scores, AC-3, the regex builder (T5).

### T4: DomainStore with depth-indexed trail
- Workstream: B (Grid + DomainStore)
- Model: opus
- Depends on: T0
- Owns: `src/grid/domainStore.ts`, `test/unit/grid/domainStore.test.ts`
- Reads (must not edit): `src/grid/types.ts`, `src/candidates/types.ts`
- Spec sections: "Solver pipeline" (steps 3-5)
- Deliverable: `DomainStore` per B39. Domains live here, not in `Grid`. It holds a **base domain** per slot and a stack of trailed reductions indexed by search depth. `push(depth)`, `reduce(slotId, keptCandidates, reason)`, `undoTo(depth)`, `get(slotId)`, `merge(slotId, newCandidates)` and `sizeOf(slotId)`. Forward-check and AC-3 reductions are trailed and undone exactly on backtrack; a `merge` (a re-ask or escalation result) goes into the **base** domain and therefore survives every subsequent `undoTo`; the pattern filter is re-applied at each node rather than trailed.
- Decisions baked in:
  - `merge` de-duplicates on the normalised answer, keeping the higher `score` and summing `votes`, matching the validation chain's dedupe rule.
  - `undoTo(d)` is idempotent and undoing to a depth above the current depth is a no-op, not an error.
  - The store never mutates a `Candidate` object; reductions produce new arrays.
  - A wipeout is a domain of length 0; the store reports it but does not decide policy.
- Acceptance:
  1. reduce at depth 3, reduce at depth 4, `undoTo(3)` restores exactly the depth-4 domain and leaves the depth-3 reduction in place.
  2. `merge` at depth 5, then `undoTo(0)`, then `get` still contains the merged candidates (B39).
  3. Merging a candidate already present sums votes and keeps the higher score; array length does not grow.
  4. 500 randomised reduce/undo operations (seeded) end with `get` equal to the base domain for every slot.
  5. `undoTo` at a depth with no recorded frames is a no-op.
  6. Reducing to zero candidates is allowed and `sizeOf` returns 0.
- Out of scope: AC-3 (T36); search (T37); who calls `merge` (T38).

### T5: Pattern string and regex builder
- Workstream: B (Grid + DomainStore)
- Model: sonnet
- Depends on: T0
- Owns: `src/grid/pattern.ts`, `test/unit/grid/pattern.test.ts`
- Reads (must not edit): `src/grid/types.ts`
- Spec sections: "Data model" (`patternFor`, `regexFor`), algorithms doc "Problem model"
- Deliverable: `buildPattern(letters: (string|null)[]): string` producing `A?I?N`, `regexFromPattern(pattern: string): RegExp` producing `/^A[A-Z]I[A-Z]N$/`, `patternMatches(pattern, word): boolean`, `isFullyFixed(pattern)` and `fixedLetterCount(pattern)`. Regexes are memoised in a `Map` keyed by the pattern string.
- Decisions baked in:
  - `?` is the only wildcard character; a pattern containing anything but `A-Z` and `?` throws.
  - Regexes are anchored and case-sensitive on uppercase; the caller normalises first.
  - `patternMatches` is the hot path; it must not allocate a new RegExp per call.
- Acceptance:
  1. `buildPattern(["A",null,"I",null,"N"]) === "A?I?N"`.
  2. `regexFromPattern("A?I?N").source === "^A[A-Z]I[A-Z]N$"`.
  3. ALIEN matches, ALARM/ACORN/AMEND do not.
  4. An all-`?` pattern of length 5 matches any 5-letter A-Z string and rejects a 4- and a 6-letter one.
  5. Two calls with the same pattern return the identical RegExp object (memoisation).
  6. `regexFromPattern("A-IN")` throws.
  7. `fixedLetterCount("A?I?N") === 3`, `isFullyFixed("ALIEN") === true`.
- Out of scope: applying the pattern to domains (T4/T36/T37).

### T6: Normalisation and validation chain
- Workstream: A (Puzzle loading / validation)
- Model: sonnet
- Depends on: T0
- Owns: `src/validate/normalise.ts`, `test/unit/validate/normalise.test.ts`
- Reads (must not edit): `src/validate/types.ts`, `src/candidates/types.ts`, `src/grid/pattern.ts` (import only)
- Spec sections: "Candidate service" step 4, algorithms doc "Deterministic validation and filtering"
- Deliverable: `normaliseAnswer(raw: string): string` and `validateCandidates(input): { accepted: Candidate[]; rejects: Array<{ answer: string; raw: string; reason: RejectReason }> }` running the chain in this exact order: normalise (uppercase; strip spaces, hyphens, apostrophes and punctuation; NFD-decompose and drop combining marks) -> reject remaining non `A-Z` (`charset`) -> length check against `slot.length` (`length`) -> pattern regex test (`pattern`) -> dedupe on the normalised string keeping the higher score and summing votes (`duplicate`) -> clue-echo rejection (`clue-echo`) -> persistent rejection set (`rejected-before`).
- Decisions baked in:
  - Clue echo compares the normalised answer against the normalised clue (same normaliser) and rejects on equality **or** containment; it is waived when waiving it is the only way to leave the slot non-empty, and the waiver is reported in the return value so the caller can emit the event.
  - The function is pure: it emits nothing and reads no clock. The caller turns each reject into a `candidate:reject` event.
  - Dedupe happens after the length and pattern filters so a rejected duplicate does not shadow an accepted one.
  - Ligatures and sharp-s are out of scope for v1: any character that survives NFD and is not `A-Z` is a `charset` reject.
- Acceptance:
  1. `normaliseAnswer("Nano Banana") === "NANOBANANA"`; `normaliseAnswer("A-lister") === "ALISTER"`; and both the precomposed form `"An\u00e1lisis"` and the decomposed form `"Ana\u0301lisis"` normalise to `"ANALISIS"` (write the two inputs as escapes in the test source, never as literal accented characters).
  2. A candidate containing a digit is rejected with `charset`; one containing an emoji likewise.
  3. Every one of the six `RejectReason` values is produced by at least one test case, each asserted individually.
  4. `A-lister` and `ALISTER` in the same list dedupe to one candidate with summed votes and the higher score.
  5. Clue `"Add zest to"` with candidate `ADDZEST` rejects as `clue-echo`; the same input with `allowEchoWhenEmpty: true` and no other survivor accepts it and sets the waiver flag.
  6. A candidate in the slot's rejection set is dropped as `rejected-before` even when it would otherwise pass.
  7. Ordering test: an over-length candidate that is also a clue echo reports `length`, not `clue-echo`.
- Out of scope: the word list (T43); calibration (T13); event emission.

### T7: Clue numbering recompute, slot extraction and enumeration
- Workstream: A (Puzzle loading)
- Model: sonnet
- Depends on: T0
- Owns: `src/puzzle/numbering.ts`, `src/puzzle/enumeration.ts`, `test/unit/puzzle/numbering.test.ts`, `test/unit/puzzle/enumeration.test.ts`
- Reads (must not edit): `src/puzzle/types.ts`, `test/fixtures/puzzles/*.json`
- Spec sections: "Data model", B19/B20/B21 behaviour as written into the spec's loader section
- Deliverable: `computeNumbering(blocks: boolean[][], opts: { minRun: number }): { numbers: (number|null)[][]; runs: RunSpec[] }` implementing B19 - a white cell starts a number when it begins an across run of at least `minRun` or a down run of at least `minRun`; numbers run left to right, top to bottom, from 1. `buildSlots(numbering, clues, opts)` attaches clue text and drops any run with no clue in the source clue list (B20). `assertNumberingMatches(computed, supplied)` throws a load error (exit 3) naming the first divergent cell as `r{row}c{col}` (B19). Separately, `extractEnumeration(clueText: string): string | undefined` matching a trailing `(3,4)`-style group (B21), with `normaliseEnumeration` for a structured source field.
- Decisions baked in:
  - `minRun` defaults to 2 (B20) and is a parameter, not a constant, because styles differ.
  - Enumeration is prompt-only and never affects validation; the clue text is kept verbatim including its trailing group.
  - The enumeration regex accepts digits separated by `,`, `-`, or a space inside a single trailing parenthesised group, optionally with a trailing word like `(3,4) hyphenated`; anything else returns `undefined`.
  - Divergence is reported cell-first, not slot-first, so the message points at the grid.
- Acceptance:
  1. On `synthetic-5x5` the recomputed numbers equal the `number` fields in the fixture cells.
  2. On `synthetic-7x7` the recomputed numbers equal the fixture, and the multi-word slot's `enumeration` is `"(3,4)"`.
  3. A 3x3 all-white grid with `minRun: 2` numbers cells 1,2,3 on the top row and 4,6 down the left column per the rule, asserted as an explicit expected matrix.
  4. A run of length 1 never produces a slot at `minRun: 2`; a run of length 2 does.
  5. A run with no matching clue is dropped and is absent from the returned slots.
  6. `assertNumberingMatches` with a deliberately shifted supplied number throws with a message containing `r1c2` (or the correct cell for the fixture used).
  7. `extractEnumeration("Dinner dish (5)") === "(5)"`; `extractEnumeration("Buttoned up (6,2,3)") === "(6,2,3)"`; `extractEnumeration("Nothing here")` is `undefined`; `extractEnumeration("Prize (see 4 down)")` is `undefined`.
- Out of scope: reading any file format (T24/T25/T26); the Grid (T3).

### T8: Pricing from models.json
- Workstream: D (Transport)
- Model: sonnet
- Depends on: T0
- Owns: `src/llm/pricing.ts`, `test/unit/llm/pricing.test.ts`, `test/fixtures/models.min.json`
- Reads (must not edit): `models.json`, `src/llm/types.ts`
- Spec sections: "Candidate service" (pricing paragraph), B29
- Deliverable: load `models.json` once into a `Map<string, ModelEntry>`; expose `priceOf(model)`, `capabilitiesOf(model)` returning `{ supportsStructuredOutputs: boolean; supportsReasoning: boolean; supportedSamplingParameters: string[] }` for B9's use, `limitsOf(model)` returning `{ requestsPerMinute, tokensPerMinute, burstRatio }` for T9, and `usdFor({ model, promptTokens, completionTokens, calls })` implementing the B29 formula: `Math.round(1e9 * (promptTokens * Number(p.prompt) + completionTokens * Number(p.completion) + calls * Number(p.request))) / 1e9`. A model id absent from `models.json` throws a startup error, never a zero price. Ships `test/fixtures/models.min.json` - a hand-trimmed 3-model file used by every test that needs pricing, so tests do not break when `models.json` is refreshed.
- Decisions baked in:
  - Prices are decimal strings in the catalogue and are converted with `Number()` at the leaf, exactly as B29 writes it; token counts are accumulated as integers by callers and priced once at write time.
  - Reasoning tokens are billed as completion tokens (B29) and logged separately in `TokenUsage.reasoningTokens`.
  - `capabilitiesOf` reads `supported_features`; `structured_outputs` present means json_schema mode is available (B9).
  - The loader is memoised per path; `loadPricing(path?)` allows tests to inject `models.min.json`.
- Acceptance:
  1. `capabilitiesOf("nvidia/Nemotron-3_5-Lightning")` returns `supportsStructuredOutputs: false`, `supportsReasoning: true` against the real `models.json`.
  2. `capabilitiesOf("deepseek-ai/DeepSeek-V4-Pro")` returns both true.
  3. `limitsOf("nvidia/Nemotron-3_5-Lightning")` returns 600 rpm / 400000 tpm; DeepSeek-V4-Pro returns 3000 / 1000000.
  4. Hand-computed price check: 1,000 prompt and 500 completion tokens on Nemotron (`0.00000006` / `0.00000024`) is `0.00018` exactly, asserted with `toBe`, not `toBeCloseTo`.
  5. The same call on DeepSeek-V4-Pro (`0.00000175` / `0.0000035`) is `0.0035` exactly.
  6. `usdFor` with an unknown model id throws with the model id in the message.
  7. Rounding: an input producing more than 9 decimal places is rounded to 9 and the assertion pins the exact value.
- Out of scope: accumulating tokens (T33/T17); the counterfactual split (T17).

### T9: Per-model rate limiter with AIMD
- Workstream: D (Transport)
- Model: sonnet
- Depends on: T0, and reads T8's `limitsOf` through its module import (both are Wave 1; import the module, do not copy the numbers - if T8 is not yet merged locally, code against the T0 stub signature)
- Owns: `src/llm/rateLimiter.ts`, `test/unit/llm/rateLimiter.test.ts`
- Reads (must not edit): `src/llm/types.ts`, `src/llm/pricing.ts`
- Spec sections: "Rate limiting"
- Deliverable: `RateLimiterRegistry` (a process-wide singleton keyed by model id) handing out `RateLimiter` instances. Each holds a requests-per-second token bucket seeded at `rpsFraction` (default 0.9) of the catalogue RPM / 60, a tokens-per-minute bucket at the same fraction of catalogue TPM sized against `estimatedTokens`, and a `maxConcurrency` gate. `acquire(estimatedTokens)` resolves when both buckets and the concurrency gate allow. `observe(signal)` applies AIMD: on 429 halve the rps with a floor of 1, on 10 seconds with no 429 add 0.5 rps back up to the ceiling. `parseRateLimitHeaders(headers): RateLimitSignal` reads the seven OpenAI-compatible headers, all optional. `snapshot()` returns `RateLimiterState`.
- Decisions baked in:
  - All timing goes through an injectable `now()` and `setTimeout`, so tests use vitest fake timers and the suite has no real sleeps.
  - The registry is module-level state with a `resetRegistryForTests()` export; every test calls it in `beforeEach`.
  - `acquire` is FIFO; queued callers are released in arrival order so a burst does not starve.
  - Header parsing treats a missing header as `undefined`, never as 0, and accepts both `1s`/`60ms` duration strings and plain millisecond integers for the reset headers.
  - The limiter does not retry or back off itself; it only shapes the rate. Retry lives in T33.
- Acceptance:
  1. With rps 10 and fake timers, 20 `acquire()` calls complete in two 1-second windows, 10 in each; assert on the fake clock, not wall time.
  2. Concurrency 8: with 20 acquires outstanding and none released, `snapshot().inFlight === 8` and `queued === 12`.
  3. `observe({ status: 429 })` halves rps; three consecutive 429s floor it at 1, not below.
  4. After a 429, advancing the fake clock 10 s with no further signal raises rps by 0.5; advancing far enough returns it to the ceiling and no further.
  5. `parseRateLimitHeaders` maps all seven headers, returns `{}` for an empty object, and parses `retry-after: "2"` to 2000 ms and `retry-after` as an HTTP-date to a positive number.
  6. The token bucket blocks when `estimatedTokens` would exceed the remaining TPM allowance and releases after the window advances.
  7. Two `getLimiter("m")` calls return the same instance; `getLimiter("n")` returns a different one.
- Out of scope: HTTP (T33); the inference log (T10).

### T10: Inference log writer
- Workstream: D (Transport)
- Model: sonnet
- Depends on: T0
- Owns: `src/llm/inferenceLog.ts`, `test/unit/llm/inferenceLog.test.ts`
- Reads (must not edit): `src/llm/types.ts`, `src/util/fs.ts`
- Spec sections: "Inference log (always on)"
- Deliverable: `openInferenceLog({ dir?, enabled? }): InferenceLog` writing append-only JSONL to `<dir>/<YYYY-MM-DD>.jsonl`, one `InferenceLogRecord` per line, through a single write stream per process per day. `write()` is fire-and-forget: a write failure logs one warning through `util/log` and never throws. `enabled: false` returns a no-op sink. Rolls to a new file when the UTC date changes. `close()` flushes.
- Decisions baked in:
  - Date is UTC, taken from an injectable `now()`.
  - Request headers are never accepted by the record builder; only `responseHeaders` exists, which is how redaction is guaranteed (spec).
  - Cache-hit records carry `cacheHit: true`, `request: null`, `rawResponse: null` and a non-null `parsed` (spec).
  - No rotation, no size cap, no compaction in v1.
  - JSON serialisation uses `JSON.stringify` with no replacer; a record containing a circular reference is a programming error and the warning names the record id.
- Acceptance:
  1. Writing three records to a temp dir produces one file with three lines, each parsing back to a deep-equal object.
  2. Advancing the injected clock past midnight UTC and writing again produces a second file named for the new date; the first file is unchanged.
  3. `enabled: false` writes no file at all and creates no directory.
  4. A record whose `responseHeaders` contains `authorization` is written verbatim, but a redaction test asserts that the record-building helper has no parameter for request headers (a type-level test with `@ts-expect-error`), so the key cannot reach the log.
  5. Making the target directory read-only causes `write()` to resolve without throwing and to log exactly one warning across ten writes.
  6. Two records with the same `id` but different `attempt` both appear, in order.
- Out of scope: the client that produces records (T33); `report --inference` (T41).

### T11: Candidate response parser
- Workstream: E (Prompting + parsing)
- Model: opus
- Depends on: T0
- Owns: `src/llm/parser.ts`, `test/contract/parser.test.ts`, `test/fixtures/responses/*.txt`
- Reads (must not edit): `schemas/candidate-response.schema.json`, `src/candidates/types.ts`
- Spec sections: "Candidate service" step 3, "Batching clues per request", B41
- Deliverable: `parseCandidateResponse(raw: string, opts: { batchSize: number; expectedIds: string[] }): ParseOutcome`. Order of operations: strip `reasoning_content` and any `<think>...</think>` block (B41) -> strip code fences -> scan for the **last** balanced JSON object in the remaining text -> ajv-validate against `schemas/candidate-response.schema.json`. For a batched response, validate **each element independently** and realign by `id`, never by position (spec): a malformed or missing element yields a per-id failure while the rest succeed. Returns `{ byId: Map<string, CandidateResponse>; failures: Array<{ id: string | null; error: string }>; rawUsed: string }`.
- Decisions baked in:
  - Last balanced object, not first (B41), because reasoning-capable models often emit a draft object before the final answer.
  - Balanced-object scanning is a brace counter that respects string literals and escapes; it is not a regex.
  - An element whose `id` is not in `expectedIds` is a failure with that id, not a silent drop, so the batch bench can count it.
  - An expected id absent from the response is a failure with `error: "missing"` for that id.
  - `confidence` of the wrong type fails only that element; `clue_understood` missing defaults to `0` and records a warning rather than failing.
  - The parser never retries and never calls the network; retry-once-at-temperature-0 is T34's job.
- Acceptance (fixtures are authored by hand in this task, one file each, and every one is asserted):
  1. `good-single.txt` - a bare JSON object parses to one response with two candidates.
  2. `fenced.txt` - ```` ```json ```` fenced object parses identically.
  3. `prose-prefix.txt` - a paragraph of prose then the object parses.
  4. `trailing-commentary.txt` - object then prose parses.
  5. `reasoning-wrapped.txt` - `<think>` block containing a *different, wrong* JSON object followed by the real object; the parser returns the real one (this is the test that pins "last balanced object").
  6. `truncated.txt` - an unterminated object yields a single failure with a message naming the unbalanced brace, and does not throw.
  7. `wrong-typed-confidence.txt` - `"confidence": "high"` fails ajv and is reported as a failure.
  8. `batched-good.txt` - three results for ids `1A,5A,7D` realign correctly.
  9. `batched-missing-id.txt` - two results for a batch of three: the two parse, the third is a `missing` failure, and the two are unaffected.
  10. `batched-shuffled.txt` - results in the order `7D,1A,5A` realign to the right ids, proving position is never used.
  11. `answers-with-spaces-and-accents.txt` - answers pass through the parser unchanged (normalisation is T6's job, asserted here as "the parser does not normalise").
- Out of scope: normalisation (T6); the retry (T34); prompt text (T31).

### T12: Candidate cache (disk + LRU, with negatives)
- Workstream: F (Candidate service)
- Model: sonnet
- Depends on: T0
- Owns: `src/candidates/cache.ts`, `test/unit/candidates/cache.test.ts`
- Reads (must not edit): `src/util/hash.ts`, `src/util/fs.ts`, `test/contract/cache-key.test.ts`
- Spec sections: "Candidate service" step 1, B23, B24
- Deliverable: `openCandidateCache(opts): CandidateCache` with `get(key)`, `set(key, entry)`, `stats()` and `clear(filter)`. Two layers: an in-process LRU of 2,000 entries and a disk cache at `<cacheDir>/<first2>/<sha1>.json` holding `{ key, model, promptVersion, promptKind, clue, length, pattern, style, sampleIndex, batchSize, response, usage, latencyMs, createdAt }`. Negative results (zero valid candidates) are stored in the same shape so a known dead end is never re-paid for. Cache dir resolution is `--cache-dir` > `$CROSSWORD_CACHE_DIR` > `./cache/candidates` (B24) via `util/fs`. No eviction on disk; `stats()` reports entry count, bytes and a warning flag above 1 GB.
- Decisions baked in:
  - The key is produced only by `util/hash.cacheKey` (B23); this module never builds a key itself, so the contract test in T0 governs both.
  - Disk writes are atomic (tmp + rename) through `util/fs`, so a killed process never leaves a half-written entry.
  - A corrupt or unparseable disk entry is treated as a miss and the file is left in place (not deleted), with one warning.
  - `stats()` walks the directory lazily and caches the result for the process lifetime unless `refresh: true`.
- Acceptance:
  1. `set` then `get` returns a deep-equal entry; a second `get` is served from the LRU (assert the disk read count via an injected fs spy).
  2. A cold process (new cache instance, same dir) `get` reads from disk and repopulates the LRU.
  3. A negative entry (`response.candidates` empty) is stored, returned as a hit, and is distinguishable from a miss.
  4. LRU eviction at 2,001 entries drops the least recently used and a subsequent `get` still hits disk.
  5. `resolveCacheDir` precedence is asserted for all three sources (flag, env, default) in one table-driven test.
  6. A file with invalid JSON at the expected path produces a miss plus exactly one warning, and the file still exists afterwards.
  7. `stats()` on a directory over the 1 GB threshold (simulated with an injected size function) sets the warning flag.
- Out of scope: offline behaviour (T34); the `cache` subcommand (T35).

### T13: Rank calibration
- Workstream: F (Candidate service)
- Model: sonnet
- Depends on: T0
- Owns: `src/score/calibrate.ts`, `config/calibration.json`, `test/unit/score/calibrate.test.ts`
- Reads (must not edit): `src/candidates/types.ts`, `src/profiles/schema.ts`
- Spec sections: "Candidate service" step 5
- Deliverable: `calibrate(candidates, { mode, samples, weights }): Candidate[]` returning candidates with `score` set. `rank` mode (the v1 default) is fully implemented: `score = 1 / (2 + rank)`. `votes` and `blend` modes throw `NotImplemented` (they are M6, T53). Ships `config/calibration.json` with the placeholder weights `[0.5, 0.4, 0.1]` and a loader for them so T53 has somewhere to write fitted values.
- Decisions baked in:
  - `rank` is the 0-based position in the model's list, preserved through validation; dedupe keeps the lower rank.
  - `clue_understood` is never used as a score, only as a routing signal (spec).
  - `selfConfidence` is clamped to [0,1] at parse time and stored but unused by `rank`.
  - The two unimplemented modes throw rather than silently falling back to `rank`, so a mis-set profile fails loudly.
- Acceptance:
  1. Ranks 0,1,2 produce scores 0.5, 1/3, 0.25 exactly.
  2. Scores are strictly decreasing in rank and the returned array order is unchanged.
  3. `mode: "votes"` throws `NotImplemented` with "M6" in the message; likewise `blend`.
  4. `config/calibration.json` parses and its weights sum to 1.0.
  5. An empty candidate list returns an empty array without throwing.
- Out of scope: fitting weights (T53); the profile refine that forces temperature 0.7 (T0).

### T14: ConsoleRenderer and the shared events fixture
- Workstream: H (Renderers)
- Model: sonnet
- Depends on: T0
- Owns: `src/render/console.ts`, `test/unit/render/console.test.ts`, `test/fixtures/events/full-run.events.jsonl`
- Reads (must not edit): `src/events/types.ts`, `src/events/levels.ts`
- Spec sections: "Events and verbosity", "Renderers" (ConsoleRenderer bullet), B31, B32
- Deliverable: `ConsoleRenderer(level: 0|1|2|3, stream)` printing one line per accepted event, prefixed with elapsed ms and slot id where the event has one. Level 0 additionally prints the final grid, the diff against the solution (wrong letters in red, empty cells as `.`) and the score and cost blocks. Filtering is driven by `MIN_LEVEL`, never by a switch in the renderer. **This task also authors `test/fixtures/events/full-run.events.jsonl`**, the canonical hand-written event stream that T39 (WatchRenderer) and T51 also read: a complete small run over the 5x5 synthetic puzzle covering `run:start`, `grid:init`, both `phase:*`, `slot:ask`, `slot:candidates`, `candidate:reject`, `ac3:reduce`, `ac3:wipeout`, `search:assign` (with `tier` and `producedBy`), `search:forwardcheck`, `search:backtrack`, `slot:reask`, `slot:escalate`, `lds:restart`, `repair:propose`, `repair:accept`, `budget:hit`, `progress`, `score:final`, `cost:summary`, `grid:final`, `run:end` - at least one of every event type in the union.
- Decisions baked in:
  - `NO_COLOR` and `--no-color` are respected via `chalk`'s own detection plus an explicit `colour: boolean` option (B31).
  - Terminal width defaults to 80 when `process.stdout.columns` is undefined (B31).
  - The renderer writes to an injected stream, never to `process.stdout` directly, so tests capture output as a string.
  - Every line is ASCII; the grid uses `#` for blocks and `.` for empty.
- Acceptance:
  1. Replaying the fixture at level 0 emits lines only for events whose `MIN_LEVEL` is 0, asserted by counting.
  2. Level 2 output is a strict superset of level 1, which is a strict superset of level 0 (assert by set inclusion of the emitted event seq numbers).
  3. Level 3 emits a line for every event in the fixture.
  4. With `colour: false` the output contains no ESC byte (0x1b).
  5. The level-0 final block contains the grid, a diff line marking the one wrong letter the fixture contains, and the score and cost blocks with the fixture's numbers.
  6. The fixture file contains at least one event of every `SolverEvent["type"]`; the test asserts this by comparing the set of types in the file against `Object.keys(MIN_LEVEL)` and fails if any is missing.
  7. Every line of the fixture parses as JSON and validates as a `SolverEvent` (a type-guard test).
- Out of scope: the watch renderer (T39); the run recorder (T17).

### T15: EventBus, JsonlEventSink and replay
- Workstream: H (Renderers)
- Model: sonnet
- Depends on: T0
- Owns: `src/events/bus.ts`, `src/render/jsonl.ts`, `src/render/replay.ts`, `test/unit/render/jsonl.test.ts`, `test/unit/events/bus.test.ts`, `test/fixtures/events/minimal.events.jsonl`
- Reads (must not edit): `src/events/types.ts`, `src/events/levels.ts`
- Spec sections: "Renderers" (JsonlEventSink, replay), "Events and verbosity"
- Deliverable: `EventBus` with `on(handler)`, `off(handler)` and `emit(event)` - synchronous, ordered, and it stamps `seq` and `tMs` so no producer has to. `JsonlEventSink(path)` appending each event as one JSON line. `replay(path, handler)` reading a `.events.jsonl` back and calling the handler in file order, so any renderer can consume an old run. Ships its own tiny `minimal.events.jsonl` (a `run:start` / `grid:init` / `run:end` triple) so this task does not depend on T14's fixture.
- Decisions baked in:
  - `seq` starts at 0 and increments per emit; `tMs` is elapsed milliseconds since bus construction, from an injectable `now()`.
  - A throwing handler is caught, logged once, and does not stop other handlers or the run.
  - `replay` does not re-stamp `seq`/`tMs`; it hands back exactly what was recorded.
  - The sink flushes on `run:end` and on `close()`; it never buffers more than one line.
- Acceptance:
  1. Three handlers registered receive events in registration order, and `seq` is 0,1,2 across three emits.
  2. A handler that throws does not prevent the next handler from receiving the same event, and exactly one warning is logged.
  3. `off` removes a handler; it receives no further events.
  4. Sink then replay round-trips `minimal.events.jsonl` to deep-equal objects in the same order.
  5. Replaying a file with a trailing blank line succeeds; replaying a file with a malformed line reports the line number and continues.
  6. `tMs` is monotonic non-decreasing across a replayed stream.
- Out of scope: which events exist (T0); rendering (T14, T39).

### T16: Scorer
- Workstream: I (Eval)
- Model: sonnet
- Depends on: T0
- Owns: `src/eval/scorer.ts`, `test/unit/eval/scorer.test.ts`
- Reads (must not edit): `src/puzzle/types.ts`, `src/grid/types.ts`, `test/fixtures/puzzles/*.json`
- Spec sections: "Solver pipeline" step 8, "Metrics and run records"
- Deliverable: `score(snapshot: GridSnapshot, solution: string[][], slots: Slot[]): Accuracy` returning `{ letters, words, perfect, emptyCells }`. `letters` is correct letters over non-block cells; `words` is correct slots over all slots; `perfect` is true only when every non-block cell is correct and none is empty; `emptyCells` counts unfilled non-block cells. Also `diff(snapshot, solution)` returning the per-cell right/wrong/empty matrix the renderers print.
- Decisions baked in:
  - An empty cell counts as incorrect for `letters`, not as excluded.
  - A slot is correct only when every one of its cells is correct; a partially filled slot is incorrect.
  - Accuracy values are fractions in [0,1]; a puzzle with zero slots returns `words: 1` and is flagged in a comment as unreachable in practice.
  - The scorer is the only module that ever sees the solution, and it takes it as an argument rather than loading it.
- Acceptance:
  1. A perfect fill on `synthetic-5x5` gives `letters: 1`, `words: 1`, `perfect: true`, `emptyCells: 0`.
  2. One wrong letter gives `perfect: false`, `letters` equal to `(n-1)/n` for the fixture's exact non-block cell count (assert the literal fraction), and `words` reduced by exactly the slots through that cell.
  3. An empty grid gives `letters: 0`, `words: 0`, `emptyCells` equal to the non-block cell count.
  4. A grid where one slot is complete and correct and the rest empty gives the exact expected `words` fraction.
  5. `diff` marks exactly the wrong cells and exactly the empty cells, asserted as two coordinate lists.
  6. Coverage for this file is at or above 95% lines (the spec's target).
- Out of scope: reading solutions from disk (T21); the run record (T17).

### T17: RunRecord builder
- Workstream: I (Eval)
- Model: sonnet
- Depends on: T0
- Owns: `src/eval/runRecorder.ts`, `src/util/git.ts`, `test/unit/eval/runRecorder.test.ts`
- Reads (must not edit): `src/eval/types.ts`, `src/events/types.ts`, `schemas/run-record.schema.json`, `test/fixtures/events/full-run.events.jsonl` (T14's, read-only)
- Spec sections: "Metrics and run records", "Renderers" (RunRecorder), B2, B12, B14, B25, B28, B30
- Deliverable: `RunRecorder` - an event handler that accumulates a `RunRecord` and writes it to `--out` (default `runs/<runId>.json`) on `run:end`, then upserts `puzzles/index.json` through T21's library writer. Includes `makeRunId(...)` per B25 (`${puzzleId}--${profileName}--${YYYYMMDD}T${HHmmss}Z--${shortHash}`, shortHash = first 8 hex of `sha1(canonicalJson(profile) + gitCommit + repeatIndex)`, with `puzzleId` and `profileName` constrained to `[A-Za-z0-9._-]+`) and `src/util/git.ts` implementing B30: read `.git/HEAD`, follow refs, fall back to `packed-refs`, then `$GIT_COMMIT`, then `"unknown"`, never throwing and never invoking a git binary.
- Decisions baked in:
  - `profile` is the resolved `Profile` object, with `provenance` a sibling field (B12): `{ gitCommit, nodeVersion, packageVersion, profileSource }`. No `gitDirty`.
  - `calls` carries both `usdBilled` and `usdCounterfactual` (B2); a cache hit contributes 0 to billed and its cached usage blob's price to counterfactual.
  - `perSlot` carries the B14 additions: `batchIndex`, `truthInCandidates`, `truthRank`, `rejectCounts`, `parseFailures`, `latencyMs`, `usd`.
  - `status` is `"ok" | "partial" | "error"` with `error?` (B28); a budget hit alone makes it `"partial"`, not `"error"`.
  - A character not matching `[A-Za-z0-9._-]` in a puzzle or profile name is replaced with `-` before the run id is built, and the substitution is recorded in the record.
- Acceptance:
  1. Feeding `full-run.events.jsonl` through the recorder produces a `RunRecord` that validates against `schemas/run-record.schema.json`.
  2. The produced record's `search.backtracks`, `repair.accepted` and `calls.tier1.count` equal the counts of the corresponding events in the fixture, asserted as literals.
  3. `makeRunId` is deterministic: two calls with identical inputs are equal; changing `repeatIndex` changes the short hash.
  4. A puzzle id containing `/` is sanitised to `-` and the run id matches `^[A-Za-z0-9._-]+--[A-Za-z0-9._-]+--\d{8}T\d{6}Z--[0-9a-f]{8}$`.
  5. `readGitCommit` returns the 40-hex commit for a fixture `.git` directory laid out as a loose ref, and again for one laid out as `packed-refs`; with neither and no `$GIT_COMMIT` it returns `"unknown"` without throwing.
  6. A run with a `budget:hit` event and a complete fill produces `status: "partial"`.
  7. `usdCounterfactual >= usdBilled` for a stream containing cache hits, and equals it for a stream with none.
- Out of scope: aggregating across runs (T40); writing the index (T21 owns the writer; this task calls it).

### T18: Escalation policy
- Workstream: G (Solver)
- Model: sonnet
- Depends on: T0
- Owns: `src/policy/escalation.ts`, `test/unit/policy/escalation.test.ts`
- Reads (must not edit): `src/policy/types.ts`, `src/profiles/schema.ts`
- Spec sections: "Solver pipeline" step 6, algorithms doc "Escalation to the stronger model", B13
- Deliverable: the pure function `decide(ctx: EscalationContext): EscalationDecision` (B13), consulted after every `getCandidates` return and once at search termination. It owns all escalation caps. Triggers in precedence order: (1) tier 1 returned unparseable JSON twice, or zero valid candidates after validation; (2) a domain is empty after pattern filtering **and** one constrained re-ask has already been tried; (3) `clue_understood` below `clueUnderstoodThreshold` on the first pass; (4) the same slot has caused three or more wipeouts; (5) a slot is still empty when search terminates. Returns `{ action: "none" | "reask" | "escalate" | "give-up"; trigger?: 1|2|3|4|5; reason: string }`.
- Decisions baked in:
  - Precedence is strictly 1 > 2 > 3 > 4 > 5; the first matching trigger wins and the rest are not evaluated.
  - The three built-in policies change only the mapping from trigger to action: `reask-first` (default) prefers `reask` while `reasksPerSlot` remains; `eager` returns `escalate` on the first wipeout and never `reask` (its profile sets `reasksPerSlot: 0`); `patient` returns `reask` while re-asks remain and `escalate` only on trigger 5.
  - Caps checked before any action: `maxTier2CallsPerPuzzle`, `escalationsPerSlot`, `reasksPerSlot`. A cap that blocks the chosen action downgrades it (`escalate` -> `reask` -> `none`), and the reason string names the cap.
  - `give-up` is returned only at search termination when no action remains and the slot is still empty.
  - The function reads no clock, no config file and no global state; every input is in `ctx`.
- Acceptance:
  1. A table-driven test with one row per trigger (five rows) x three policies (15 cases) asserting `action` and `trigger` for each, written as an explicit expected table in the test file.
  2. Trigger 1 wins over trigger 3 when both hold (precedence).
  3. With `maxTier2CallsPerPuzzle` exhausted, a trigger-2 context returns `reask` (downgraded), and the reason contains `maxTier2CallsPerPuzzle`.
  4. With both tier-2 and re-asks exhausted, the same context returns `none` with a reason naming both caps.
  5. `eager` with `reasksPerSlot: 0` never returns `reask` for any of the five triggers.
  6. At search termination with an empty slot and all caps spent, the result is `give-up` with trigger 5.
  7. `decide` is referentially transparent: called twice with the same frozen context it returns deep-equal results and does not mutate the context (assert with `Object.freeze`).
- Out of scope: calling the service (T38); budget accounting (T19).

### T19: Budget policy
- Workstream: G (Solver)
- Model: sonnet
- Depends on: T0
- Owns: `src/policy/budget.ts`, `test/unit/policy/budget.test.ts`
- Reads (must not edit): `src/policy/types.ts`, `src/profiles/schema.ts`
- Spec sections: "Solver pipeline" (budget-cap behaviour), B44
- Deliverable: `resolveBudget(profile): ResolvedBudget` (B44) deriving the caps from a `Profile`, including `budget.tokens`, and a `BudgetTracker` accumulating USD, tokens, tier-2 calls, backtracks, repair calls and wall-clock. `charge(kind, amount)` returns `{ exceeded: BudgetCap | null }`. Hitting a cap is reported, never thrown: the caller emits `budget:hit` and ends the current phase gracefully.
- Decisions baked in:
  - Token counts are integers; USD is derived by the caller from T8's pricing at write time (B29), so the tracker holds tokens and a running USD figure supplied to it, not a price computation.
  - Wall-clock uses an injectable `now()`.
  - A cap of 0 means "disallowed", not "unlimited"; `undefined` means unlimited. `tier1-only`'s `maxTier2CallsPerPuzzle: 0` therefore blocks all tier-2 calls.
  - `charge` is monotonic: it records the charge even when it exceeds, so the run record's `actual` is truthful.
  - Multiple caps exceeded by one charge report the first in a fixed declared order (usd, tokens, tier2Calls, backtracks, repairCalls, wallMs).
- Acceptance:
  1. `resolveBudget` on the `baseline` built-in returns the spec defaults (usd 0.5, wallMs 900000, tier-2 calls 15, backtracks 200, repair calls 30) asserted as literals.
  2. Charging under a cap returns `exceeded: null`; the charge that crosses it returns that cap; a further charge still returns that cap and the recorded actual keeps growing.
  3. A cap of 0 for `tier2Calls` makes the first charge exceed.
  4. `undefined` for a cap never exceeds after 10,000 charges.
  5. Wall-clock exceeds when the injected clock passes `wallMs`, with no charge call at all.
  6. Two caps crossed by one charge report the earlier one in the declared order.
  7. `snapshot()` returns every counter and is safe to embed in a `budget:hit` payload.
- Out of scope: emitting events (T38/T44); escalation decisions (T18).

### T20: Variable ordering
- Workstream: G (Solver)
- Model: sonnet
- Depends on: T0
- Owns: `src/solver/ordering.ts`, `test/unit/solver/ordering.test.ts`
- Reads (must not edit): `src/candidates/types.ts`, `src/grid/types.ts`
- Spec sections: "Solver pipeline" step 4, algorithms doc "Dr.Fill"
- Deliverable: `chooseSlot(unassigned, domains, grid, opts: { ordering: "margin" | "mrv"; rng })` returning the slot to branch on. `margin` (default) maximises `bestScore - secondBestScore`, ties broken by fewest surviving candidates, then most unassigned crossings, then a seeded PRNG draw. `mrv` swaps the primary key for domain size (ablation). Also `marginOf(domain): number` (a single-candidate domain has margin `bestScore`; an empty domain has margin `-Infinity`) and `orderValues(domain)` returning candidates in descending score with a stable tie-break on rank.
- Decisions baked in:
  - The final tie-break is a seeded PRNG (B38) so runs are reproducible; the PRNG is injected, never `Math.random`.
  - A single-candidate domain has the largest possible margin and is therefore branched on first, which is the intended behaviour (we are certain about it).
  - `orderValues` is stable: equal scores keep the model's original rank order.
  - The module is pure and knows nothing about re-asks, escalation or events.
- Acceptance:
  1. Given three slots with margins 0.3, 0.1, 0.25, `margin` picks the 0.3 slot.
  2. Two slots with equal margin and domain sizes 2 and 5 pick the size-2 slot.
  3. Equal margin and equal size pick the one with more unassigned crossings.
  4. All three keys equal: two calls with the same seeded PRNG pick the same slot; a different seed may pick the other, and the test asserts determinism per seed rather than which one.
  5. `mrv` with margins 0.3/0.1 and sizes 5/2 picks the size-2 slot, proving the primary key changed.
  6. `marginOf` on a one-candidate domain returns that candidate's score; on an empty domain returns `-Infinity`.
  7. `orderValues` on candidates with equal scores preserves rank order.
- Out of scope: the search loop (T37); domain storage (T4).

### T21: Puzzle library - normalised JSON writer and locked index
- Workstream: C (Sources + library)
- Model: sonnet
- Depends on: T0
- Owns: `src/puzzle/library.ts`, `test/unit/puzzle/library.test.ts`
- Reads (must not edit): `schemas/puzzle.schema.json`, `schemas/puzzle-index.schema.json`, `src/util/fs.ts`, `src/puzzle/types.ts`
- Spec sections: "Puzzle library and sources" (Storage paragraph), B16, B33, B34
- Deliverable: `writeNormalised(puzzle: PuzzleWithSolution, opts)` writing `puzzles/<source>/<id>.json` as `PuzzleWithSolution` plus `schemaVersion: 1` and `fetchedAt` (B16), ajv-validated before write. `readNormalised(id)` returning `PuzzleWithSolution`. `loadPuzzle(id)` returning a `Puzzle` with `solution` stripped and `loadSolution(id)` returning the grid (B11) - the two accessors the solver and the scorer use. `upsertIndexRow(row)` and `readIndex()` over `puzzles/index.json`, validated by its schema, with rows carrying `files: { original, normalised }` as repo-relative POSIX paths, `schemaVersion: 1` and `parsedBy` (B34). All index writes go through a single writer serialised by an `O_EXCL` lock file at `puzzles/.index.lock` with a 5 second timeout, then an atomic tmp + rename.
- Decisions baked in:
  - `loadPuzzle` deletes the `solution` key rather than setting it to `undefined`, so a leak is a runtime `undefined` and not a silently-present field.
  - The lock timeout throws a `CliError` with code 1 and a message telling the user to delete `puzzles/.index.lock` if no other process is running.
  - A stale lock is not auto-removed in v1; the message is the remedy.
  - `readIndex()` on a missing file returns `[]` (B33's empty case is the CLI's to render).
  - Paths in `files` are always POSIX, even on Windows, and always relative to the repo root.
- Acceptance:
  1. `writeNormalised` then `readNormalised` round-trips deep-equal, and the written file validates against `schemas/puzzle.schema.json`.
  2. The written file contains `schemaVersion: 1` and an ISO-8601 `fetchedAt`.
  3. `loadPuzzle(id)` returns an object where `"solution" in puzzle === false`; `loadSolution(id)` returns the grid.
  4. Two `upsertIndexRow` calls for the same id produce one row, with the second call's values.
  5. Concurrency: 10 `upsertIndexRow` calls started simultaneously (Promise.all) all land, the final index has 10 rows, and the file is valid JSON at every point (assert by reading it in a tight loop from a second handle during the writes).
  6. With `puzzles/.index.lock` pre-created and held, `upsertIndexRow` throws after the 5 s timeout with a message naming the lock path (use fake timers).
  7. A row missing `files` fails schema validation and is rejected before any write.
- Out of scope: fetching (T27/T28/T29); the `list` renderer (T30).

### T22: File source adapter
- Workstream: C (Sources)
- Model: sonnet
- Depends on: T0
- Owns: `src/sources/file.ts`, `test/unit/sources/file.test.ts`, `test/fixtures/sources/local-sample.xd`
- Reads (must not edit): `src/sources/types.ts`, `src/sources/registry.ts`
- Spec sections: "Puzzle library and sources" (`file` bullet)
- Deliverable: the `file` `SourceAdapter`: `list()` returns exactly one `PuzzleRef` for the given local path or URL, deriving `id` from the basename (sanitised to `[A-Za-z0-9._-]+`), `ext` from the extension, and `source: "file"`. `download(ref)` reads the local file or, for an `http(s)` URL, fetches it through an **injected** fetch function. Rejects an unsupported extension with a `CliError` code 2 naming the accepted set.
- Decisions baked in:
  - `fetch` is injected via the adapter's constructor options so tests use a stub and the suite stays offline; the CLI passes the global `fetch`.
  - A URL with no recognisable extension is a usage error, not a guess.
  - A local path outside the repo root is allowed (this is an import command), but the normalised copy always lands under `puzzles/file/`.
  - Duplicate ids get no automatic suffix: re-importing the same basename overwrites, and the CLI says so.
- Acceptance:
  1. `list({})` for `test/fixtures/sources/local-sample.xd` returns one ref with `id: "local-sample"`, `ext: "xd"`, `source: "file"`.
  2. `download` on that ref returns the file bytes byte-identical to the fixture.
  3. `download` on an `https://` ref calls the injected fetch exactly once with that URL and returns its bytes; the test never touches the network.
  4. An injected fetch returning 404 produces a `CliError` with code 3.
  5. A path ending `.txt` produces a `CliError` code 2 whose message lists `puz, ipuz, jpz, xd, json`.
  6. A basename containing spaces is sanitised into the id and the original name is preserved in `title`.
- Out of scope: parsing the file (T24/T25); writing to the library (T29).

### T23: Profiles - built-ins, resolution and config file
- Workstream: J (Config)
- Model: sonnet
- Depends on: T0
- Owns: `src/profiles/builtins.ts`, `src/profiles/loader.ts`, `src/config.ts`, `test/unit/profiles/builtins.test.ts`, `test/unit/profiles/loader.test.ts`, `test/fixtures/profiles/*.json`
- Reads (must not edit): `src/profiles/schema.ts`, `src/cli/options.ts`
- Spec sections: "Strategy profiles", B8, B26, B27
- Deliverable: `src/profiles/builtins.ts` holding every built-in as a **complete literal object** typed `satisfies Profile` (B8) - `baseline`, `eager-escalation`, `patient`, `no-repair`, `tier1-only`, `strong-only`, `votes3`, `batch1`, `batch2`, `batch3`, `batch5`, `batch8`. `src/profiles/loader.ts` implementing B26 resolution, lowest to highest: zod defaults < named built-in < profile file (a full profile, with `"extends": "<builtin>"` allowed) < `--config` values < explicit CLI flags; it returns the resolved `Profile` plus a `profileSource` string for B12 provenance. `src/config.ts` implementing B27: `--config` > `$CROSSWORD_CONFIG` > `./crossword.config.json` > absent, with schema `{ defaultProfile?, cacheDir?, runsDir?, puzzlesDir?, inferenceLogDir?, wordlistPath?, nebiusBaseUrl? }`, no secrets, never read from `$HOME`.
- Decisions baked in:
  - Built-ins are literal objects, not spreads of `baseline` with overrides, so a reader can see every value (B8). The test asserts each parses and that the intended field differs from `baseline`.
  - `extends` is resolved once, non-recursively: a profile file may extend a built-in but not another file.
  - An unknown key in a profile file is a usage error (zod `.strict()`), because a typo silently ignored is the worst failure mode here.
  - `$HOME` is never consulted for config (B27), and the loader asserts this by construction (no `os.homedir()` import).
  - A `--config` file naming a `defaultProfile` that does not exist is a usage error at load time, not at solve time.
- Acceptance:
  1. Every built-in parses through `ProfileSchema` without error (table-driven over the exported map).
  2. `eager-escalation` has `escalation.policy === "eager"` and `reasksPerSlot === 0`; `patient` has `reasksPerSlot === 3` and `search.maxBacktracks === 500`; `tier1-only` has `maxTier2CallsPerPuzzle === 0`; `votes3` has `calibration === "votes"`, `samples === 3` and (via the B22 refine) `sampling.temperature === 0.7`; `batch5` has `batchSize === 5` and every other field equal to `baseline`.
  3. Resolution order: a five-layer test where each layer sets the same field to a distinct value asserts the winner at each step.
  4. A profile file with `"extends": "patient"` inherits `reasksPerSlot: 3` and overrides what it names.
  5. An unknown key in a profile file produces a `CliError` code 2 naming the key.
  6. Config precedence is asserted for all four sources, including "absent" returning `{}`.
  7. `grep -c "homedir" src/config.ts` is 0 (assert in the test by reading the source file, which pins B27 mechanically).
- Out of scope: using a profile (T44); the `--config` flag wiring in `cli/index.ts` (T0 declared it).

## Wave 2: loaders, sources, transport, prompts, search

Starts once every Wave 1 task is merged.

### T24: Loader adapter for .puz, .ipuz and .jpz
- Workstream: A (Puzzle loading)
- Model: sonnet
- Depends on: T0, T7, T21
- Owns: `src/puzzle/adapters/xwordly.ts`, `test/unit/puzzle/xwordly.test.ts`, `test/fixtures/puzzles/synthetic-5x5.ipuz`, `test/fixtures/puzzles/synthetic-5x5.puz`, `test/fixtures/puzzles/synthetic-5x5.jpz`, `test/fixtures/puzzles/synthetic-7x7.ipuz`
- Reads (must not edit): `src/puzzle/types.ts`, `src/puzzle/numbering.ts`, `src/puzzle/enumeration.ts`, `test/fixtures/puzzles/synthetic-5x5.json`, `test/fixtures/puzzles/synthetic-7x7.json`
- Spec sections: "Stack and development environment" (Puzzle parsing row), "Data model", B19, B21, B42
- Deliverable: parse `.puz`, `.ipuz` and `.jpz` into `PuzzleWithSolution` using `@xwordly/xword-parser`, recomputing clue numbering with T7 (B19) rather than trusting the file, extracting enumeration with T7 (B21), and setting `parsedBy`. **Start by verifying the package's actual API and its output shape on the fixtures you author** - read its types in `node_modules`, write a scratch script, and record what it returns in a comment at the top of the adapter. If the package cannot parse one of the three formats, implement a minimal reader for that format in the same file, say so in a comment and in the PR, and set `parsedBy` accordingly.
- Decisions baked in:
  - Numbering from the file is only ever used for the B19 mismatch check; the numbering the solver uses is always recomputed.
  - The `.puz` fixture is generated by a small committed script inside the test file (or hand-authored bytes with a comment table), not downloaded.
  - `style` comes from the caller (the source adapter), defaulting to `"unknown"`; the loader never guesses American vs cryptic.
  - Solution letters are uppercased and non `A-Z` characters in the solution grid are a load error naming the cell.
  - Rebus squares are out of scope for v1: a cell with a multi-character solution is a load error (exit 3) naming the cell.
- Acceptance:
  1. Parsing `synthetic-5x5.ipuz` produces an object deep-equal to `synthetic-5x5.json` minus `schemaVersion` and `fetchedAt`.
  2. The same for `.puz` and `.jpz`, and for `synthetic-7x7.ipuz`.
  3. B42 leakage post-condition, run over all four fixtures: for every slot, no `Slot.clue` contains any slot's solution as a substring (case-insensitive, after normalisation). This is asserted as its own named test.
  4. A file whose supplied numbering disagrees with the recomputed numbering throws a `CliError` code 3 naming the first divergent cell (build the case by editing a copy of the ipuz in the test).
  5. `parsedBy` is `"@xwordly/xword-parser"` for every format the package handles, and the value documented in the comment for any format it does not.
  6. The 7x7 fixture's multi-word slot carries `enumeration: "(3,4)"` and its clue text is unchanged.
  7. A rebus cell produces a `CliError` code 3 naming the cell as `r{row}c{col}`.
- Out of scope: `.xd` (T25); Guardian JSON (T26); fetching (T27/T28).

### T25: Loader adapter for .xd
- Workstream: A (Puzzle loading)
- Model: sonnet
- Depends on: T0, T7, T21
- Owns: `src/puzzle/adapters/xd.ts`, `test/unit/puzzle/xd.test.ts`, `test/fixtures/puzzles/synthetic-5x5.xd`, `test/fixtures/puzzles/leaky-clues.xd`
- Reads (must not edit): `src/puzzle/types.ts`, `src/puzzle/numbering.ts`, `src/puzzle/enumeration.ts`, `test/fixtures/puzzles/synthetic-5x5.json`
- Spec sections: same as T24, plus B42
- Deliverable: parse the `.xd` text format into `PuzzleWithSolution`. Clue lines in `.xd` carry the answer after a ` ~ ` separator; **strip everything from ` ~ ` onward** before the clue text is stored (B42). Use `xd-crossword-tools` as a reference for the format if helpful, but a hand-written line parser is acceptable and preferred if it is shorter; record which you chose and why in a comment. Recompute numbering with T7 and validate against the file's numbering (B19).
- Decisions baked in:
  - The ` ~ ` strip happens before enumeration extraction, so an enumeration inside the answer part is never picked up.
  - The four-section `.xd` layout (metadata, grid, clues, notes) is parsed by section header; an unknown section is ignored with one warning rather than failing.
  - Metadata keys are case-insensitive; `Title`, `Author`, `Date` and `Editor` map to `Puzzle` fields, everything else is dropped.
  - `parsedBy` is `"xd-crossword-tools"` when that package is used and `"xd-hand"` otherwise; add the value to the `parsedBy` union in a one-line contract-fix PR if you choose the hand parser (see "Merge order and conflict rules").
- Acceptance:
  1. Parsing `synthetic-5x5.xd` produces an object deep-equal to `synthetic-5x5.json` minus `schemaVersion` and `fetchedAt`.
  2. `leaky-clues.xd` is authored with ` ~ ANSWER` on every clue line; after parsing, no clue contains any solution as a substring (the B42 test).
  3. A clue whose visible text legitimately contains a tilde but not ` ~ ` keeps the tilde.
  4. Numbering mismatch throws `CliError` code 3 naming the first divergent cell.
  5. An unknown metadata key is dropped and does not fail the parse.
  6. A grid line whose length differs from the others is a `CliError` code 3 naming the row.
- Out of scope: reading the corpus zip (T27); other formats (T24).

### T26: Guardian JSON puzzle adapter
- Workstream: A (Puzzle loading)
- Model: sonnet
- Depends on: T0, T7, T21
- Owns: `src/puzzle/adapters/guardian.ts`, `test/unit/puzzle/guardian.test.ts`, `test/fixtures/guardian/cryptic-sample.json`
- Reads (must not edit): `src/puzzle/types.ts`, `src/puzzle/numbering.ts`, `src/puzzle/enumeration.ts`
- Spec sections: "Puzzle library and sources", B17, B19, B21, B42
- Deliverable: convert a Guardian crossword JSON payload (`crossword.entries[]`, each with `id`, `number`, `direction`, `position: {x,y}`, `length`, `clue`, `solution`, `separatorLocations`) into `PuzzleWithSolution` with `parsedBy: "guardian-json"` (B17). The block grid is derived by marking every cell covered by an entry as white and the rest as blocks. Numbering is recomputed and checked against the payload's `number` fields (B19). `separatorLocations` produces the `enumeration` string (B21) when the clue text has none.
- Decisions baked in:
  - Guardian `position` is `{x: col, y: row}`; convert to `[row, col]` immediately at the boundary and never carry the Guardian convention inward (B18).
  - `style` is `"cryptic"` for `cryptic|prize|quiptic|everyman|weekend` and `"quick"` for `quick|speedy`, taken from the caller, not guessed from the payload.
  - The Guardian clue text often already ends with `(3,4)`; when it does, that wins over `separatorLocations`.
  - A payload entry whose `solution` length disagrees with its `length` is a `CliError` code 3 naming the entry id.
- Acceptance:
  1. `test/fixtures/guardian/cryptic-sample.json` is hand-authored in this task as a small (5x5 or 7x7) payload in the real Guardian shape with a comment recording the field names it mirrors; parsing it produces a `PuzzleWithSolution` whose grid, slots and solution are asserted cell by cell against an expected literal.
  2. `parsedBy === "guardian-json"`.
  3. B42: no clue contains any solution as a substring.
  4. A `{x: 2, y: 0}` entry lands at `row 0, col 2` (the axis-swap test).
  5. `separatorLocations: { ",": [3] }` on a 7-letter entry with no enumeration in the clue produces `enumeration: "(3,4)"`.
  6. A clue already ending `(3,4)` keeps that value even when `separatorLocations` disagrees, and the disagreement is warned once.
  7. A length/solution mismatch throws `CliError` code 3 naming the entry id.
- Out of scope: HTTP (T28); series-to-style mapping in the source adapter (T28).

### T27: xd source adapter
- Workstream: C (Sources)
- Model: sonnet
- Depends on: T0, T21, T22
- Owns: `src/sources/xd.ts`, `test/unit/sources/xd.test.ts`, `test/fixtures/sources/xd-mini.zip`, `test/fixtures/sources/xd-mini/` (a two-file directory)
- Reads (must not edit): `src/sources/types.ts`, `src/sources/registry.ts`
- Spec sections: "Puzzle library and sources" (`xd` bullet)
- Deliverable: the `xd` `SourceAdapter` reading a local directory **or** a `.zip` of the xd corpus (`--path`, default `./corpora/xd-puzzles.zip`). `list({ date, from, to, limit })` enumerates entries, derives `id` as `xd-<basename>`, parses the publication date from the path or filename, filters by date range and applies `limit`. `download(ref)` returns the entry bytes. No network at any point.
- Decisions baked in:
  - Zip entries are read lazily by name; the whole archive is never expanded to disk.
  - The date filter is inclusive on both ends and compares ISO date strings, not `Date` objects.
  - A missing `--path` target is a `CliError` code 3 whose message names the expected default and how to download the corpus (a README pointer, not a fetch).
  - `limit` defaults to 1 to match the `fetch` command's default.
  - Entries that are not `.xd` are skipped silently; a zip with zero `.xd` entries is a code 3 error.
- Acceptance:
  1. `list({ limit: 2 })` against `test/fixtures/sources/xd-mini/` returns 2 refs with `source: "xd"` and ids prefixed `xd-`.
  2. The same against `xd-mini.zip` returns the identical refs (a table-driven test running both cases through the same expectations).
  3. `download` returns bytes byte-identical to the file on disk for the directory case and to the zip entry for the zip case.
  4. `list({ from: "1963-01-01", to: "1963-12-31" })` returns only the fixture entry in that year.
  5. A nonexistent `--path` produces `CliError` code 3 with the default path in the message.
  6. A zip containing only a README produces `CliError` code 3.
- Out of scope: parsing (T25); picking the licence-clean fixtures (T48).

### T28: Guardian source adapter
- Workstream: C (Sources)
- Model: sonnet
- Depends on: T0, T21, T26
- Owns: `src/sources/guardian.ts`, `test/unit/sources/guardian.test.ts`, `test/fixtures/sources/guardian-series-page.html`, `test/fixtures/sources/guardian-list-sample.json`
- Reads (must not edit): `src/sources/types.ts`, `src/puzzle/adapters/guardian.ts`, `test/fixtures/guardian/cryptic-sample.json`
- Spec sections: "Puzzle library and sources" (`guardian` bullet), A2
- Deliverable: the `guardian` `SourceAdapter`. `list({ series, limit })` finds the latest id on the series page and walks ids backwards; `download(ref)` fetches `https://www.theguardian.com/crosswords/<series>/<id>.json`. Constraints from A2, all mandatory: a descriptive User-Agent `crossword-agent/<version> (+https://github.com/bendechrai/crossword-agent; personal research)`; a hard ceiling of **1 request per second**; `--limit` default 1 and hard maximum 20 (a larger value is a `CliError` code 2); no archive-backfill command. All HTTP goes through an **injected** fetch so the tests are offline.
- Decisions baked in:
  - The 1 rps ceiling is enforced inside the adapter with an injectable clock, independent of `llm/rateLimiter` (that limiter is for models, not sources).
  - Series-to-style mapping lives here: `cryptic|prize|quiptic|everyman|weekend` -> `"cryptic"`, `quick|speedy` -> `"quick"`.
  - A non-200 or a body that is not the expected JSON shape is a `CliError` code 3 with a one-line human message, never a stack trace (spec: "this is an unofficial endpoint").
  - Walking ids backwards stops at the first 404 as well as at `limit`.
  - The version in the User-Agent comes from `package.json`, read once.
- Acceptance:
  1. `list({ series: "cryptic", limit: 3 })` with an injected fetch serving `guardian-series-page.html` then three JSON bodies returns 3 refs with descending ids and `style: "cryptic"` on the resulting puzzles.
  2. Every injected fetch call is asserted to carry the exact User-Agent string, with the real package version substituted.
  3. With fake timers, 3 sequential downloads take at least 2,000 ms of injected clock (1 rps).
  4. `--limit 21` produces `CliError` code 2 naming the maximum of 20.
  5. A 404 mid-walk stops the walk and returns the refs collected so far, without throwing.
  6. A 500 response produces `CliError` code 3 with a single-line message and no stack in the message.
  7. `series: "quick"` maps to `style: "quick"`.
  8. The test file contains no reference to a real network call: assert `globalThis.fetch` is never invoked by spying on it.
- Out of scope: parsing the payload (T26); the `fetch` CLI (T29).

### T29: `xw fetch` handler
- Workstream: C (Sources)
- Model: sonnet
- Depends on: T0, T21, T22, T24, T25, T26, T27, T28
- Owns: `src/cli/fetch.ts`, `test/unit/cli/fetch.test.ts`
- Reads (must not edit): `src/sources/*`, `src/puzzle/library.ts`, `src/puzzle/loader.ts`
- Spec sections: "CLI reference" (`fetch`), B16, B34, B46
- Deliverable: the `fetch` handler. Resolves the adapter from the registry, calls `list()` with the flags, then for each ref: `download`, write the original to `puzzles/<source>/<id>.<ext>`, parse via `puzzle/loader`, write the normalised JSON via `library.writeNormalised` (B16), and upsert the index row including `files` and `parsedBy` (B34). Prints one line per puzzle: `fetched guardian-cryptic-30085  15x15  cryptic  32 slots`. Exit 3 if the source returns nothing.
- Decisions baked in:
  - Downloads are sequential, not parallel, so the Guardian 1 rps ceiling is trivially respected and progress lines are ordered.
  - A parse failure on one puzzle prints an error line, continues with the rest, and makes the command exit 3 at the end (partial success is still useful).
  - The original bytes are always written before parsing, so a parse bug never loses the download.
  - `--out` changes the puzzles directory root only; the `<source>/<id>` layout underneath is fixed.
- Acceptance:
  1. With a stub adapter registered in the test returning two refs, both files land at the expected paths and the index has two rows with correct `files` values.
  2. The printed lines match the spec's format exactly, asserted with a regex per line.
  3. An adapter returning zero refs makes the handler exit 3 with a message naming the source.
  4. A ref whose parse throws prints one error line, still writes the original bytes, and the process exits 3 while the other puzzle is fully written.
  5. `--out /tmp/x` writes under `/tmp/x/<source>/<id>.<ext>` and `/tmp/x/index.json`.
  6. Nothing is written under `puzzles/fixtures/` by this handler under any input.
- Out of scope: the adapters themselves; `list`/`show` (T30).

### T30: `xw list` and `xw show` handlers
- Workstream: C (Sources)
- Model: sonnet
- Depends on: T0, T21
- Owns: `src/cli/list.ts`, `src/cli/show.ts`, `test/unit/cli/list.test.ts`, `test/unit/cli/show.test.ts`
- Reads (must not edit): `src/puzzle/library.ts`, `src/cli/options.ts`
- Spec sections: "CLI reference" (`list`, `show`), B33
- Deliverable: `list` reads only the index (so it works offline), filters by `--source`, `--style` and `--solved` (only puzzles with a run at 100% letters), and prints the table `id, source, date, size, style, slots, best letters, last run`. B33: on an empty index it prints `no puzzles yet - try: xw fetch xd --limit 5` and exits 0; with `--json` it prints `[]`; null metrics render as `-`. `show <id>` prints the numbered grid (blocks as `#`, letters as `.` unless `--solution`) plus the across and down clue lists.
- Decisions baked in:
  - Column widths are computed from the data, capped so the table fits 80 columns; long titles are truncated with `...`.
  - `--json` output is the raw index rows for `list` and the normalised puzzle (minus `solution` unless `--solution`) for `show`.
  - `show` on an unknown id exits 3 with a message suggesting `xw list`.
  - Neither command ever touches the network or the cache.
- Acceptance:
  1. An index with three rows prints a header plus three rows; `--source xd` prints only the xd rows.
  2. `--solved` includes a row with `bestLetterAccuracy === 1` and excludes one at `0.99`.
  3. Empty index: stdout is exactly `no puzzles yet - try: xw fetch xd --limit 5` and the exit code is 0.
  4. Empty index with `--json`: stdout is exactly `[]` and the exit code is 0.
  5. A row with `bestLetterAccuracy: null` renders `-` in that column.
  6. `show` on `synthetic-5x5` prints a grid with `#` for the fixture's blocks and `.` for letters, then `Across` and `Down` clue lists in number order.
  7. `show --solution` prints the solution letters; without the flag no solution letter appears anywhere in stdout (asserted by searching for one of the answers).
  8. `show unknown-id` exits 3.
- Out of scope: solving; the index writer (T21).

### T31: Prompt templates
- Workstream: E (Prompting)
- Model: opus
- Depends on: T0
- Owns: `src/llm/prompts.ts`, `test/unit/llm/prompts.test.ts`, `test/fixtures/prompts/*.txt` (golden files)
- Reads (must not edit): `schemas/candidate-response.schema.json`, `src/candidates/types.ts`
- Spec sections: "Candidate service", "Batching clues per request", algorithms doc "Candidate generation with the LLM", B3, B21, B23, B41
- Deliverable: **single owner of `promptVersion`, which is `"1"` and does not change during v1.** Three templates keyed by `promptKind` (B23): `seed`, `constrained` (rendered for both re-ask and repair) and `escalate`. Each renders a system message fixing the output contract and a user message. `seed` carries clue text verbatim, enumeration, length, style, title and the "answers are run together, uppercase A-Z, no spaces or hyphens" instruction. `constrained` adds the `A?I?N` pattern with `?` explicitly meaning unknown and every fixed letter certain, plus the rejected list with a one-line reason each. `escalate` adds every crossing slot's clue, current fill and confidence, and permission to return `crossing_suspect: "<slotId>"` in `notes`. The batched form (B3: `seed` only) renders `{ "clues": [{ id, clue, length, pattern, style }] }` and asks for `{ "results": [...] }` keyed by the same ids. When the model lacks `structured_outputs`, the schema is inlined in the prompt with a one-shot example (B9).
- Decisions baked in:
  - `promptVersion = "1"` (a bare `"1"`, not `"v1"`), exported as a const and used by the cache key.
  - Templates are pure string builders with no I/O and no clock, so the golden files are stable.
  - The one-shot example uses the 5x5 fixture's `2D` clue so the example is real and checkable.
  - `notes` is documented in the prompt as optional and short; the schema allows it.
  - Batching is rendered only for `purpose: "seed"` (B3); `renderPrompt` throws if asked to batch any other purpose.
  - Nothing in the prompt names a model, so the same string is sent to both tiers.
- Acceptance:
  1. Golden-file tests: rendering each of the three kinds with a fixed input matches a committed `.txt` byte for byte. Six goldens: seed-single, seed-batched-3, constrained-reask, constrained-repair, escalate, seed-inline-schema (the no-structured-outputs variant).
  2. The seed prompt contains the clue text verbatim (including its trailing enumeration) and the words "uppercase" and "no spaces".
  3. The constrained prompt contains the pattern `A?I?N` and a line explaining `?`, and lists each rejected answer with its reason.
  4. The escalate prompt contains every crossing slot's clue and current fill, and the string `crossing_suspect`.
  5. The batched prompt contains each clue's `id` and asks for results keyed by id; rendering a batch for `purpose: "reask"` throws.
  6. `PROMPT_VERSION === "1"` is asserted, with a comment in the test pointing at B49 (a bump is a single-owner action landing with a regenerated cache).
  7. The inline-schema variant contains a JSON object identical to `schemas/candidate-response.schema.json`'s single-response branch, asserted by parsing it out of the prompt and deep-equalling the schema fragment.
- Out of scope: choosing a model (T32); sending anything (T33); parsing (T11).

### T32: Tier router
- Workstream: E (Prompting)
- Model: sonnet
- Depends on: T0, T8
- Owns: `src/llm/tierRouter.ts`, `test/unit/llm/tierRouter.test.ts`
- Reads (must not edit): `src/llm/pricing.ts`, `src/llm/types.ts`, `src/profiles/schema.ts`
- Spec sections: "Candidate service" step 2, B9, B41
- Deliverable: `route(req, profile): RoutedRequest` mapping `req.tier` to the profile's `tier1`/`tier2` model id and selecting the transport mode **by capability, not by model name** (B9): when `capabilitiesOf(model).supportsStructuredOutputs` is true, set `response_format: { type: "json_schema", json_schema: <candidate-response schema> }`; otherwise mark the request as needing the in-prompt schema plus one-shot example. When the model advertises `reasoning` and `purpose === "seed"`, set the provider's reasoning-off parameter (B41) - the exact parameter name is discovered by T49, so v1 ships a **named placeholder constant** `REASONING_OFF_PARAM` in this file with a `TODO(T49)` comment and a unit test pinning that the parameter is emitted under exactly those conditions, whatever its name.
- Decisions baked in:
  - Capability lookup, never a substring match on the model id (B9). A test asserts the file contains no literal `"deepseek"` or `"nemotron"` string.
  - The reasoning-off parameter is emitted only for `purpose: "seed"`, never for escalate or repair, where reasoning may help.
  - Sampling parameters come from `profile.sampling` (B22) and are filtered against `supported_sampling_parameters` from the catalogue; an unsupported parameter is dropped with one debug log, not sent.
  - `--seed` is passed to the provider only if the catalogue advertises it (B38).
- Acceptance:
  1. Tier 1 with `nvidia/Nemotron-3_5-Lightning` routes to in-prompt schema mode (no `response_format`).
  2. Tier 2 with `deepseek-ai/DeepSeek-V4-Pro` routes to `response_format.type === "json_schema"` and embeds the schema.
  3. A hypothetical model entry from `test/fixtures/models.min.json` with `structured_outputs` but a tier-1 role still gets json_schema mode, proving capability drives it.
  4. `purpose: "seed"` on a `reasoning` model emits `REASONING_OFF_PARAM`; `purpose: "escalate"` on the same model does not.
  5. A sampling parameter absent from `supported_sampling_parameters` is dropped from the outgoing request.
  6. Source-level assertion: reading `src/llm/tierRouter.ts` finds no case-insensitive occurrence of `deepseek` or `nemotron`.
  7. `--seed` is included only when the catalogue lists `seed` as a supported sampling parameter.
- Out of scope: HTTP (T33); the prompts themselves (T31).

### T33: Nebius transport client
- Workstream: D (Transport)
- Model: sonnet
- Depends on: T0, T9, T10
- Owns: `src/llm/client.ts`, `test/unit/llm/client.test.ts`, `test/helpers/stubHttpServer.ts`
- Reads (must not edit): `src/llm/rateLimiter.ts`, `src/llm/inferenceLog.ts`, `src/llm/types.ts`
- Spec sections: "Rate limiting", "Inference log (always on)", B51
- Deliverable: `createNebiusTransport(opts): LlmTransport` implementing `complete(req): Promise<LlmResult>` per B51, where `LlmResult` is `{ text, usage, httpStatus, headers, latencyMs }`. It acquires from the per-model rate limiter before each attempt, captures every response header, parses rate-limit headers and feeds them to `observe()`, retries per the spec (429: honour `retry-after` else exponential backoff with full jitter from 500 ms, max 5 retries; 5xx: same backoff, no rate change), and writes one `InferenceLogRecord` per attempt with `attempt` incrementing. Ships a local stub HTTP server helper so tests exercise real sockets on `127.0.0.1` without any external network.
- Decisions baked in:
  - Base URL is `$NEBIUS_BASE_URL` or the config's `nebiusBaseUrl` or the Nebius default; the API key comes only from `$NEBIUS_API_KEY` and is never logged, never placed in a record, and never in an error message.
  - The transport knows nothing about candidates, prompts or caching; it moves text and usage.
  - Jitter uses the injected PRNG (B38) so retry timing is reproducible in tests.
  - Reasoning tokens are read from the provider's usage blob when present into `TokenUsage.reasoningTokens` and are also added to `completionTokens` for billing (B29).
  - After 5 retries the transport throws a `CliError` with code 5 (PROVIDER) naming the model and the last status.
- Acceptance:
  1. Happy path against the stub server returns `text`, `usage` and `httpStatus: 200`, and one inference-log record is written with `attempt: 0`.
  2. A stub returning 429 with `retry-after: 1` then 200 retries once after 1,000 ms of fake-timer clock, writes two records with `attempt` 0 and 1, and calls `observe` with `status: 429`.
  3. A stub returning 429 with no `retry-after` backs off from 500 ms with jitter drawn from the injected PRNG; assert the delay is in [0, 500] for the first retry with a PRNG returning a fixed fraction.
  4. Six consecutive 429s produce a `CliError` code 5 and six records.
  5. A 500 then 200 retries without changing the limiter rate (assert `observe` is called with the 500 and that rps is unchanged).
  6. Response headers are captured verbatim into the record; a request built with an `authorization` header produces a record whose `responseHeaders` does not contain it.
  7. Searching the whole written log file for the test's fake API key string finds zero occurrences.
  8. `latencyMs` is greater than 0 and is measured around the fetch only.
- Out of scope: what to send (T31/T32); caching (T12); candidate handling (T34).

### T34: CandidateService
- Workstream: F (Candidate service)
- Model: opus
- Depends on: T0, T6, T11, T12, T13, T31, T32
- Owns: `src/candidates/service.ts`, `test/unit/candidates/service.test.ts`, `test/helpers/stubTransport.ts`
- Reads (must not edit): `src/candidates/cache.ts`, `src/llm/{parser,prompts,tierRouter}.ts`, `src/validate/normalise.ts`, `src/score/calibrate.ts`
- Spec sections: "Candidate service" (all five steps), "Batching clues per request", B3, B6, B23, B43
- Deliverable: `createCandidateService(deps): CandidateService` doing the five steps in order - cache lookup, tier routing, transport call, parse (retry once at temperature 0 on a parse failure; a second failure is a tier-1 failure and an escalation trigger), validation, calibration - and emitting `slot:ask`, `slot:candidates`, `candidate:reject` and `cache:lookup` through an injected emit. Adds `peek(slotId): Candidate[]` returning every candidate ever returned for that slot in this run (B43) - the ledger the repair gate reads. Batching applies to `purpose: "seed"` only (B3): `getCandidatesBatch(reqs)` groups up to `batchSize` requests, stores each clue's result under its own cache key, and re-asks singly any element the parser failed. `--offline` behaviour is B6: a cache miss is fatal, exit 4, and the message names both the cache key and the clue; `--offline-lenient` degrades gracefully by returning an empty domain instead.
- Decisions baked in:
  - The service talks to an injected `LlmTransport` (B51), so this task is fully testable with `stubTransport.ts` and never opens a socket.
  - Negative results are cached (spec) so a known dead end is never re-paid for.
  - The retry at temperature 0 uses a **different** cache key only because `temperature` is a key field (B23); it therefore never collides with the first attempt's entry.
  - `peek` is per run and in memory only; it is not persisted and is cleared when the service is created.
  - A cache hit still writes an inference-log record with `cacheHit: true` (spec), and still emits `cache:lookup`.
  - The service never decides to escalate; it reports the facts that T18 turns into a decision.
- Acceptance:
  1. Cold call: the stub transport is invoked once, the result is validated and calibrated, and a second identical call invokes the transport zero times and returns `fromCache: true`.
  2. A response with zero valid candidates after validation is cached as a negative and the second call is a hit.
  3. A parse failure then a good response: the transport is called twice, the second with `temperature: 0`, and the result is returned. Two parse failures return zero candidates and set the `parseFailures: 2` fact.
  4. Batched seed of 3 clues issues one transport call, writes three cache entries under three distinct keys, and each entry's `batchSize` is 3.
  5. A batched response missing one id causes exactly one single re-ask for that id and none for the others.
  6. `getCandidatesBatch` with `purpose: "reask"` throws (B3).
  7. `--offline` with a cold key throws a `CliError` code 4 whose message contains the sha1 key and the clue text; `--offline-lenient` returns an empty candidate list and no throw.
  8. `peek(slotId)` after two calls for that slot returns the union of both result sets, de-duplicated, and is empty for an unseen slot.
  9. Every rejected candidate produces exactly one `candidate:reject` event carrying its `RejectReason`.
- Out of scope: the search (T37); escalation decisions (T18); real HTTP (T33).

### T35: `xw cache` subcommand
- Workstream: F (Candidate service)
- Model: sonnet
- Depends on: T0, T12
- Owns: `src/cli/cache.ts`, `test/unit/cli/cache.test.ts`
- Reads (must not edit): `src/candidates/cache.ts`, `src/util/fs.ts`
- Spec sections: "CLI reference" (`cache`), B24
- Deliverable: `cache stats|clear|export <file>|import <file>`. `stats` prints entry count, disk bytes, last-run hit rate and a breakdown by model and `promptVersion`, and warns above 1 GB (B24). `clear` takes `--model` and `--prompt-version` filters. `export` writes a tarball of the cache directory and `import` reads one back - this is how the committed test cache in T50 is produced.
- Decisions baked in:
  - The tarball is produced with `node:zlib` plus a minimal tar writer, or with `tar` from the image if simpler; whichever is chosen, `export` then `import` into an empty directory must reproduce the byte-identical tree, and the test asserts that round trip.
  - `clear` with no filter requires `--yes`, because clearing the whole cache turns every later offline run into a network run.
  - `stats` never loads entry bodies; it reads sizes and the first line of metadata only, so it stays fast on a large cache.
  - Export excludes nothing: a negative entry is part of the cache and must ship.
- Acceptance:
  1. `stats` on a 3-entry cache prints the count, a byte total, and one line per distinct model.
  2. `stats` with an injected size over 1 GB prints the warning line.
  3. `clear --model X` removes only entries for model X; the others survive.
  4. `clear` with no filter and no `--yes` exits 2 without deleting anything.
  5. `export` then `import` into a fresh directory reproduces an identical file tree (compare a recursive listing of paths and sha1s).
  6. `import` of a tarball containing a path traversal entry (`../`) is refused with exit 2.
- Out of scope: the cache implementation (T12).

### T36: AC-3 prepass
- Workstream: G (Solver)
- Model: opus
- Depends on: T0, T4, T5
- Owns: `src/solver/ac3.ts`, `test/unit/solver/ac3.test.ts`, `test/fixtures/domains/ac3-*.json`
- Reads (must not edit): `src/grid/{model,domainStore,pattern}.ts`, `src/events/types.ts`
- Spec sections: "Solver pipeline" step 3, algorithms doc "Filling the grid" (AC-3 row), B7, B40
- Deliverable: `ac3(grid, domains, emit, opts): Ac3Result`. Worklist over crossing arcs; for arc `(s,t)`, drop any candidate of `s` with no candidate of `t` agreeing at the shared cell; requeue the other arcs of `s` on any reduction. On a **wipeout** apply B40 exactly: restore the domain to what it was before this arc's revision, mark the slot `suspect`, remove **every arc incident on that slot** from the worklist for the rest of the prepass, and emit `ac3:wipeout` **once per slot**. Emits `ac3:arc` (level 3) per arc visited and `ac3:reduce` (level 2) per reduction. A slot with no crossings simply contributes no arcs (B7).
- Decisions baked in:
  - Reductions go through `DomainStore.reduce` at depth 0 so they are trailed like any other reduction; the prepass never mutates base domains.
  - The worklist is a FIFO queue with a membership set so an arc is never queued twice concurrently.
  - "Restore the domain" means undoing only this arc's revision, not every reduction the slot has taken.
  - `suspect` is returned in the result for the escalation policy to read; AC-3 makes no escalation decision itself.
  - The prepass has an arc-visit cap (default 50,000) so a pathological grid cannot hang; hitting it ends the prepass and is reported in the result.
- Acceptance:
  1. Fixture `ac3-reducible.json`: three slots where one candidate of `1A` has no support at a crossing; after `ac3` that candidate is gone and every other survives, asserted as exact arrays.
  2. `ac3:reduce` is emitted once per reduction with the arc and the removed candidates.
  3. Fixture `ac3-wipeout.json`: revising an arc empties `2D`; after `ac3` the domain of `2D` is exactly its pre-revision content, `2D` is in `result.suspect`, and `ac3:wipeout` is emitted exactly once for it even though three arcs were incident on it.
  4. After the wipeout, no further `ac3:arc` event names `2D` (B40: its arcs are removed from the worklist).
  5. Fixture `ac3-unchecked.json` (from the 5x5 synthetic grid): the slot containing the unchecked cell contributes fewer arcs than its length, and AC-3 completes without error (B7).
  6. Idempotence: running `ac3` twice on the already-reduced store produces no further reductions and no events beyond `ac3:arc`.
  7. A domain store with 1,000 slots and 10 candidates each terminates under the arc cap and reports `capped: false`.
- Out of scope: the search (T37); deciding what a suspect means (T18).

### T37: Search core
- Workstream: G (Solver)
- Model: opus
- Depends on: T0, T3, T4, T5, T20
- Owns: `src/solver/search.ts`, `test/unit/solver/search.test.ts`, `test/fixtures/domains/search-*.json`
- Reads (must not edit): `src/solver/{types,ordering}.ts`, `src/grid/*`, `src/events/types.ts`
- Spec sections: "Solver pipeline" step 4, algorithms doc step 4, B7, B38, B39
- Deliverable: `search(grid, domains, hooks: SearchHooks, emit, opts): SearchResult`. Depth-first assignment with forward checking. Variable ordering delegates to T20. Values in calibrated score order. On assignment, intersect each crossing domain with the new pattern regex through `DomainStore.reduce` at the current depth. Taking other than the first-ranked value increments the discrepancy count; exceeding `ldsLimit` abandons the branch, and when the tree is exhausted the search restarts at `ldsLimit + 1` up to `ldsLimitMax`. Backtrack target is the **lowest-margin** assignment among the slots crossing the failed slot, falling back to the lowest-margin assignment anywhere when the slot has no crossings (B7). Emits `search:assign` (with `tier` and `producedBy`, B32), `search:unassign`, `search:forwardcheck`, `search:wipeout`, `search:backtrack`, `lds:restart` and `progress` (coalesced per B37). **Calls `hooks` at the declared points and never calls the candidate service directly.**
- Decisions baked in:
  - `SearchHooks` (declared in T0) is the only route out: `onEmptyDomain(slotId, ctx)` returns whether new candidates were merged, `onCandidatesReturned` is not called here, `chargeBudget(kind, amount)` reports exceeded caps, `onSearchTermination(emptySlots)` is called once at the end. T38 implements them; this task tests with fakes.
  - `progress` is emitted on phase transition and otherwise at most every 250 ms (B37), coalesced, using an injected clock.
  - Tie-breaks and any randomised choice use the injected seeded PRNG (B38).
  - The search is iterative, not recursive, so a 15x15 puzzle cannot blow the stack.
  - Hitting `maxBacktracks` ends the search gracefully with the best partial fill; it never throws (spec's budget-cap behaviour).
- Acceptance:
  1. Fixture `search-solvable.json`: a 5x5 whose domains admit exactly one consistent fill; `search` returns it and `isComplete()` is true.
  2. Fixture `search-backtrack.json`: the first-ranked value of the first slot leads to a dead end; the search assigns it, wipes out, backtracks, and completes. Assert the exact sequence of `search:assign`/`search:backtrack` slot ids.
  3. The backtrack target is the lowest-margin crossing assignment, not the chronologically last: build a case where those differ and assert which slot is unassigned.
  4. A slot with no crossings that fails causes the lowest-margin assignment **anywhere** to be undone (B7).
  5. Discrepancy counting: taking a rank-1 value increments the count; a branch exceeding `ldsLimit: 0` is abandoned, and `lds:restart` is emitted with limit 1.
  6. `ldsLimitMax: 3` means at most 4 passes (0..3) and the search then returns its best partial.
  7. `maxBacktracks: 5` on an unsolvable fixture returns a partial fill with `backtracks === 5`, emits no throw, and `hooks.chargeBudget` was called for each backtrack.
  8. `onEmptyDomain` returning true (candidates merged) causes the search to retry the slot rather than backtrack; returning false causes a backtrack. Both asserted with a fake hooks object.
  9. `progress` events are at least 250 ms apart on the injected clock except at phase transitions.
- Out of scope: re-asking or escalating (T38); repair (T42); the phase orchestration (T44).

### T38: Search hooks - re-ask, escalation and budget wiring
- Workstream: G (Solver)
- Model: opus
- Depends on: T0, T18, T19, T34
- Owns: `src/solver/hooks.ts`, `test/unit/solver/hooks.test.ts`
- Reads (must not edit): `src/solver/types.ts`, `src/policy/{escalation,budget}.ts`, `src/candidates/types.ts`
- Spec sections: "Solver pipeline" steps 5 and 6, B13, B43, B44
- Deliverable: `createSearchHooks(deps): SearchHooks` - the implementation of the interface T37 calls. `onEmptyDomain` builds the slot's current pattern, applies the re-ask guards (pattern has at least one fixed letter, differs from the last pattern queried for that slot, slot under `reasksPerSlot`), calls `CandidateService.getCandidates` with `purpose: "reask"`, merges into the **base** domain (B39), and emits `slot:reask`. It consults `decide()` (T18) after every service return and routes `escalate` to a tier-2 call with the escalation context, emitting `slot:escalate`. `onSearchTermination` runs trigger 5 for still-empty slots. Every call charges the budget tracker (T19) and emits `budget:hit` when a cap is crossed, ending the current phase gracefully rather than throwing.
- Decisions baked in:
  - The hooks own the per-slot state that neither the search nor the policy should hold: last pattern queried, re-ask count, escalation count, wipeout count. It is a plain `Map<slotId, SlotState>` created per run.
  - `decide()` is consulted after **every** `getCandidates` return (B13), including a successful one, so trigger 3 (`clue_understood` below threshold) can fire proactively.
  - A `give-up` decision marks the slot and returns false to the search, which then backtracks or terminates.
  - Escalation context includes the crossing clues, fills and confidences, and the rejected list with reasons, exactly as the escalate prompt expects (T31).
  - The hooks never touch the grid; they read it and hand answers to the search.
- Acceptance:
  1. An empty domain with a pattern having one fixed letter and re-asks remaining calls the stub service once with `purpose: "reask"`, merges the result, emits one `slot:reask`, and returns true.
  2. The same pattern queried twice for one slot does not issue a second call (guard) and returns false.
  3. An all-`?` pattern never triggers a re-ask.
  4. A slot at `reasksPerSlot` returns false without calling the service.
  5. `decide` returning `escalate` issues one tier-2 call and emits `slot:escalate` carrying the trigger number and the tier-2 calls used.
  6. `clue_understood` below threshold on a **successful** seed return still produces an `escalate` decision (trigger 3), proving `decide` runs on every return.
  7. Exhausting `maxTier2CallsPerPuzzle` emits exactly one `budget:hit` for that cap and downgrades subsequent escalations to re-asks.
  8. `onSearchTermination` with two still-empty slots consults `decide` twice with trigger-5 contexts.
  9. Merged re-ask results survive a simulated `undoTo(0)` on the domain store (B39).
- Out of scope: the search loop (T37); the policy tables (T18); repair (T42).

### T39: WatchRenderer
- Workstream: H (Renderers)
- Model: sonnet
- Depends on: T0, T14
- Owns: `src/render/watch.ts`, `test/unit/render/watch.test.ts`
- Reads (must not edit): `src/render/console.ts`, `test/fixtures/events/full-run.events.jsonl`, `src/events/types.ts`
- Spec sections: "Renderers" (WatchRenderer), B31, B32
- Deliverable: `WatchRenderer(opts)` using `log-update` for a full-frame redraw on `search:assign`, `search:unassign`, `repair:accept` and `progress`. The grid is built from `grid:init` (B32) rather than inferred, so the renderer never guesses the geometry. Cells are coloured by producing tier (tier 1 cyan, tier 2 magenta, word-list fallback grey) using the `tier`/`producedBy` fields on `search:assign` (B32), and by confidence band (bold at 0.5 and above, normal at 0.25 and above, dim below). A status line shows phase, assigned/total, backtracks and usd. On `score:final` it overlays the diff. TTY detection is B31: honoured only when `process.stdout.isTTY && !process.env.CI && process.env.TERM !== "dumb"`; otherwise it prints one stderr line and falls back to `ConsoleRenderer(0)`. `NO_COLOR` and `--no-color` are respected; width defaults to 80 when undefined.
- Decisions baked in:
  - `log-update` is injected so tests capture frames as an array of strings.
  - The renderer holds only display state; it never reads the grid model or the domain store.
  - A `search:assign` for a cell already coloured by a later assignment is not re-drawn out of order; frames are always rendered from accumulated state, not incrementally patched.
  - The diff overlay reuses T14's diff formatting by importing it (read-only), so the two renderers cannot disagree.
- Acceptance:
  1. Replaying `full-run.events.jsonl` produces at least one frame per `search:assign` and the final frame contains the fixture's final grid.
  2. The first frame is drawn from `grid:init` and has the right dimensions before any assignment.
  3. A `search:assign` with `tier: 2` produces a magenta cell and `tier: 1` a cyan one (assert on the ANSI codes with colour forced on).
  4. `producedBy: "wordlist"` produces the grey cell.
  5. With `isTTY: false` the renderer writes exactly one line to stderr and every subsequent event goes to a `ConsoleRenderer(0)` (assert by spying on the fallback).
  6. With `CI=1` and `isTTY: true` it still falls back (B31).
  7. With `NO_COLOR=1` no frame contains an ESC byte (0x1b).
  8. With `process.stdout.columns` undefined, frames are at most 80 columns wide.
  9. The `score:final` frame contains the diff overlay marking the fixture's wrong letter.
- Out of scope: the console renderer (T14); event production.

### T40: Report aggregation
- Workstream: I (Eval)
- Model: sonnet
- Depends on: T0, T17
- Owns: `src/eval/aggregate.ts`, `test/unit/eval/aggregate.test.ts`, `test/fixtures/runs/aggregate/*.json`
- Reads (must not edit): `src/eval/types.ts`, `schemas/run-record.schema.json`
- Spec sections: "Metrics and run records" (report paragraph), A1, B1, B2, B14
- Deliverable: `aggregate(records, opts): Aggregation` grouping by `profile`, `puzzle`, `tier`, `stratum` (A1) or `batchIndex` (B14). Per group it emits mean and sample standard deviation of letter accuracy, word accuracy and perfect rate; mean USD per puzzle; USD per correct word (`sum(usd)/sum(correct words)`); tier-2 share of calls; mean wallMs; and budget-hit counts by cap. Cost figures use `usdCounterfactual` (B2). Variance follows B1: `report` reports stdev across puzzles, and when `repeat > 1` it reports within-puzzle and across-puzzle variance separately. Also the per-slot difficulty view (clues keyed by `(puzzleId, slotId)` with the number of profiles that got them wrong, worst first) and `compare(a, b)` producing the paired delta table.
- Decisions baked in:
  - All decision-rule numbers use `usdCounterfactual`, never `usdBilled` (B2); `usdBilled` is reported alongside but never divided by anything.
  - Sample standard deviation is the n-1 form; a group of size 1 reports stdev `null`, not 0.
  - Grouping by `stratum` reads `RunRecord.puzzle.style` mapped through the puzzle-set entry's `stratum` when present, else the style (A1).
  - `batchIndex` grouping reads `perSlot[].batchIndex` and skips slots where it is null (B14).
  - The module is pure: it takes parsed records and returns data. Rendering is T46's.
- Acceptance:
  1. Six hand-written `RunRecord` fixtures (two profiles x three puzzles) aggregate to per-profile means asserted as exact literals.
  2. Sample stdev for a three-value group matches a hand-computed n-1 value to 10 decimal places; a one-record group reports `null`.
  3. `usd per correct word` equals `sum(usdCounterfactual) / sum(correct words)` and changes when a fixture's `usdBilled` alone is edited (proving billed is not used).
  4. With `repeat: 2` fixtures (same puzzle twice per profile), within-puzzle and across-puzzle variance are reported as separate fields and differ (B1).
  5. `--by stratum` splits the fixtures into `american` and `cryptic` groups with the right membership.
  6. `--by batchIndex` groups per-slot rows and ignores rows with `batchIndex: null`.
  7. The difficulty view lists the clue both profiles got wrong first, then the clue one profile got wrong.
  8. `compare("baseline","patient")` produces a row per metric with the signed delta.
- Out of scope: printing (T46); the inference report (T41).

### T41: Inference log report
- Workstream: I (Eval)
- Model: sonnet
- Depends on: T0, T10
- Owns: `src/eval/inference.ts`, `test/unit/eval/inference.test.ts`, `test/fixtures/inference/*.jsonl`
- Reads (must not edit): `src/llm/types.ts`
- Spec sections: "CLI reference" (`report --inference`), "Inference log (always on)"
- Deliverable: `aggregateInference(records, filters): InferenceReport` answering the operational questions: calls per model per day, USD per day, parse-failure rate per model (`parseError != null` over total non-cache-hit calls), cache-hit rate, and the 20 slowest calls by `latencyMs`. Supports `--since`, `--until`, `--model`, `--run`, `--slot` filters and a `--dump` mode returning the full matching records. Reads `logs/inference/*.jsonl` through an injected reader so tests use fixtures.
- Decisions baked in:
  - Cache hits are excluded from the parse-failure denominator (they have no response to parse) but counted in the cache-hit rate numerator and in the call count.
  - Dates are grouped by the record's UTC date, taken from `ts`, not from the filename, so a mis-named file cannot skew the report.
  - A malformed JSONL line is counted in a `skippedLines` field and reported, never silently dropped.
  - `--dump` returns records unchanged, so its output can be pasted straight into `test/fixtures/responses/` as a parser fixture (spec).
- Acceptance:
  1. A 10-record fixture spanning two dates groups into two days with the right call counts and USD totals.
  2. Parse-failure rate: 2 failures out of 8 non-cache-hit calls is 0.25, and the 2 cache hits do not change it.
  3. Cache-hit rate is 2/10.
  4. The slowest-calls list is exactly 20 long for a 30-record fixture and is sorted descending by `latencyMs`.
  5. `--model X` and `--run Y` filters each reduce the set to the expected ids.
  6. `--since`/`--until` are inclusive and filter on UTC date.
  7. A fixture with one malformed line reports `skippedLines: 1` and still aggregates the rest.
  8. `--dump` output round-trips: every returned object deep-equals the fixture line it came from.
- Out of scope: the CLI wiring (T46); writing the log (T10).

## Wave 3: repair, orchestration, remaining CLI, fixtures and the spike

Starts once every Wave 2 task is merged.

### T42: Repair pass
- Workstream: G (Solver)
- Model: opus
- Depends on: T0, T3, T5, T34
- Owns: `src/solver/repair.ts`, `test/unit/solver/repair.test.ts`, `test/fixtures/domains/repair-*.json`
- Reads (must not edit): `src/candidates/types.ts` (`peek`), `src/validate/wordlist.ts`, `src/grid/*`
- Spec sections: "Solver pipeline" step 7, algorithms doc "Berkeley Crossword Solver" and step 7, B7, B35, B43
- Deliverable: `repair(grid, service, wordlist, emit, opts): RepairResult`. From the possibly partial fill, enumerate 1-2 letter edits, gate each proposal, score the survivors by re-asking tier 1 for the affected slots with the new pattern (`purpose: "repair"`), and accept improving edits until none remain or `repair.maxCalls` is spent. Fill still-empty slots with the best word-list entry matching the pattern. Emits `repair:propose`, `repair:accept` (with `tier`/`producedBy`, B32) and `repair:reject`.
- Decisions baked in:
  - The plausibility gate is B7's wording exactly: a changed letter must appear at that offset in some candidate returned for **any** crossing slot (read through `CandidateService.peek`, B43), **or** the resulting word must be in the word list. With no crossings, the word-list arm is the only one available; with no word list (B35 null object) the word-list arm is disabled and only the peek arm applies.
  - Proposals are enumerated deterministically: cells in row-major order, then candidate letters in alphabetical order, so the pass is reproducible without a PRNG.
  - "Improving" means the summed calibrated score of the affected slots strictly increases; ties are rejected, so the pass terminates.
  - Edit distance is capped by `repair.maxEditDistance` (1 or 2); distance-1 proposals are exhausted before any distance-2 proposal is considered.
  - Every proposal costs at most one service call, and the call budget is checked before the call, not after.
- Acceptance:
  1. Fixture `repair-onefix.json`: a complete fill with one wrong letter that a distance-1 edit corrects; the pass proposes it, the gate passes via `peek`, the stub service scores it higher, and the edit is accepted. Final grid is correct.
  2. A proposal whose changed letter appears in no peeked candidate and whose result is not in the word list is rejected **before** any service call (assert the stub was not called).
  3. With the word list absent (null object) the same proposal is still rejected, and one warning is logged once per run (B35).
  4. `maxCalls: 1` stops after the first scoring call and returns with `callsUsed: 1`.
  5. A tie in score is rejected and the pass terminates rather than oscillating (run to completion and assert a bounded proposal count).
  6. Distance-2 proposals are only considered after every distance-1 proposal has been evaluated, asserted from the `repair:propose` event order.
  7. An empty slot is filled from the word list with the highest-scoring pattern match, and `repair:accept` carries `producedBy: "wordlist"`.
  8. With no crossings on a slot (B7), the gate uses only the word-list arm and still works.
- Out of scope: orchestration (T44); the word list itself (T43).

### T43: Word list
- Workstream: F (Validation)
- Model: sonnet
- Depends on: T0
- Owns: `src/validate/wordlist.ts`, `scripts/wordlist-fetch.ts`, `test/unit/validate/wordlist.test.ts`, `test/fixtures/wordlist.txt`
- Reads (must not edit): `src/validate/types.ts`, `package.json` (the script is already declared)
- Spec sections: B35
- Deliverable: `WordList { has(w): boolean; score(w): number; match(pattern, limit): string[] }` (B35) over the Crossword Nexus collaborative word list (MIT), loaded from `data/wordlist/collaborative.txt` in `word;score` form. `npm run wordlist:fetch` downloads it into `data/wordlist/` (gitignored). A 2,000-line subset is committed at `test/fixtures/wordlist.txt` so tests never need the download. When the list is absent, `openWordList()` returns a **null object** whose `has` is always false, `score` always 0 and `match` always empty, the repair word-list gate is disabled and the empty-slot fallback leaves blanks with a one-time warning.
- Decisions baked in:
  - `match(pattern, limit)` uses T5's regex and an index by length so a 15x15 puzzle's fallback fills are fast; the index is built once at load.
  - Scores are the list's own 0-100 integers normalised to [0,1].
  - The fetch script is the **only** thing in this task that would touch the network, and it is never invoked by a test; the test subset is committed and hand-trimmed from the licence-compatible MIT list, with its provenance recorded in a header comment inside `test/fixtures/wordlist.txt`.
  - Words are uppercased and stripped to `A-Z` at load, matching T6's normaliser, so the two never disagree.
- Acceptance:
  1. `has("ALIEN")` is true and `has("ZZZZZ")` is false against `test/fixtures/wordlist.txt`.
  2. `score` returns a value in [0,1] and the higher-scored of two fixture words compares greater.
  3. `match("A?I?N", 10)` returns only words matching the pattern, at most 10, sorted by descending score.
  4. `match` on a length with no entries returns `[]`.
  5. The null object (list file absent) returns false/0/[] for everything and logs exactly one warning across 100 calls.
  6. Loading a line with a malformed score skips that line and counts it in a `skipped` field.
  7. `scripts/wordlist-fetch.ts` is not executed by any test (assert by grep in the test that no test file imports it).
- Out of scope: repair gating (T42); fitting scores.

### T44: `solve()` orchestration
- Workstream: G (Solver)
- Model: opus
- Depends on: T0, T3, T4, T16, T19, T34, T36, T37, T38, T42
- Owns: `src/solver/solve.ts`, `test/unit/solver/solve.test.ts`
- Reads (must not edit): `src/solver/{types,ac3,search,hooks,repair}.ts`, `src/eval/scorer.ts`, `src/events/*`
- Spec sections: "Solver pipeline" (all 8 steps), "Events and verbosity", B32, B37
- Deliverable: `solve(deps: SolveDeps, profile, emit): Promise<SolveResult>` implementing the 8 steps in order with the exact event emissions the spec's pipeline section brackets: `run:start`, `grid:init` (B32), `phase:start('seed')` ... `phase:end`, the prepass, the search, the repair pass and the score, ending with `score:final`, `cost:summary`, `grid:final`, `run:end`. Budget-cap behaviour is the spec's: hitting a cap emits `budget:hit`, ends the **current phase** gracefully, and proceeds to the next phase; it never throws and **never skips step 8**.
- Decisions baked in:
  - `SolveDeps` (declared in T0) is injected, so this task is tested entirely with fakes for ac3, search, hooks and repair; it never constructs them itself. The CLI (T45) does the wiring.
  - The seed pass has no concurrency cap of its own; the per-model rate limiter is the only gate (B5).
  - Seeding uses `getCandidatesBatch` when `profile.batchSize > 1`, single calls otherwise (B3).
  - A slot empty after seed validation goes onto the escalation queue immediately (spec step 2).
  - `repair.enabled: false` skips step 7 entirely but still emits `phase:start`/`phase:end` for it with a `skipped: true` payload, so the event stream shape is constant across profiles.
  - Step 8 always runs, including after a budget hit or an empty grid.
- Acceptance:
  1. A fake-deps run over the 5x5 synthetic emits the phases in order `seed, prepass, search, repair, score` and the level-0 events in the spec's order; assert the full ordered list of event types.
  2. `grid:init` is emitted exactly once, immediately after `run:start`, and its payload's `blocks`, `numbers` and `slots` match the fixture (B32).
  3. A budget cap hit during search emits `budget:hit`, ends the search phase, and the repair and score phases still run; `run:end` reports `status: "partial"`.
  4. A fake search that throws is not allowed to escape: the error is captured, `run:end` carries `status: "error"` with the message, and step 8 still ran.
  5. `repair.enabled: false` skips the repair work but emits both repair phase events with `skipped: true`.
  6. `batchSize: 3` causes the seed pass to call `getCandidatesBatch` and not `getCandidates` (assert on the fake).
  7. `score:final` payload equals the scorer's output for the produced fill.
  8. No module under `src/solver/` writes to stdout: assert by reading every file in the directory and finding no `console.` occurrence.
- Out of scope: CLI wiring (T45); real transports.

### T45: `xw solve` handler
- Workstream: J (CLI)
- Model: sonnet
- Depends on: T0, T14, T15, T17, T21, T23, T33, T34, T39, T44
- Owns: `src/cli/solve.ts`, `test/unit/cli/solve.test.ts`
- Reads (must not edit): `src/solver/solve.ts`, `src/render/*`, `src/profiles/loader.ts`, `src/puzzle/library.ts`
- Spec sections: "CLI reference" (`solve`), "Renderers", B6, B16, B24, B31
- Deliverable: the `solve` handler: resolve the profile (T23), resolve `<id|path>` (B16 - `xw solve <id>` reads the normalised JSON only, `xw solve <path>` parses the file format), construct the real `SolveDeps` (transport, candidate service, grid, domain store, ac3, search, hooks, repair), attach the renderers per `-v/-vv/-vvv`, `--watch` (B31) and `--trace`, run `solve()`, and write the run record. Flags: `--profile`, `--tier1`, `--tier2`, `-v/-vv/-vvv`, `--watch`, `--offline`, `--offline-lenient` (B6), `--budget-usd`, `--seed`, `--trace`, `--no-inference-log`, `--out`, `--cache-dir`. Exit 0 even on a partial fill; exit 4 on an offline miss (B6); exit 5 on provider failure.
- Decisions baked in:
  - Renderer attachment: `ConsoleRenderer(level)` always; `JsonlEventSink` at `-vvv` or `--trace`; `WatchRenderer` when `--watch` and B31's TTY conditions hold, otherwise one stderr line and `ConsoleRenderer(0)`.
  - `--seed` seeds only the local PRNG and is recorded in the run record (B38).
  - `--budget-usd` overrides `profile.budget.usd` as an explicit CLI flag, the highest layer in B26.
  - The handler is a thin composition root: it contains no solving logic, and its test asserts that by mocking `solve()` and checking only the wiring.
- Acceptance:
  1. With `solve()` mocked, `--profile patient` passes a resolved profile whose `reasksPerSlot` is 3.
  2. `-vv` attaches a `ConsoleRenderer` at level 2 and no jsonl sink; `-vvv` attaches both.
  3. `--watch` with `isTTY: false` writes one stderr line and attaches `ConsoleRenderer(0)` (B31).
  4. `--offline` with a cold cache exits 4 and the message contains the cache key and the clue (B6); `--offline-lenient` exits 0.
  5. `xw solve <path-to-ipuz>` parses the file; `xw solve <id>` reads only `puzzles/<source>/<id>.json` (assert the loader is not called for the id form).
  6. A transport `CliError` code 5 propagates as exit 5.
  7. The run record is written to `--out` when given and to `runs/<runId>.json` otherwise.
  8. A partial fill exits 0.
- Out of scope: `solve()` itself (T44); bench (T47).

### T46: `xw report` handler
- Workstream: I (Eval)
- Model: sonnet
- Depends on: T0, T40, T41
- Owns: `src/cli/report.ts`, `test/unit/cli/report.test.ts`
- Reads (must not edit): `src/eval/{aggregate,inference}.ts`
- Spec sections: "CLI reference" (`report`, `report --inference`), A1, B1, B2
- Deliverable: the `report` handler. Reads a glob of run records (default `runs/*.json`), calls `aggregate` with `--by profile|puzzle|tier|stratum|batchIndex` (default `profile`) and `--compare a,b`, and prints `--json`, `--md` or a plain table. With `--inference` it reads `logs/inference/*.jsonl` through `eval/inference.ts` instead and supports `--since`, `--until`, `--model`, `--run`, `--slot` and `--dump`. The `--md` output is what gets committed under `docs/benches/` (B47).
- Decisions baked in:
  - `--md` emits GitHub-flavoured tables with a fixed column order per grouping, so committed bench outputs diff cleanly between runs.
  - Numbers are formatted to a fixed precision (accuracies 4 decimal places, USD 6, latency integer) so the same data always renders the same string.
  - `--compare` requires at least two names and errors with exit 2 otherwise.
  - A glob matching zero run records prints `no run records matched <glob>` and exits 3.
- Acceptance:
  1. `--by profile --md` over T40's aggregate fixtures produces a table whose header and row order are asserted against a committed golden string in the test.
  2. `--json` output parses and deep-equals the `Aggregation` object.
  3. `--by stratum` renders the two strata (A1); `--by batchIndex` renders one row per index.
  4. `--compare baseline,patient` prints a delta column; `--compare baseline` exits 2.
  5. `--inference --dump --run X` prints only records for run X, one JSON object per line.
  6. A zero-match glob exits 3 with the glob in the message.
  7. Formatting is stable: rendering the same fixture twice produces byte-identical output.
- Out of scope: aggregation logic (T40, T41).

### T47: `xw bench` handler
- Workstream: I (Eval)
- Model: sonnet
- Depends on: T0, T17, T23, T44, T45
- Owns: `src/cli/bench.ts`, `test/unit/cli/bench.test.ts`, `test/fixtures/sets/tiny.json`
- Reads (must not edit): `src/cli/solve.ts`, `src/eval/aggregate.ts`, `src/profiles/loader.ts`
- Spec sections: "CLI reference" (`bench`), A1, B1, B2, B28, B45
- Deliverable: the `bench` handler running the `(puzzle, profile, repeat)` matrix. `<puzzle-set>` is a JSON file `{ name, puzzles: [{ id, stratum }] }` (B36) or a glob. Flags: `--profiles a,b,c` (required), `--repeat` (default 1), `--offline`, `--concurrency` (default 2), `--no-inference-log`, `--out` (default `runs/`), `--max-usd` (default 25) and `--yes` (B45). Repeat index `r` feeds `sampleIndex` so each repeat is a fresh sample (B1). Before running, it prints a cost estimate (puzzles x profiles x repeats x estimated per-puzzle `usdCounterfactual`, from prior runs when available or a static estimate otherwise); if the estimate exceeds `--max-usd`, `--yes` is required or the command exits 2. During the run, a per-run status of 4 or 5 marks that run errored and the matrix continues; the command exits 6 if any run errored (B28). Aborting on the USD ceiling also exits 6.
- Decisions baked in:
  - Concurrency is over runs, not over slots; the rate limiter is shared process-wide so parallel runs share the model budget (spec).
  - The estimate uses `usdCounterfactual` (B2) so a warm cache does not make an expensive matrix look free.
  - A usage error (bad profile name, missing set file) fails before any run starts (B28).
  - The summary table at the end is produced by calling `aggregate` in-process, so bench and report can never disagree.
- Acceptance:
  1. With `solve()` mocked, a 2-puzzle x 2-profile x 2-repeat matrix issues 8 runs and writes 8 run records.
  2. `sampleIndex` differs per repeat index for the same `(puzzle, profile)` (B1).
  3. A mocked run returning exit 4 marks that run `status: "error"`, the matrix continues, and the command exits 6.
  4. An unknown profile name exits 2 before any run starts (assert `solve` was never called).
  5. An estimate above `--max-usd` without `--yes` exits 2 and runs nothing; with `--yes` it runs.
  6. Exceeding `--max-usd` mid-matrix aborts the remaining runs and exits 6.
  7. `--concurrency 2` never has more than 2 runs in flight (assert with an instrumented mock).
  8. The end-of-run summary table columns are exactly `profile, n, letters, words, perfect, usd per puzzle, usd per correct word`.
- Out of scope: the aggregation maths (T40); real solving.

### T48: Licence-clean xd fixtures and FIXTURES.md
- Workstream: A (Puzzle loading)
- Model: sonnet
- Depends on: T0, T25, T27
- Owns: `puzzles/fixtures/*.xd` (four files), `puzzles/fixtures/FIXTURES.md`
- Reads (must not edit): `src/sources/xd.ts`, `src/puzzle/adapters/xd.ts`, `docs/crossword-sources.md`
- Spec sections: "Repository layout", A3
- Deliverable: hand-pick **four** pre-1965 NYT puzzles from the xd corpus, commit them under `puzzles/fixtures/`, and write `puzzles/fixtures/FIXTURES.md` recording, per fixture: the source URL, the publication date, the grid size and **the specific public-domain basis claimed** (A3). The four should span sizes and difficulty: at minimum one 15x15 daily and one smaller puzzle. Verify each parses through T25's loader and passes the B42 leakage check.
- Decisions baked in:
  - Pre-1965 US publication with no evidence of renewal is the basis claimed; FIXTURES.md states it in those words per fixture, with the date that supports it. If a candidate puzzle's date cannot be established from the corpus metadata, it is not used.
  - No Guardian puzzle is ever committed as a fixture (A2 keeps that adapter to personal research).
  - The corpus itself is not committed; only the four `.xd` files are.
  - **This task is marked `needs-human-review`.** Open the PR and request Ben's sign-off on the licence basis before merge; do not self-merge.
- Acceptance:
  1. Exactly four `.xd` files exist under `puzzles/fixtures/`, each under 20 KB.
  2. Each parses through `loadPuzzle` without error and passes the B42 leakage assertion (add a test to the existing `test/unit/puzzle/xd.test.ts`? No - assert it in a new `test/unit/puzzle/fixtures.test.ts` **owned by this task**).
  3. `FIXTURES.md` has one section per fixture with all four required fields present and non-empty.
  4. Every recorded publication date is before 1965-01-01.
  5. `git check-ignore puzzles/fixtures/x.xd` reports the path is **not** ignored (the `.gitignore` negation works).
  6. The PR is labelled `needs-human-review` and names the licence basis in its description.
- Out of scope: the committed cache (T50); the corpus download.
- Also owns: `test/unit/puzzle/fixtures.test.ts` (new file, so no overlap with T25).

### T49: M2 spike - tier-1 reliability, rate-limit headers, reasoning-off parameter (**NETWORK**)
- Workstream: E (Prompting)
- Model: sonnet
- Depends on: T0, T31, T32, T33, T11
- Owns: `docs/spikes/tier1-reliability.md`, and **spec.md** (this is the only task in the plan permitted to edit `docs/spec.md`)
- Reads (must not edit): everything else
- Spec sections: "Rate limiting", "Open questions", B41
- Deliverable: **NETWORK task - the only one besides T50.** Send 200 real clues (drawn from the xd fixtures, american stratum, mixed lengths) through tier 1 with the seed prompt and measure: parse-failure rate, length-error rate after normalisation, the distribution of `clue_understood`, and per-call latency. Capture and tabulate the response headers Nebius actually returns, answering "which rate-limit headers does Nebius send, and is the limit a per-second bucket or a per-minute window". Discover the provider's reasoning-off / minimal-reasoning parameter for a `reasoning`-capable model by trying the documented candidates and comparing `reasoningTokens` in the usage blob. Write `docs/spikes/tier1-reliability.md` with the numbers, the header table and the parameter name, then make **one** spec edit recording the parameter name where B41 says it belongs.
- Decisions baked in:
  - Budget: hard cap of USD 2 for the whole spike; stop and report if reached.
  - The run goes through the real `client.ts` and the real inference log, so the raw data lands in `logs/inference/` and every number in the report is a query over it, not a hand tally.
  - Any malformed response found is copied into `test/fixtures/responses/` **only** by a follow-up task; this task does not add parser fixtures (T11 owns that directory).
  - The spec edit is a single paragraph replacing the "to be discovered in M2" wording in B41's spec text with the actual parameter name, plus filling the corresponding open question. Nothing else in spec.md changes.
  - If the parameter cannot be found, say so explicitly and leave `REASONING_OFF_PARAM` in place with the evidence.
- Acceptance:
  1. `docs/spikes/tier1-reliability.md` exists and reports: n, parse-failure rate, length-error rate, mean/p50/p95 latency, `clue_understood` histogram, and total USD spent.
  2. It contains a table of every distinct response header name observed, with an example value and whether it is a rate-limit header.
  3. It states, with evidence, whether the limit behaves as a per-second bucket or a per-minute window.
  4. It names the reasoning-off parameter (or records that none was found) with the before/after `reasoningTokens` figures that support the conclusion.
  5. The diff to `docs/spec.md` is confined to the B41 paragraph and the matching open question.
  6. `logs/inference/` is not committed (B47); the report cites counts, not raw records.
- Out of scope: changing any source file; adding parser fixtures.

### T55: Wave 1 follow-ups
- Workstream: J (infrastructure and cleanup)
- Model: sonnet
- Depends on: T14, T17, T5, T6, T19, T23
- Owns: test/unit/eval/runRecorder.test.ts, src/validate/normalise.ts, test/unit/validate/normalise.test.ts, test/unit/policy/budget.test.ts
- Reads (must not edit): test/fixtures/events/full-run.events.jsonl, src/grid/pattern.ts, src/profiles/builtins.ts, src/eval/runRecorder.ts
- Spec sections: Testing
- Deliverable: Three small consolidations left over from wave 1, where sibling tasks ran in parallel and could not depend on each other. (a) Re-point the RunRecord builder tests at the committed events fixture test/fixtures/events/full-run.events.jsonl instead of the in-file synthetic stream, and recompute the literal expectations (backtracks, repair.accepted, calls.tier1.count and friends) against that fixture; keep the synthetic builder only if a test needs a shape the fixture lacks. (b) Replace the local pattern-regex builder in src/validate/normalise.ts with regexFromPattern/patternMatches from src/grid/pattern.ts; behaviour must be identical, so no test expectation changes except deleting tests that only covered the local builder. (c) In test/unit/policy/budget.test.ts, use getBuiltin('baseline') from src/profiles/builtins.ts instead of ProfileSchema.parse({ name: 'baseline' }).
- Decisions baked in: pure refactor and test hygiene; no behaviour change; if (a) reveals a discrepancy between the recorder and the fixture, the fixture wins and the recorder bug is reported as a deviation, not silently fixed here.
- Acceptance: 1. runRecorder tests read the fixture via replay() or direct JSONL parsing and no longer define a synthetic event stream for the main path. 2. `grep -c 'A-Z' src/validate/normalise.ts` shows the local regex construction is gone and pattern.ts is imported. 3. budget tests import getBuiltin. 4. preflight passes with the same or higher test count.
- Out of scope: any change under src/eval, src/grid, src/profiles; spec edits.

## Wave 4: end to end, fixtures, benches

Starts once every Wave 3 task is merged.

### T50: Committed offline cache, `fixtures:refresh` and integration tests (**NETWORK**, one-off)
- Workstream: J (Infrastructure)
- Model: sonnet
- Depends on: T0, T35, T44, T45, T48
- Owns: `scripts/fixtures-refresh.ts`, `test/fixtures/cache/**`, `test/fixtures/runs/snapshots/*.json`, `test/integration/solve.test.ts`
- Reads (must not edit): `puzzles/fixtures/**`, `src/cli/*`, `src/solver/*`
- Spec sections: "Testing" (Integration tests), B49, B50
- Deliverable: **NETWORK task, run once by its author.** `npm run fixtures:refresh` solves each of T48's four fixtures under the `baseline`, `no-repair` and `tier1-only` profiles with the network on, exports the resulting candidate cache into `test/fixtures/cache/` via `xw cache export`, and regenerates the accuracy snapshots into `test/fixtures/runs/snapshots/` - **cache and snapshots are regenerated together in one commit** (B49). `test/integration/solve.test.ts` then runs `xw solve <fixture> --offline` for the same 12 combinations with zero network calls, asserting both an accuracy **bound** (letters >= 0.92 for `baseline` on the american fixtures) and the exact regenerable snapshot (B49).
- Decisions baked in:
  - Both assertion styles are kept: the bound catches a real regression, the snapshot catches an unintended behaviour change, and `fixtures:refresh` is the one sanctioned way to move the snapshot.
  - The integration test asserts zero network activity by stubbing `globalThis.fetch` with a throwing function for the duration.
  - The committed cache must stay under 20 MB; if it does not, reduce to two fixtures and say so in the PR.
  - A `promptVersion` bump invalidates this cache; the refresh script prints a warning naming that fact (B49).
  - The refresh script refuses to run without `NEBIUS_API_KEY` and prints the cost estimate before starting, honouring the same `--max-usd` default of 25 as bench (B45).
- Acceptance:
  1. `npm run fixtures:refresh` (with a key) produces a non-empty `test/fixtures/cache/` and a snapshot per `(fixture, profile)`.
  2. `npm test` with `NEBIUS_API_KEY` unset passes the integration suite entirely offline; a stubbed throwing `fetch` is never called.
  3. `baseline` on each american fixture asserts `letters >= 0.92`.
  4. Each snapshot assertion compares the full accuracy block and the per-slot filled answers.
  5. Deleting one file from `test/fixtures/cache/` makes the integration test fail with a code-4 offline miss naming the key, not with a hang or a network call.
  6. The committed cache is under 20 MB (assert with a size check in the test).
  7. `no-repair` and `tier1-only` snapshots differ from `baseline`, proving the profiles are actually taking effect.
- Out of scope: the fixtures themselves (T48); the bench matrix (T54).

### T51: End-to-end smoke and dist smoke
- Workstream: J (Infrastructure)
- Model: sonnet
- Depends on: T0, T1, T29, T45, T50
- Owns: `test/integration/smoke.test.ts`, `scripts/smoke-container.sh`
- Reads (must not edit): `Dockerfile`, `docker-compose.yml`, `xw`, `package.json`
- Spec sections: "Quick start", "Testing", B50
- Deliverable: two smoke checks. First, the container end-to-end path: `scripts/smoke-container.sh` runs, inside `crossword-solver`, `xw fetch file puzzles/fixtures/<one>.xd` followed by `xw solve <id> --offline`, and asserts both exit 0 and that the printed accuracy block appears. Second, the dist smoke (B50): `npm run build` then `node dist/cli/index.js --version`, so `dist/` is exercised at least once and a build-only breakage is caught.
- Decisions baked in:
  - The container script is a shell script, not a vitest test, because it needs `docker exec`; CI's `image` job does not run it (B48 keeps that job to a build), so it is documented in the README as a manual pre-release check and is also runnable inside the container against the local checkout.
  - The dist smoke **is** a vitest test, so CI runs it: it shells out to `npm run build` and then to `node dist/cli/index.js --version`, with a generous timeout.
  - Neither check touches the network; the fetch is from a local fixture path via the `file` adapter.
- Acceptance:
  1. `npm test` runs the dist smoke, which builds and prints a version matching `package.json`.
  2. `sh -n scripts/smoke-container.sh` passes and the script uses `set -eu`.
  3. Run inside the container, the script exits 0 and its output contains `letters` and `words` accuracy lines.
  4. The script leaves no file under `puzzles/` other than the `file`-source copies it created, and it removes them at the end.
  5. Both checks pass with `NEBIUS_API_KEY` unset.
- Out of scope: CI changes (T2 owns the workflow).

### T52: Bench definitions and docs skeleton
- Workstream: I (Eval)
- Model: haiku
- Depends on: T0, T46
- Owns: `sets/mixed-30.json`, `docs/benches/README.md`, `docs/benches/.gitkeep`
- Reads (must not edit): `src/cli/bench.ts`, `src/eval/aggregate.ts`
- Spec sections: "Strategy profiles" (both bench definitions), A1, B36, B47
- Deliverable: `sets/mixed-30.json` in the B36 shape `{ name, puzzles: [{ id, stratum }] }` with 30 entries - 20 `american` and 10 `cryptic` (A1) - and `docs/benches/README.md` explaining that this directory holds the committed `report --md` output per bench (B47), with the two bench recipes and their decision rules quoted from the spec, and a placeholder table per bench to be filled when the run happens.
- Decisions baked in:
  - **Puzzle ids are placeholders** written as `TODO-american-01` ... and are filled in by whoever runs the bench, because the ids depend on which corpus slice and which Guardian ids are available at that time. The file validates structurally now and the schema check enforces the 20/10 split.
  - The escalation-policy decision and the batch-size decision are made on the **american** stratum only (A1); the README states that next to each decision rule.
  - Nothing under `docs/benches/` is generated by a test; it is committed output.
- Acceptance:
  1. `sets/mixed-30.json` parses and has exactly 30 entries, 20 with `stratum: "american"` and 10 with `"cryptic"`.
  2. Every entry has both `id` and `stratum` and no other keys.
  3. `docs/benches/README.md` contains both bench command lines verbatim from the spec (with `xw`, not `crossword`) and both decision rules.
  4. It states that both decisions are made on the american stratum only.
  5. `sets/` is not gitignored (assert with `git check-ignore`).
- Out of scope: running a bench (T54); filling in real ids.

### T53 (deferred to v1.1): `votes` and `blend` calibration with offline weight fitting
- Workstream: F (Candidate service)
- Model: opus
- Depends on: T13, T34, T50
- Owns: `src/score/calibrate.ts` (extending T13's file), `scripts/fit-calibration.ts`, `config/calibration.json`, `test/unit/score/calibrate.votes.test.ts`
- Spec sections: "Candidate service" step 5, "Milestones" M6, B4, B22
- Status: **DEFERRED. Do not start during v1 (M1-M5). B4 puts this in M6/v1.1.**
- Deliverable: implement `votes` (`score = votes / samples`, rank as tie-break, requires `samples >= 3` at temperature 0.7 per B22's refine) and `blend` (`w1*voteFraction + w2*(1/(2+rank)) + w3*selfConfidence`). Add an offline fitting script that runs logistic regression of "is the truth" against the three features over the committed fixture runs and writes the fitted weights into `config/calibration.json`.
- Decisions baked in: fitting is offline only and never runs during a solve; the committed weights are data, not code; the fitting set is the fixture puzzles plus any bench runs available, and the script records n and the fitting date in the JSON.
- Acceptance: `votes3` produces different orderings from `baseline` on a fixture where the two disagree; `blend` with weights `[1,0,0]` equals `votes` and with `[0,1,0]` equals `rank`; the fitting script is deterministic given the same input runs; `samples: 1` with `mode: "votes"` is a usage error.
- Out of scope during v1: everything. This entry exists so the id is reserved and the file ownership is pre-declared.

### T54 (deferred to v1.1): escalation-policy and batch-size bench runs
- Workstream: I (Eval)
- Model: sonnet
- Depends on: T46, T47, T50, T52, T53
- Owns: `docs/benches/escalation-policy.md`, `docs/benches/batch-size.md`
- Spec sections: "Strategy profiles" (both bench definitions), A1, B4
- Status: **DEFERRED. B4 puts both runs in M6/v1.1, after the repair pass and with repair on.**
- Deliverable: run
  `xw bench sets/mixed-30.json --profiles baseline,eager-escalation,patient --repeat 2` then
  `xw report --by profile --compare baseline,eager-escalation,patient --md`, and
  `xw bench sets/mixed-30.json --profiles batch1,batch2,batch3,batch5,batch8 --repeat 2` then
  `xw report --by batchIndex --compare batch1,batch2,batch3,batch5,batch8 --md`.
  Commit each report as a file under `docs/benches/` (B47) and record the decision the rule produces.
- Decisions baked in:
  - Escalation decision rule (spec): pick the profile with the highest perfect-puzzle rate, unless its USD per correct word exceeds the best other profile's by more than a factor of 1.5, in which case pick that other profile. Report the letter-accuracy delta alongside but do not decide on it.
  - Batch-size decision rule (spec): pick the largest batch size whose top-k recall is within 2 percentage points of `batch1` and whose positional accuracy shows no monotonic decline across positions; otherwise stay at 1.
  - Both decisions are made on the **american stratum only** (A1); the cryptic rows are reported but not decided on.
  - All cost figures use `usdCounterfactual` (B2).
- Acceptance: each file contains the command run, the full `--md` table, the stratum split, and one paragraph stating the decision the rule produced and the numbers that produced it.
- Out of scope during v1: everything. Reserved id.

## Wave 5: follow-ups (2026-09-04)

### T56: Remove real puzzles from the repository; synthetic-only fixtures
- Workstream: A (puzzle loading) / J
- Model: sonnet
- Depends on: T48, T50, T51, T52
- Owns: puzzles/fixtures/** (deletion), test/fixtures/cache/** (prune), test/fixtures/runs/** (prune and regenerate), test/integration/solve.test.ts, test/integration/smoke.test.ts, scripts/fixtures-refresh.ts, sets/mixed-30.json, .gitignore (the puzzles/fixtures re-include lines only), test/unit/puzzle/fixtures.test.ts
- Reads (must not edit): src/**, docs/**
- Spec sections: Testing; Puzzle library and sources
- Deliverable: Delete puzzles/fixtures/ entirely (the four nyt-*.xd files and FIXTURES.md). Remove every committed cache entry under test/fixtures/cache/ that was produced for those four puzzles (identify them by the clue text or puzzle id recorded in each entry; keep only entries for synthetic-5x5 and synthetic-7x7), remove their snapshots and run records under test/fixtures/runs/, and regenerate bounds.json and the synthetic snapshots offline from the remaining cache (`FIXTURES_REFRESH_OFFLINE_ONLY=1`). Point scripts/fixtures-refresh.ts and both integration tests at the synthetic fixtures only; the fixtures unit test asserts that no file under puzzles/ is tracked by git and that the synthetic fixtures still satisfy B42. Remove the `!puzzles/fixtures` re-include lines from .gitignore so all of puzzles/ is ignored. In sets/mixed-30.json replace the four nyt entries with placeholders so the file keeps its 30-entry, 20 american / 10 cryptic shape, and reword its note to say puzzles are fetched on demand and never committed.
- Decisions baked in: the no-distribution policy above overrides decisions A3 and B47 (the docs task T57 records that); the cache prune must be exact: a cache entry stays only if its clue and length match a slot in one of the two synthetic fixtures; git history is out of scope for this task (the orchestrator handles it).
- Acceptance: 1. `git ls-files puzzles` prints nothing after the commit. 2. `git ls-files test/fixtures/cache | wc -l` is smaller and `grep -rl "Agog\|Senor\|1625" test/fixtures/` prints nothing (spot-check strings from the removed puzzles). 3. Integration tests run only synthetic-5x5 and synthetic-7x7 and pass offline. 4. bounds.json lists only the two synthetic ids. 5. preflight passes.
- Out of scope: src/ changes; the tier-1 router; docs other than the sets note.

### T57: Documentation follow-ups and bench-set contract test
- Workstream: J
- Model: sonnet
- Depends on: T52, T56
- Owns: README.md, docs/spec.md (Decisions log rows and Testing fixture wording only), docs/decisions/2026-09-03-spec-review.md (append-only addendum), docs/benches/README.md, test/contract/sets.test.ts
- Reads (must not edit): sets/mixed-30.json, scripts/smoke-container.sh
- Spec sections: Testing; Strategy profiles
- Deliverable: README gains a "Puzzles are never committed" paragraph (fetch on demand, no distribution, only synthetic fixtures live in the repo) and a "Manual pre-release check" paragraph documenting `docker compose up -d` then `sh scripts/smoke-container.sh`. docs/spec.md: update the Decisions log rows for fixture policy and for what is committed (A3, B47) to the new policy, and fix the Testing section's fixture wording; note the four spec touch-ups recorded in docs/build-notes (rate:limited colon event names, zod prefault, widened SolveDeps, typecheck config, scorer takes the solution as an argument). docs/decisions/2026-09-03-spec-review.md: append a dated addendum "2026-09-04: A3 and B47 superseded: no real puzzles committed" (append-only, do not rewrite earlier text). docs/benches/README.md: state that both benches are re-run in M6 with the repair pass enabled. Add test/contract/sets.test.ts asserting sets/mixed-30.json has exactly 30 entries, 20 american and 10 cryptic, each with only id and stratum keys, and that no id starts with a real-publisher prefix like nyt-.
- Decisions baked in: append-only edits to the decisions record; plain ASCII; test/contract is normally frozen but this task is pre-authorised to add the one new test file.
- Acceptance: 1. README contains both paragraphs. 2. sets contract test passes and fails if an entry gains an extra key (prove with a temporary local edit, reverted). 3. preflight passes. 4. `grep -n "not renewed\|FIXTURES.md" README.md docs/spec.md` prints nothing.
- Out of scope: any code under src/.

### T58: Send reasoning-off for every tier-1 call; refresh the synthetic cache (NETWORK)
- Workstream: E
- Model: opus
- Depends on: T49, T56
- Owns: src/llm/tierRouter.ts, test/unit/llm/tierRouter.test.ts, test/fixtures/cache/** (regenerate), test/fixtures/runs/** (regenerate), docs/spikes/tier1-reliability.md (append a dated follow-up section only)
- Reads (must not edit): src/candidates/service.ts, scripts/fixtures-refresh.ts, docs/build-notes/wave-4.md
- Spec sections: Candidate service (tier routing, batching); Strategy profiles
- Deliverable: Change the router so the reasoning-off parameter is sent for every tier-1 call on a model that advertises reasoning, regardless of purpose (seed, constrained, escalate contexts alike), with unit tests for each purpose. Then refresh the committed cache for the two synthetic fixtures against Nebius (`npm run fixtures:refresh` inside a container with the .env copied from the main checkout; expected spend well under 0.10 USD), regenerate snapshots and bounds, and confirm both fixtures now replay under strict `--offline` (bounds.json offlineMode strict). Append a short dated section to the spike doc recording the before/after: number of tier-1 non-seed calls that parsed, and whether strict replay converges.
- Decisions baked in: decision B41's "purpose is seed" clause is superseded; the cache key is unchanged (the parameter is not a key field), so old entries are simply overwritten on refresh; if strict replay still fails after the fix, record exactly which (clue, pattern, purpose) key misses and keep lenient mode for that fixture rather than guessing.
- Acceptance: 1. tierRouter tests cover seed, constrained and escalate purposes on a reasoning model and a non-reasoning model. 2. Integration tests pass with offlineMode strict for both synthetic fixtures, or the report names the exact missing key. 3. preflight passes with no network in the test container. 4. The spike doc has the dated follow-up section.
- Out of scope: real puzzles; the bench runs; calibration.

## Wave 6: features (2026-09-04)

### T59: xw show --run: render a past run's answers
- Workstream: C (CLI)
- Model: sonnet
- Depends on: T30, T45
- Owns: src/cli/show.ts, src/eval/runs.ts (new), test/unit/cli/show.test.ts, test/unit/eval/runs.test.ts; pre-authorised: the `--run [runId]` option in src/cli/index.ts and src/cli/options.ts, the `show` entry in docs/spec.md's CLI reference, one README usage line.
- Reads (must not edit): src/eval/runRecorder.ts (how run records are written and where: the runs directory resolution in src/util/fs.ts), src/eval/types.ts (RunRecord shape, especially perSlot filled answers and puzzle.id, timestamp, profile), src/puzzle/library.ts, the existing --solution rendering path in src/cli/show.ts.
- Spec sections: CLI reference (show); Metrics and run records.
- Deliverable: `xw show <id> --run [runId]` renders the grid the solver PRODUCED in a past run instead of the true solution, using exactly the same grid renderer and the same clue lists that `--solution` uses (byte-identical output format; only the letters differ), preceded by one header line `Run <runId> (<ISO timestamp>, profile <name>): letters <x.xxx> words <x.xxx> perfect <yes|no>` taken from the run record. Cells no slot filled render as blank in whatever way the renderer shows an empty cell (pick the renderer's existing empty-cell glyph; do not invent a new one). A missing runId (`--run` with no value) selects the most recent run record for that puzzle id (by the record's timestamp) in the runs directory; an explicit value matches a full runId or a unique prefix. Implement the record lookup in src/eval/runs.ts: `listRuns(runsDir, puzzleId)`, `latestRun(runsDir, puzzleId)`, `findRun(runsDir, runIdOrPrefix)`, each reading `*.json` run records, tolerating unreadable or foreign JSON files by skipping them with a warning, and never loading `.events.jsonl` files. Reconstruct the letters matrix from the run record's per-slot filled answers placed along each slot's cells from the normalised puzzle (Slot start row/col, direction, length); later slots must agree with earlier ones at crossings (they do, since they came from one grid), but if they disagree, prefer the across answer and warn once. Errors: no run for the puzzle -> NOT_FOUND (exit 3) with hint `run: xw solve <id>`; runId not found -> NOT_FOUND; runId matches a record for a different puzzle -> USAGE (exit 2) naming both ids; ambiguous prefix -> USAGE listing the candidates. `--run` combined with `--solution` is a USAGE error.  Existing `xw show` behaviour with and without `--solution` must be unchanged (assert the existing tests still pass untouched).
- Decisions baked in: reuse the renderer, do not fork it; runs directory comes from the same resolver the solve command uses (`--out` is not consulted; document that); commander option is `--run [runId]` so the bare flag yields `true` and means latest; the header line is the only addition to the output; no diff markers in this task (a later task can add `--run --diff`).
- Acceptance: 1. With a temp runs dir holding two records for puzzle P (timestamps t1 < t2) and one for puzzle Q, `show P --run` renders t2's answers and the header names t2's runId. 2. `show P --run <t1 runId>` and `show P --run <unique prefix of t1>` render t1. 3. `show P --run <Q's runId>` exits 2 naming P and Q; an ambiguous prefix exits 2 listing both; an empty runs dir exits 3 with the hint. 4. When a run record's filled answers equal the solution, the grid and clue sections of `show P --run <id>` are byte-identical to `show P --solution` (compare captured stdout with the header line removed). 5. A partial run (some slots unfilled) renders blank cells and does not throw. 6. `--run` with `--solution` exits 2. 7. runs.ts skips a non-record JSON file and a `.events.jsonl` file in the runs dir with a warning and still returns the valid records. 8. preflight passes; existing show tests unchanged.
- Out of scope: diff markers, watch-style colouring, changes to how runs are written.

### T60: Fetch passes source style and date through; mixed-12 bench set
- Workstream: C (CLI / sources)
- Model: sonnet
- Depends on: T29, T26, T28, T57
- Owns: src/cli/fetch.ts, test/unit/cli/fetch.test.ts, sets/mixed-12.json; pre-authorised: src/puzzle/types.ts (PuzzleAdapterContext style/date fields only), src/puzzle/loader.ts (forward them), src/puzzle/adapters/guardian.ts and src/puzzle/adapters/xd.ts and src/puzzle/adapters/xwordly.ts (only to honour ctx.style/ctx.date when provided, with the file's own value as fallback), docs/crossword-sources.md (one line), test/contract/sets.test.ts (mixed-12 cases).
- Reads (must not edit): src/sources/guardian.ts, src/sources/xd.ts, src/sources/types.ts, docs/build-notes/wave-2.md sections T26, T28, T29.
- Spec sections: Puzzle library and sources; Strategy profiles (puzzle sets).
- Deliverable: (1) `xw fetch` currently normalises every downloaded puzzle through the generic loader with a context that carries no style, so Guardian cryptics land with style `unknown` even though the Guardian source adapter's own ref (`guardian-<series>-<id>`) names the series (cryptic, quick, prize, ...). Fix: fetch derives `style` from the Guardian series encoded in the ref (mapping per the spec's "Puzzle library and sources" guardian bullet: cryptic|prize|quiptic|everyman|weekend -> cryptic, quick|speedy -> quick) and passes it into the loader context alongside the existing `date` passthrough, and `src/puzzle/adapters/guardian.ts`'s registry-dispatch `parse()` honours `ctx.style` (falling back to `unknown`) instead of hardcoding `unknown`. `src/puzzle/adapters/xwordly.ts` already honours `ctx.style`/`ctx.date` (T24, ahead of the T0 contract, via its own `XwordlyAdapterContext` extension) - once `style` is a real field on `PuzzleAdapterContext` this needs no further edit. `src/puzzle/adapters/xd.ts` keeps its date-from-path/metadata detection and hardcoded `american` style unchanged: the spec gives `.xd` no format-level style signal, and the xd source's own `list()` already puts a real date on every `PuzzleRef` (unlike Guardian's, whose `list()` sets no `date` field at all - there being no per-puzzle date signal available to it in v1). (2) Create sets/mixed-12.json in the same schema as sets/mixed-30.json: name "mixed-12", a note saying it is the first real bench set (8 pre-1965 NYT dailies fetched from the xd corpus, 4 Guardian cryptics; puzzles are fetched locally and never committed), and exactly these entries with strata: xd-nyt1951-01-02, xd-nyt1953-01-01, xd-nyt1955-01-03, xd-nyt1957-01-01, xd-nyt1959-01-01, xd-nyt1961-01-02, xd-nyt1963-01-01, xd-nyt1964-01-01 as american; guardian-cryptic-30100, guardian-cryptic-30101, guardian-cryptic-30102, guardian-cryptic-30103 as cryptic. Do NOT edit sets/mixed-30.json. Extend test/contract/sets.test.ts with cases for mixed-12: exactly 12 entries, 8 american and 4 cryptic, id/stratum keys only, unique ids. (3) In docs/crossword-sources.md correct the xd corpus description: xd-puzzles.zip is the whole corpus (about 89,000 puzzles across 32 publishers, 1942 to 2025, roughly 175 MB); the pre-1965 NYT slice (about 3,800 puzzles) is obtained by fetching with --from/--to date filters; there is no separate public-domain download.
- Decisions baked in: fetch passes the source's style and date; adapters prefer the context value over their own detection because the source adapter has the authoritative series; the existing fetch tests must keep passing; no network in tests (Guardian listing fixtures already exist under test/fixtures/guardian).
- Acceptance: 1. A unit test in test/unit/cli/fetch.test.ts fetches a Guardian cryptic from the listing and payload fixtures with injected fetch and asserts the normalised JSON has style cryptic and the puzzle's date. 2. The same for a quick series asserts the mapped style. 3. The xd path still yields american and the date from the path. 4. sets contract test passes for mixed-12 and mixed-30. 5. preflight passes. 6. `grep -n '6,000\|pre-1965 New York Times puzzles' docs/crossword-sources.md` no longer describes the archive as a pre-1965 slice.
- Out of scope: re-fetching real puzzles (the orchestrator does that after merge); bench runs; any src/solver change.

### T61: Price cache hits counterfactually in run records and the cost block
- Workstream: I (eval)
- Model: opus
- Depends on: T17, T34, T44, T45
- Owns: src/candidates/service.ts, src/eval/runRecorder.ts, src/cli/solve.ts (cost tally only), test/unit/candidates/service.test.ts, test/unit/eval/runRecorder.test.ts, test/unit/cli/solve.test.ts, test/fixtures/events/full-run.events.jsonl (add a cache-hit usage event if needed); pre-authorised: src/events/types.ts only to add optional fields to the existing `llm:usage` payload (`cacheHit?: boolean`, plus the usage token counts needed for pricing if they are missing), schemas/run-record.schema.json only if a field's description changes (no new required fields), docs/spec.md only the Metrics and run records sentences that define usdBilled and usdCounterfactual, docs/plan.md (this block and its index row).
- Reads (must not edit): docs/decisions/2026-09-03-spec-review.md (B2), docs/spec.md Metrics and run records, src/candidates/cache.ts (CacheEntry carries the usage blob), src/eval/aggregate.ts, src/cli/bench.ts (the estimate uses usdCounterfactual).
- Spec sections: Metrics and run records; Candidate service (cache).
- Deliverable: Bug, found by verifying a real bench run: every run record has usdBilled equal to usdCounterfactual even when most calls were cache hits, and a profile that ran after another on the same puzzle inherited the cache and showed near-zero cost, distorting the bench decision that decision B2 says must be made on usdCounterfactual. Root cause to confirm: the candidate service emits llm:usage only for cold transport calls, and the RunRecorder derives both usd figures from llm:usage, so cache hits contribute to neither. Fix: on a cache hit the service emits the usage event with the cached entry's usage blob and a cacheHit flag (the CacheEntry stores usage precisely for this); the RunRecorder prices EVERY usage event into calls.<tier>.usdCounterfactual (using src/llm/pricing.ts and the model recorded on the event) and only non-hit events into usdBilled; cacheHits counts stay as they are; perSlot.usd is counterfactual; the run:end / cost:summary payload and the solve command's printed cost block show both billed and counterfactual (label them). The inference log is untouched (it already records hits). Also make sure the bench summary table and xw report use usdCounterfactual for usd per puzzle and usd per correct word (read aggregate.ts and bench.ts; if they already do, add a test that proves it with a record containing hits).
- Decisions baked in: B2 (decide on counterfactual), B29 (price from models.json at write time), no change to cache keys or to which calls hit the cache; the fix must not double-count cold calls (a cold call's usage is emitted once, with cacheHit false).
- Acceptance: 1. A service unit test with a stub transport and a pre-populated cache shows a hit emits a usage event carrying the cached usage and cacheHit true, and a cold call emits one with cacheHit false. 2. A RunRecorder test feeding two usage events (one hit, one cold, same model) yields usdCounterfactual equal to the priced sum of both and usdBilled equal to the cold one only, with cacheHits 1. 3. A solve command test shows the printed cost block contains both figures and they differ when the fixture cache is warm. 4. The offline integration tests still pass and their snapshots' usdCounterfactual is now non-zero for cache-served slots (regenerate the two synthetic snapshots offline with FIXTURES_REFRESH_OFFLINE_ONLY=1 if accuracy fields are unchanged and only cost fields moved; state the before and after). 5. preflight passes.
- Out of scope: bench ordering changes; any pricing of tier-2 differently; report layout.

## Task index

The orchestrator dispatches from this table. `Owns` is abbreviated; the task section is authoritative.

| id | title | wave | ws | model | depends on | owns (abbreviated) |
| --- | --- | --- | --- | --- | --- | --- |
| T0 | Contracts, scaffold and synthetic fixtures | 0 | J | opus | - | package.json, tsconfig, eslint, vitest, .gitignore, all `src/**` contracts and stubs, `schemas/*`, synthetic fixtures |
| T1 | Docker image, compose, wrapper, README | 1 | J | sonnet | T0 | Dockerfile, docker-compose.yml, docker/entrypoint.sh, xw, .env.example, README.md |
| T2 | GitHub Actions CI workflow | 1 | J | haiku | T0 | .github/workflows/ci.yml |
| T3 | Grid model | 1 | B | sonnet | T0 | src/grid/model.ts |
| T4 | DomainStore with depth-indexed trail | 1 | B | opus | T0 | src/grid/domainStore.ts |
| T5 | Pattern string and regex builder | 1 | B | sonnet | T0 | src/grid/pattern.ts |
| T6 | Normalisation and validation chain | 1 | A | sonnet | T0 | src/validate/normalise.ts |
| T7 | Clue numbering, slot extraction, enumeration | 1 | A | sonnet | T0 | src/puzzle/numbering.ts, src/puzzle/enumeration.ts |
| T8 | Pricing from models.json | 1 | D | sonnet | T0 | src/llm/pricing.ts, test/fixtures/models.min.json |
| T9 | Per-model rate limiter with AIMD | 1 | D | sonnet | T0 | src/llm/rateLimiter.ts |
| T10 | Inference log writer | 1 | D | sonnet | T0 | src/llm/inferenceLog.ts |
| T11 | Candidate response parser | 1 | E | opus | T0 | src/llm/parser.ts, test/fixtures/responses/* |
| T12 | Candidate cache (disk + LRU) | 1 | F | sonnet | T0 | src/candidates/cache.ts |
| T13 | Rank calibration | 1 | F | sonnet | T0 | src/score/calibrate.ts, config/calibration.json |
| T14 | ConsoleRenderer and events fixture | 1 | H | sonnet | T0 | src/render/console.ts, test/fixtures/events/full-run.events.jsonl |
| T15 | EventBus, JsonlEventSink, replay | 1 | H | sonnet | T0 | src/events/bus.ts, src/render/jsonl.ts, src/render/replay.ts |
| T16 | Scorer | 1 | I | sonnet | T0 | src/eval/scorer.ts |
| T17 | RunRecord builder | 1 | I | sonnet | T0 | src/eval/runRecorder.ts, src/util/git.ts |
| T18 | Escalation policy | 1 | G | sonnet | T0 | src/policy/escalation.ts |
| T19 | Budget policy | 1 | G | sonnet | T0 | src/policy/budget.ts |
| T20 | Variable ordering | 1 | G | sonnet | T0 | src/solver/ordering.ts |
| T21 | Puzzle library and locked index | 1 | C | sonnet | T0 | src/puzzle/library.ts |
| T22 | File source adapter | 1 | C | sonnet | T0 | src/sources/file.ts |
| T23 | Profiles: built-ins, resolution, config | 1 | J | sonnet | T0 | src/profiles/builtins.ts, src/profiles/loader.ts, src/config.ts |
| T24 | Loader adapter for .puz/.ipuz/.jpz | 2 | A | sonnet | T0,T7,T21 | src/puzzle/adapters/xwordly.ts, format fixtures |
| T25 | Loader adapter for .xd | 2 | A | sonnet | T0,T7,T21 | src/puzzle/adapters/xd.ts, .xd fixtures |
| T26 | Guardian JSON puzzle adapter | 2 | A | sonnet | T0,T7,T21 | src/puzzle/adapters/guardian.ts, guardian payload fixture |
| T27 | xd source adapter | 2 | C | sonnet | T0,T21,T22 | src/sources/xd.ts, xd-mini fixtures |
| T28 | Guardian source adapter | 2 | C | sonnet | T0,T21,T26 | src/sources/guardian.ts, guardian listing fixtures |
| T29 | `xw fetch` handler | 2 | C | sonnet | T0,T21,T22,T24-T28 | src/cli/fetch.ts |
| T30 | `xw list` and `xw show` handlers | 2 | C | sonnet | T0,T21 | src/cli/list.ts, src/cli/show.ts |
| T31 | Prompt templates | 2 | E | opus | T0 | src/llm/prompts.ts, test/fixtures/prompts/* |
| T32 | Tier router | 2 | E | sonnet | T0,T8 | src/llm/tierRouter.ts |
| T33 | Nebius transport client | 2 | D | sonnet | T0,T9,T10 | src/llm/client.ts, test/helpers/stubHttpServer.ts |
| T34 | CandidateService | 2 | F | opus | T0,T6,T11,T12,T13,T31,T32 | src/candidates/service.ts, test/helpers/stubTransport.ts |
| T35 | `xw cache` subcommand | 2 | F | sonnet | T0,T12 | src/cli/cache.ts |
| T36 | AC-3 prepass | 2 | G | opus | T0,T4,T5 | src/solver/ac3.ts, test/fixtures/domains/ac3-* |
| T37 | Search core | 2 | G | opus | T0,T3,T4,T5,T20 | src/solver/search.ts, test/fixtures/domains/search-* |
| T38 | Search hooks: re-ask, escalation, budget | 2 | G | opus | T0,T18,T19,T34 | src/solver/hooks.ts |
| T39 | WatchRenderer | 2 | H | sonnet | T0,T14 | src/render/watch.ts |
| T40 | Report aggregation | 2 | I | sonnet | T0,T17 | src/eval/aggregate.ts, test/fixtures/runs/aggregate/* |
| T41 | Inference log report | 2 | I | sonnet | T0,T10 | src/eval/inference.ts, test/fixtures/inference/* |
| T42 | Repair pass | 3 | G | opus | T0,T3,T5,T34 | src/solver/repair.ts, test/fixtures/domains/repair-* |
| T43 | Word list | 3 | F | sonnet | T0 | src/validate/wordlist.ts, scripts/wordlist-fetch.ts, test/fixtures/wordlist.txt |
| T44 | `solve()` orchestration | 3 | G | opus | T0,T3,T4,T16,T19,T34,T36,T37,T38,T42 | src/solver/solve.ts |
| T45 | `xw solve` handler | 3 | J | sonnet | T0,T14,T15,T17,T21,T23,T33,T34,T39,T44 | src/cli/solve.ts |
| T46 | `xw report` handler | 3 | I | sonnet | T0,T40,T41 | src/cli/report.ts |
| T47 | `xw bench` handler | 3 | I | sonnet | T0,T17,T23,T44,T45 | src/cli/bench.ts, test/fixtures/sets/tiny.json |
| T48 | Licence-clean xd fixtures + FIXTURES.md | 3 | A | sonnet | T0,T25,T27 | puzzles/fixtures/*.xd, puzzles/fixtures/FIXTURES.md, test/unit/puzzle/fixtures.test.ts |
| T49 | M2 spike: tier-1 reliability (**NETWORK**) | 3 | E | sonnet | T0,T11,T31,T32,T33 | docs/spikes/tier1-reliability.md, docs/spec.md |
| T50 | Committed cache, fixtures:refresh, integration (**NETWORK**) | 4 | J | sonnet | T0,T35,T44,T45,T48 | scripts/fixtures-refresh.ts, test/fixtures/cache/**, test/fixtures/runs/snapshots/*, test/integration/solve.test.ts |
| T51 | End-to-end smoke and dist smoke | 4 | J | sonnet | T0,T1,T29,T45,T50 | test/integration/smoke.test.ts, scripts/smoke-container.sh |
| T52 | Bench definitions and docs skeleton | 4 | I | haiku | T0,T46 | sets/mixed-30.json, docs/benches/README.md |
| T53 | votes/blend calibration + fitting (**deferred v1.1**) | 4 | F | opus | T13,T34,T50 | src/score/calibrate.ts, scripts/fit-calibration.ts |
| T54 | Escalation and batch-size bench runs (**deferred v1.1**) | 4 | I | sonnet | T46,T47,T50,T52,T53 | docs/benches/escalation-policy.md, docs/benches/batch-size.md |
| T55 | Wave 1 follow-ups | 3 | J | sonnet | T14,T17,T5,T6,T19,T23 | runRecorder.test.ts, validate/normalise.ts, budget.test.ts |
| T56 | Remove real puzzles; synthetic-only fixtures | 5 | A | sonnet | T48,T50,T51,T52 | puzzles/fixtures (delete), test/fixtures/cache, test/fixtures/runs, integration tests, fixtures-refresh, sets |
| T57 | Documentation follow-ups and bench-set contract test | 5 | J | sonnet | T52,T56 | README.md, docs/spec.md rows, decisions addendum, docs/benches/README.md, test/contract/sets.test.ts |
| T58 | Reasoning-off for every tier-1 call; refresh synthetic cache (NETWORK) | 5 | E | opus | T49,T56 | src/llm/tierRouter.ts, its test, test/fixtures/cache, test/fixtures/runs, spike doc addendum |
| T59 | xw show --run: render a past run's answers | 6 | C | sonnet | T30,T45 | src/cli/show.ts, src/eval/runs.ts, cli option, tests, docs |
| T60 | Fetch passes source style and date through; mixed-12 bench set | 6 | C | sonnet | T29,T26,T28,T57 | src/cli/fetch.ts, loader context, sets/mixed-12.json, sets contract test, sources doc line |
| T61 | Price cache hits counterfactually in run records and the cost block | 6 | I | opus | T17,T34,T44,T45 | candidates/service.ts, eval/runRecorder.ts, cli/solve.ts cost tally, event payload, tests |

Counts: Wave 0 = 1, Wave 1 = 23, Wave 2 = 18, Wave 3 = 9, Wave 4 = 5 (2 deferred), Wave 5 = 3, Wave 6 = 3. Total 62, of which 60 are in v1 (M1-M5).

Model split: opus 11 (T0, T4, T11, T31, T34, T36, T37, T38, T42, T44, T53 - contracts, the trail, the parser, prompt design, the candidate service, AC-3, search, hooks, repair, orchestration and calibration fitting), haiku 2 (T2, T52), sonnet 42.

Network-touching tasks: **T49** and **T50** only. Every other task must pass with `globalThis.fetch` stubbed to throw.

## Merge order and conflict rules

**Merge order.** PRs merge wave by wave. Within a wave, any order: no two tasks in a wave own the same file, so no rebase conflict is possible between wave-mates. Before a wave opens, every PR in the previous wave must be merged to `main` and `main` must be green on CI. Rebase on `main` before opening the PR, not after.

**File ownership is absolute.** If your task needs a change in a file you do not own:

1. **Do not change it.** Not even a one-line type widening, not even to make your tests compile.
2. Open a **contract-fix task**: a new id (`T55`, `T56`, ... allocated by the orchestrator), single owner, touching only the contract file and nothing else, with a one-line description of the change and the tasks that need it.
3. The contract fix merges on its own, ahead of the tasks that need it. Everyone with an open branch rebases.
4. Never patch a contract inside a feature task, even when it is obviously right. A contract changed in two feature branches at once is the one failure mode that costs more than the change itself.

**When T0's contracts turn out wrong.** Same rule, and it will happen: a type that looked right in the abstract will be wrong once a real implementation touches it. Expect two or three contract-fix tasks in Wave 1 and one or two in Wave 2. Budget for them rather than treating them as failures. The contract-fix owner updates the contract, the JSON schema if the shape is a wire format, and nothing else; the tests that prove the new shape belong to the feature task that needed it.

**`promptVersion` is frozen at `"1"` for v1.** Only T31 owns it. A bump is a separate single-owner action that lands the regenerated cache and snapshots in the same commit (B49). No feature task bumps it, ever.

**`package.json` is frozen after T0.** Every script and dependency any later task needs is declared in T0, with stub script files where the implementation comes later. If a dependency genuinely turns out to be missing, that is a contract-fix task.

**Deferred tasks.** T53 and T54 are v1.1 (B4). They keep their ids and their file ownership so that nothing in v1 accidentally claims those files. Do not start them until v1 has shipped.

## Status

| id | status | merged commit | notes |
| --- | --- | --- | --- |
| T0 | done | 6ea2059 | Contracts, scaffold and synthetic fixtures. |
| T1 | done | 6ea2059 | Docker image, compose, xw wrapper and preflight script. |
| T2 | done | 80111c7 | wave 1 |
| T3 | done | 2646a61 | wave 1 |
| T4 | done | 2323128 | wave 1 |
| T5 | done | 95b5448 | wave 1 |
| T6 | done | fd378f6 | wave 1 |
| T7 | done | 0338a7a | wave 1 |
| T8 | done | 8cfd73f | wave 1 |
| T9 | done | 92ae1fb | wave 1; three review rounds plus one final scoped review |
| T10 | done | 868cce0 | wave 1 |
| T11 | done | ba93b35 | wave 1 |
| T12 | done | ca7b9b7 | wave 1 |
| T13 | done | 65694e6 | wave 1 |
| T14 | done | fb7406d | wave 1 |
| T15 | done | e5f14c2 | wave 1 |
| T16 | done | 72dcca8 | wave 1 |
| T17 | done | 8ed1002 | wave 1 |
| T18 | done | 7e37722 | wave 1 |
| T19 | done | f463acc | wave 1 |
| T20 | done | 83afef3 | wave 1 |
| T21 | done | 1f996d7 | wave 1 |
| T22 | done | 3c9de50 | wave 1 |
| T23 | done | d1b40ed | wave 1; three review rounds plus one final scoped review |
| T24 | done | 6384d73 | wave 2 |
| T25 | done | 4e4f0b9 | wave 2 |
| T26 | done | 2dd1914 | wave 2 |
| T30 | done | f04927d | wave 2 |
| T31 | done | 8d2542e | wave 2 |
| T32 | done | ba30902 | wave 2 |
| T36 | done | a2f330a | wave 2 |
| T37 | done | ecfe1bb | wave 2 |
| T27 | done | f46b95e | wave 2 |
| T28 | done | f3a6ffc | wave 2 |
| T33 | done | fb4214f | wave 2 |
| T34 | done | 65209f9 | wave 2 |
| T35 | done | 0412407 | wave 2 |
| T39 | done | 56e510f | wave 2 |
| T40 | done | a1fd3d2 | wave 2 |
| T41 | done | 55a3790 | wave 2 |
| T29 | done | 712d7e3 | wave 2 |
| T38 | done | 28de8ab | wave 2 |
| T42 | done | 53c7c79 | wave 3 |
| T43 | done | e53b2d0 | wave 3 |
| T46 | done | 556044d | wave 3 |
| T48 | done | b1f3999 | wave 3 |
| T49 | done | ee71d7a | wave 3 |
| T55 | done | 27de06b | wave 3 |
| T44 | done | 17552e2 | wave 3 |
| T45 | done | 37ad4d0 | wave 3 |
| T47 | done | b6ace7c | wave 3 |
| T52 | done | 90bc017 | wave 4 |
| T50 | done | a9d77c9 | wave 4; determinism fix (pinned word list) after first merge rollback |
| T51 | done | db0074e | wave 4; coverage thresholds now enforced in CI |
| T53 | deferred | - | v1.1: votes/blend calibration and fitting |
| T54 | deferred | - | v1.1: escalation and batch-size bench runs |
| T56 | done | e8eb7e9 | wave 5 |
| T57 | done | d6fb7a1 | wave 5 |
| T58 | done | b89dbfa | wave 5 |
| T59 | done | c6a6add | wave 6 |
| T60 | done | aec89cf | wave 6 |

## Blocked

None.

## Follow-ups (post-v1)

- [done: T58] Highest value: `src/llm/tierRouter.ts` sends the reasoning-off sampling parameter only for purpose `seed` (per B41); every non-seed tier-1 call (re-ask, repair, escalation checks) spends its whole token budget on chain-of-thought and never emits parseable JSON, so those calls are never cached and all six committed fixtures replay with `--offline-lenient` rather than strict `--offline`. Fix: send reasoning-off for every tier-1 purpose, then refresh the committed cache and regenerate snapshots; expect a real accuracy gain since re-asks currently never succeed on tier 1.
- [resolved: no real puzzles are committed as of 2026-09-04 (T56)] `puzzles/fixtures/FIXTURES.md`'s public-domain basis for the four pre-1965 NYT fixtures ("claimed: not renewed") is the builder's best-effort research, not a legal conclusion, and is marked needs-human-review; Ben's sign-off is required before treating those files as clear for redistribution.
- [resolved: no real puzzles are committed as of 2026-09-04 (T56)] A couple of committed snapshot fixtures carry verbatim non-ASCII characters (an en dash and an accented letter) copied from the original 1950s NYT clue text; left unedited since it is third-party historical source text, not authored prose.
- [done: T57] README.md should document `scripts/smoke-container.sh` as a manual pre-release check (`docker compose up -d` then `sh scripts/smoke-container.sh`); not done in wave 4 since README.md was outside the relevant tasks' Owns lists.
- [done: T57] Spec touch-ups: `docs/benches/README.md` has no contract test asserting the 30/20/10 stratum split and id/stratum-only keys of `sets/mixed-30.json`, so the shape can drift silently; and it does not state that both benches are re-run in M6 with the repair pass enabled (spec line 941). Both are small additions for whoever picks up T54.
- [resolved: no real puzzles are committed as of 2026-09-04 (T56)] Baseline letter accuracy on the four real 1950s/60s NYT fixtures is 0.33 to 0.60 with the cheap model; the bench set needs modern puzzles (and/or the tier-1 fix above) before its numbers are meaningful for tuning.
- [open: optional] Fixtures pin a 2,000-entry test word list; if repair fill quality matters for the benches, consider committing a pinned snapshot of the full collaborative word list under `test/fixtures/`.
