# Wave 1 build notes (for waves 2 to 4)

Deviations, notes for later waves and reviewer observations collected from the wave 1 builder and reviewer agents; builders in later waves read the sections for the tasks they depend on.

## T2 GitHub Actions CI workflow

**Reviewer notes:**
- NON-BLOCKING, for later waves: the `node` job will be red on the current M0 stub codebase. Running `vitest run --coverage` in the preflight image reports: lines 60.18% vs global 80%, branches 40% vs 75%, src/grid/** lines 41.17% vs 95%, exit non-zero. This is by design (the frozen vitest.config.ts comment says CI enforces thresholds and the T2 deliverable mandates `npm test -- --coverage`), and...
- Minor observation only: `on: push:` with no branch filter means every push to every branch (including task/* worktree branches) triggers both jobs, and a PR from a branch in the same repo triggers the workflow twice (push + pull_request). Matches the deliverable wording ("on push and pull_request") so not a finding; a `branches:` filter could be considered later if runner minutes matter.

## T3 Grid model

**Notes for later waves:**
- Grid.unassign is now O(slot.length * average cell-degree) per call with no auxiliary trail array, and the `assigned` Map is the single source of truth for what letters are on the board - any future change to Grid should keep writing/reading letters only through assign()/unassign() so this invariant (a letter present in `letters` is exactly the letters implied by `assigned`) keeps holding.
- T37 (Search core) and T38 (search hooks) can now rely on Grid.unassign being safe to call in any order, e.g. for backtracking to the lowest-margin crossing assignment rather than only the most recent one, as T37 acceptance 3 requires.

**Reviewer notes:**
- Non-blocking (semantics for T37/T38): assign() on a slot that is already assigned with a different word throws the conflict error ('r0c0 is already ...') because the slot's own letters count as fixed; a search that wants to try a different value for a slot must unassign() first. Same-word re-assign is a silent no-op. Worth stating in the spec or a doc comment so search code does not rely on ove...
- Non-blocking (semantics): assign() upper-cases the answer before writing and stores the upper-cased form in `assigned`, so assignmentOf() and snapshot().assigned never return the caller's original casing. Fine for normalised candidates (T6), but callers passing raw text should not expect round-tripping.
- Non-blocking (snapshot): snapshot().assigned is built with Object.fromEntries over a Map, so key order follows insertion order. Deep-equal comparisons are unaffected, but a JSON.stringify of two logically equal snapshots reached by different assign orders (e.g. A,B,unassign A,assign A) will differ byte-wise. If a later task (T17 run recorder, T51) compares serialised snapshots, sort the keys th...
- Non-blocking (coverage): the 7x7 fixture is exercised only for slot count and the unchecked cell; assign/unassign/crossings are tested on the 5x5 only. Acceptable for T3's acceptance list, but T36/T37 should not assume 7x7 behaviour has been exercised here.

## T4 DomainStore with depth-indexed trail

**Deviations:**
- Followed the frozen `src/grid/types.ts` contract, not the plan prose, where they differ: `push()` takes no argument (depth is `frames.length`), `reduce(slotId, keep: (c) => boolean, reason?)` takes a predicate and returns the number removed rather than taking a kept-candidate array, and the interface also carries `setBase`, `pop`, `depth`, `isSuspect` and `markSuspect`. Reason: types.ts is froz...

**Notes for later waves:**
- Semantics the contract left open, decided here and asserted by tests, that T36 (AC-3), T37 (search) and T38 (hooks) depend on: a `reduce` taken with no frame open (depth 0, i.e. the AC-3 prepass) is PERMANENT, since there is no frame to record it - T36 must `push()` before a speculative arc reduction if it wants the AC-3 wipeout restore of step 3, then `pop()`.
- `merge` clears any trailed exclusion of an answer it re-supplies, so a re-ask result is visible at the current node rather than only after a backtrack. T38's merge-after-empty-domain flow relies on this; if T38 wants a merged answer to stay hidden until backtrack it must not go through `merge`.
- `setBase` clears the slot's exclusions (a replacement base domain has no reduction history). Trail entries naming those answers remain on the trail as harmless no-ops. Callers should treat `setBase` as a seed-time operation, not something to do mid-search.
- Suspect marks (`markSuspect`) are deliberately NOT trailed; an AC-3 wipeout mark outlives every backtrack. `isSuspect` on an unknown slot returns false.
- Unknown/unseeded slots are lenient rather than throwing: `get` returns a shared frozen empty array, `sizeOf` returns 0, `reduce` returns 0, and `merge`/`markSuspect` create the slot.
- `get` returns the cached frozen array (identity is stable between mutations), so a caller that needs a mutable list must copy it. Domains are never sorted by the store - base order is seed order with merged answers appended, so value ordering by score is the search's job (T37/T20).
- `pop()` at depth 0 and `undoTo(d)` for d >= depth() are no-ops; `undoTo` clamps negatives to 0 and floors non-integers.

**Reviewer notes:**
- Ownership: `git diff --name-only main..HEAD` lists only src/grid/domainStore.ts and test/unit/grid/domainStore.test.ts, both in the T4 Owns list. No frozen file touched; the stubs contract count dropped to 51 automatically because the test scans for notImplemented() rather than being edited.
- Deviation from plan prose is legitimate: types.ts is frozen and declares push(): void, reduce(slotId, keep, reason?) returning a count, and setBase/pop/depth/isSuspect/markSuspect; the implementation matches the frozen contract exactly.
- For T36 (AC-3): a reduce() taken at depth 0 has no frame and is permanent, so the prepass cannot use pop()/undoTo() to 'restore the domain' on a wipeout. T36 should compute the survivor set first and only call reduce() when it is non-empty (marking suspect otherwise), or push() a frame around each slot's arcs and accept that undoTo(0) later discards the prepass. Worth deciding explicitly in T36...
- For T37/T38: merge() also clears any trailed exclusion of an answer it re-supplies (domainStore.ts line 129), so a re-ask result is live at the current node, not only after backtrack. This relies on the validation chain having already rejected pattern-mismatching answers; if T38 ever merges unvalidated candidates the search's per-node pattern re-filter is the only guard.

## T5 Pattern string and regex builder

**Notes for later waves:**
- src/grid/pattern.ts's validation throws a plain Error (not CliError) since T5's decisions text just says 'throws' and this is a low-level pure module with no CLI/exit-code context; T3 (Grid) and T4 (DomainStore) can rely on that when calling regexFromPattern/patternMatches/etc.
- The regex cache in pattern.ts is a single module-level Map shared across all callers within a process (intentional, per the memoisation acceptance test) - later tasks should not expect per-instance isolation from it.

**Reviewer notes:**
- Non-blocking: for a run of `?` the builder emits repeated `[A-Z]` (e.g. `^A[A-Z][A-Z][A-Z]N$`) rather than the `[A-Z]{3}` form shown in crossword-algorithms.md 'Problem model'. Semantically identical and acceptance 2 only pins the A?I?N form, but any later test asserting `.source` for a multi-? run should expect the expanded form.
- Non-blocking: invalid patterns throw a plain Error rather than a CliError. The T5 block does not require CliError (T3's assign does), so this is fine for a programming-error path, but the T3 Grid.regexFor delegate and later callers should not rely on a `code` property here.
- Non-blocking: the regex cache is process-wide and unbounded. Pattern cardinality is bounded by grid size in practice, so this is fine for v1; a bench (T52) running many puzzles in one process would grow it monotonically.

## T6 Normalisation and validation chain

**Deviations:**
- src/grid/pattern.ts (T5) is still a NotImplemented stub within this wave (both T5 and T6 depend only on T0, run in parallel, and my worktree branches off pre-wave-1 main), so normalise.ts builds its own small `? -> [A-Z]`, anchored pattern regex locally instead of importing regexFromPattern/patternMatches from grid/pattern.ts as the task's Reads list suggests. The construction is identical to w...
- The plan.md acceptance text names the waiver flag input field allowEchoWhenEmpty, but T0's pre-scaffolded ValidateInput stub used allowClueEcho for the same purpose; since T6 owns normalise.ts (not frozen), I renamed the field to allowEchoWhenEmpty to match the task's own acceptance criteria and plan.md's prose exactly.
- Added a non-optional echoWaived: boolean field on the return value (ValidateCandidatesResult, extending the base ValidationResult shape) to satisfy the task's explicit requirement that the clue-echo waiver be reported in the return value so the caller can emit the event; the plan's deliverable signature only shows the base accepted/rejects shape, but this is an additive superset, not a narrower...

**Notes for later waves:**
- T44 (solve orchestration) or T34 (candidate service) callers of validateCandidates should note the input field is named allowEchoWhenEmpty (not allowClueEcho as T0's original stub had it), and that the result carries an extra echoWaived: boolean alongside accepted/rejects.
- Consider switching normalise.ts's local pattern-regex builder to import grid/pattern.ts's regexFromPattern/patternMatches once T5 is merged, to avoid the small duplication; behavior is intentionally identical so this is a pure refactor, not a correctness fix.
- Candidate.score is set from the raw candidate's self-reported confidence at validation time (score/calibrate.ts, T13, runs after validation per the spec's step ordering and is expected to overwrite/recompute .score on accepted candidates); validateCandidates does not attempt real calibration, per its explicit out-of-scope note.

**Reviewer notes:**
- Deviation accepted: the pattern regex is built locally (normalise.ts:51-63) instead of importing regexFromPattern from src/grid/pattern.ts because T5 is still a notImplemented stub in this wave. Construction matches the pattern.ts doc comment ('A?I?N' -> /^A[A-Z]I[A-Z]N$/, memoised). Follow-up for a later wave: switch to grid/pattern.ts once T5 merges and delete the local copy so there is one r...
- Deviation accepted: ValidateInput.allowClueEcho (T0 stub) renamed to allowEchoWhenEmpty to match plan.md acceptance 5; repo-wide grep shows no other reference to either name, so nothing downstream breaks. T34 (CandidateService) must use allowEchoWhenEmpty.
- Deviation accepted: return type ValidateCandidatesResult extends ValidationResult with a required `echoWaived: boolean`. Additive superset; T34 should read it to emit the waiver event.
- Design note for T34: the echo waiver decision (normalise.ts:159-176) is made before the rejected-before step, per the spec's chain order. Consequences: (a) a waived echo candidate can still be dropped as rejected-before, leaving the slot empty with echoWaived === true; (b) if the only non-echo survivors are all in the rejection set, the echoes are rejected as clue-echo even though waiving would...

## T7 Clue numbering, slot extraction, enumeration

**Deviations:**
- Acceptance item 3 describes a 3x3 all-white grid at minRun 2 as numbering '1,2,3 on the top row and 4,6 down the left column'. I implemented and tested the literal B19 rule (verified byte-for-byte against both synthetic fixtures, which the orchestrator named as the authoritative check), and that produces [[1,2,3],[4,null,null],[5,null,null]] -- i.e. 4 and 5, not 4 and 6, since row 2 col 0 is th...

**Notes for later waves:**
- Slot construction pattern for later loader tasks (T24/T25/T26): call computeNumbering(blocks, {minRun}) then buildSlots(numbering, sourceClues, {minRun}) where sourceClues is an array of {number, direction, text} derived from whatever the source format supplies as clue lines; buildSlots already derives Slot.enumeration from clue text via extractEnumeration, so adapters generally do not need to ...
- assertNumberingMatches throws via cli/exit.ts's notFoundError (ExitCode.NOT_FOUND = 3), matching the pattern already used in src/puzzle/loader.ts -- loader adapters that call assertNumberingMatches will get a CliError with .code === ExitCode.NOT_FOUND automatically, no extra wrapping needed.
- extractEnumeration accepts an optional single trailing word after the parenthesised group (e.g. '(3,4) hyphenated') per the task's decision text, though no acceptance test exercised that case directly -- I added my own test for it in test/unit/puzzle/enumeration.test.ts covering that behavior explicitly.

**Reviewer notes:**
- Acceptance 3 in docs/plan.md (T7) says the open 3x3 numbers '4,6 down the left column'; the B19 rule as written in docs/spec.md line 478 and docs/decisions/2026-09-03-spec-review.md B19 produces 1,2,3 / 4 / 5 (r1c0 and r2c0 each begin an across run; their down run already started at row 0). The builder's explicit matrix [[1,2,3],[4,null,null],[5,null,null]] is correct and is the same logic that...
- src/puzzle/numbering.ts assertNumberingMatches iterates only over the computed matrix's dimensions, so a supplied matrix with extra rows or extra trailing columns is never flagged. Both matrices derive from the same Cell[][] in every adapter (T24/T25/T26), so this is not reachable today, but adapter authors should not rely on it to catch a shape mismatch.
- src/puzzle/enumeration.ts extractEnumeration returns the trailing word as part of the result (e.g. '(3,4) hyphenated'), so Slot.enumeration may carry more than the bare parenthesised group that the types.ts comment shows as the example ('(3,4)'). Prompt consumers (T-prompt tasks) should be aware the field is not guaranteed to be just the group.
- src/puzzle/enumeration.ts normaliseEnumeration([]) returns '()' rather than signalling an empty structured field; the Guardian adapter (T26) should guard against passing an empty length list.
- src/puzzle/enumeration.ts: a clue ending in a group followed by punctuation, e.g. 'Dinner dish (5).', yields undefined because the regex is end-anchored after optional whitespace only. Real-format fixtures in T24/T25 will show whether that shape occurs in practice.

## T8 Pricing from models.json

**Notes for later waves:**
- priceOf/capabilitiesOf/limitsOf accept an optional second `path` argument and UsdInput accepts an optional `path` field, in addition to the single-argument forms the task deliverable describes; production callers (T9, T32, T33) should keep calling them with just the model id, which resolves against the real repo-root models.json as documented. The extra param exists solely so tests can inject t...
- test/fixtures/models.min.json's third entry, id "test/rounding-fixture", is a synthetic fixture-only model (supported_features: ["seed"], prompt price 1e-10) used to exercise supportsSeed and >9-decimal-place rounding in usdFor; it is not a real catalogue model and later tasks should not expect it to appear in models.json.
- limitsOf/capabilitiesOf/priceOf/usdFor throw a plain Error (not a custom error class) with the model id substring in the message on an unknown model id; no ModelNotFoundError or similar was added since types.ts (frozen) does not declare one and the task text only specifies the message must contain the model id.

**Reviewer notes:**
- Signature extension: priceOf/capabilitiesOf/limitsOf gained an optional trailing `path` parameter and UsdInput gained optional `path`, beyond the T0 stub signatures. Backward compatible for T9/T32/T17 callers, but downstream builders should know the parameter is documented as test-only.
- Robustness (non-blocking, wave-later): parseCatalogue does no per-entry validation. Two real entries (Qwen/Qwen2.5-VL-72B-Instruct, Qwen/Qwen3-Embedding-8B) have no supported_features; `new Set(undefined)` handles that silently. A future catalogue entry lacking supported_sampling_parameters, pricing or per_request_limits would throw a bare TypeError from the spread/property access at load time ...

## T10 Inference log writer

**Deviations:**
- The read-only-directory test (acceptance 5) uses a regular file blocking a directory path component (ENOTDIR) instead of chmod-ing a directory read-only: the preflight container runs Dockerfile's node:22-slim image as root (no USER directive), and root ignores permission bits, so a chmod-based test would pass write() where it should fail. The ENOTDIR trick fails mkdir deterministically regardle...

**Notes for later waves:**
- T33 (nebius client) is the module that will actually build InferenceLogRecord values from real LLM calls and hand them to this sink's write(); nothing in this task validates record contents beyond what TypeScript enforces.
- openInferenceLog uses synchronous fs (openSync/writeSync/closeSync) rather than a Node WriteStream, chosen so tests can read the file back immediately after write() without polling or awaiting a 'finish' event; this still satisfies 'a single write stream per process per day' as one persistent fd reused across writes for that date.
- The InferenceLogOptions interface (dir?, enabled?, now?) lives in inferenceLog.ts itself, not in the frozen src/llm/types.ts, so it was safe to add the now field beyond what the stub originally declared.

**Reviewer notes:**
- Ownership clean: `git diff --name-only main..HEAD` is exactly src/llm/inferenceLog.ts and test/unit/llm/inferenceLog.test.ts, both in the T10 Owns list. No frozen file touched.
- Decisions spot-check: UTC date from injectable now() (utcDateString = toISOString().slice(0,10), opts.now default new Date) - honoured. JSON.stringify with no replacer and a circular-record warning naming the record id (lines 86-90) - honoured and covered by the extra 'circular reference' test. Request-header redaction is structural (InferenceLogRecord.request has no headers field in the frozen...
- Mechanism deviation, non-blocking: the plan/spec say 'a single write stream per process'; the builder uses one append-mode fd with synchronous openSync/writeSync instead of a fs.WriteStream. Observable behaviour is the same (single handle per day, append-only, close() releases it) and it makes tests deterministic without polling. Cost is that each write blocks the event loop for a small local a...
- Warning semantics for later waves: `warned` is a single lifetime flag shared by both failure classes (serialisation and I/O). After one I/O warning, a later circular-record warning is silently suppressed (and vice versa), and a disk that fails, recovers, then fails again warns only once per process. This matches the spec's literal 'logs a warning once' and acceptance 5, so it is not a defect, b...
- close() then write() reopens the descriptor (documented in the module comment). Fine for the CLI lifecycle, but a caller in T33/T46 should treat close() as end-of-process rather than a pause.

## T11 Candidate response parser

**Deviations:**
- ParseOutcome gained a `warnings: ParseWarning[]` field beyond the `{ byId, failures, rawUsed }` the task names, because the baked-in decision "clue_understood missing defaults to 0 and records a warning rather than failing" needs somewhere to record it that is not a failure; the field is additive, lives in a file this task owns, and nothing else in src or test referenced ParseOutcome yet.

**Notes for later waves:**
- T34 (candidate service): `parseCandidateResponse` never throws and never retries. A whole-response failure arrives as exactly one `{ id: null, error }` (no per-id `missing` entries alongside it), so the retry-once-at-temperature-0 rule can key on `failures.some(f => f.id === null)`; per-clue failures carry the slot id and a batch's absent ids arrive as `{ id, error: 'missing' }`, which is the s...
- T34/T41: `outcome.warnings` is `Array<{ id: string | null; warning: string }>` and currently only ever carries 'clue_understood missing; defaulted to 0'. It is deliberately not a failure; if the inference log or the batch bench wants to count defaulted routing signals, this is the source.
- `rawUsed` is the exact substring of the STRIPPED text that was JSON.parsed (fences, `<think>` blocks and `reasoning_content` already removed), and is `''` when nothing parseable was found. If the inference log wants the verbatim model output it must keep the original string itself.
- The parser deliberately does not validate the batched envelope's `additionalProperties`, only each element, so an envelope carrying `results` plus provider junk still yields per-clue results.
- Answers pass through unnormalised, including spaces, hyphens, apostrophes and accented characters (fixture test/fixtures/responses/answers-with-spaces-and-accents.txt uses \uXXXX escapes so the file stays ASCII). T6 still owns normalisation.
- src/llm/parser.ts no longer calls `notImplemented`, so the data-driven stubs contract test stopped scanning it, as intended.

**Reviewer notes:**
- Acceptance walk (all PASS, evidence in /Users/ben/Projects/crossword-agent/.claude/worktrees/wf_ed711c10-20f-33/test/contract/parser.test.ts): 1 good-single test '1. good-single.txt' asserts toEqual(SINGLE_RESPONSE) and candidates length 2; 2 fenced test '2.' asserts identical response and rawUsed has no backtick; 3 prose-prefix test '3.' asserts identical response and rawUsed excludes BEASTS; ...
- Ownership clean: git diff --name-only main..HEAD is exactly src/llm/parser.ts, test/contract/parser.test.ts (new file, explicitly in Owns) and 11 new files under test/fixtures/responses/. No frozen file touched; package.json/package-lock.json unchanged (ajv 8.20.0 was already a dependency).
- Deviation accepted: ParseOutcome gained `warnings: ParseWarning[]` (additive, owned file, required by the clue_understood decision). T34 (CandidateService) should read outcome.warnings and forward them to the inference log / events rather than dropping them.
- For T34: a whole-response failure (truncated, non-JSON, no object, or a batch answered in single-clue form) is reported as ONE failure with id null and no per-id 'missing' entries. T34 must treat a null-id failure as 'every expectedId failed' when deciding what to re-ask singly.
- For T34: on a duplicate id the parser keeps the first element in byId AND records {id, error:'duplicate id'} in failures, so the same id can appear in both. A consumer that re-asks every failed id would re-ask a clue it already has a result for; consider having T34 skip failures whose id is present in byId (or T11 could later downgrade duplicates to a warning now that the field exists).
- Known limitation of the baked-in last-balanced-object rule, worth watching in T49's parse-failure measurement: trailing prose containing its own braces (e.g. 'the set {ANIMAL, MAMMAL}') becomes the 'last balanced object' and fails JSON.parse, and an unmatched '{' in prose BEFORE the answer makes the real object nest inside it and report 'unbalanced brace'. No fallback to an earlier balanced obj...

## T12 Candidate cache (disk + LRU)

**Deviations:**
- Changed CandidateCache's get/set from the T0 stub's synchronous signatures to async (Promise-returning): the task's own decisions require atomic tmp+rename disk writes through util/fs (async) and a disk fallback on an LRU miss, which a synchronous method cannot express. cache.ts is in T12's Owns list so this is within scope, but it changes a shape T0 originally sketched.
- CacheEntry's stored shape follows the T12 task block's flat field list (key, model, promptVersion, promptKind, clue, length, pattern, style, sampleIndex, batchSize, response, usage, latencyMs, createdAt) rather than docs/spec.md's Candidate service section, which describes { key, keyFields, response, usage, latencyMs, model, createdAt } with keyFields holding the full hashed cache-key object (s...

**Notes for later waves:**
- CandidateCacheOptions.cacheDir is an already-resolved directory (or omitted, falling back to resolveCacheDir({env, root}) for the env-or-default half of B24); the --cache-dir CLI flag is expected to be resolved by the caller (e.g. via util/fs.resolveCacheDir({flag, env})) before constructing the cache, matching T10 openInferenceLog's dir? pattern. T34 (candidate service) and T35 (cli cache) sho...
- get/set/stats/clear are all async (Promise-returning), not synchronous as the original T0 stub sketched. T34's CandidateServiceDeps.cache: CandidateCache should already await these; double-check any code written against the old sync shape.
- openCandidateCache() returns cacheDir as a readonly field on the CandidateCache object (useful for `xw cache stats` in T35 to report where the cache lives).
- clear(filter) with no filter skips reading file content entirely (just unlinks), since an empty filter can't fail to match; only a model/promptVersion filter triggers a read per file.
- CandidateCacheOptions exposes readEntryText and measureBytes injection points purely for testability (Node's fs/promises ESM exports are not vi.spyOn-able); real callers can ignore both and get the real disk-backed defaults.

**Reviewer notes:**
- Acceptance walk (all in /Users/ben/Projects/crossword-agent/.claude/worktrees/wf_ed711c10-20f-34/test/unit/candidates/cache.test.ts): 1 PASS ('set/get round trip (acceptance 1)': deep-equal via toEqual, injected readEntryText vi.fn spy asserted not called); 2 PASS ('cold process (acceptance 2)': second instance over same dir, spy called once then zero after repopulation); 3 PASS ('negative resu...
- For T34/T35 (interface drift from the T0 stub, disclosed by the builder): CandidateCache.get/set/stats/clear are now Promise-returning, CacheEntry dropped `keyFields` and `response` is no longer nullable (negative = candidates: []), CandidateCacheOptions.cacheDir is now optional with env/root forwarded to util/fs.resolveCacheDir. src/candidates/service.ts only imports the type so it still compi...
- For T35: an explicit `cacheDir` option is used verbatim (no relative-path resolution against the repo root), unlike util/fs.resolveCacheDir which resolves relative overrides. Callers should pass `resolveCacheDir({ flag: globals.cacheDir, env })` rather than the raw --cache-dir string, or T35 could ask for a `flag` passthrough. Also, memoisedStats is not invalidated by set() or clear() (per the ...

## T13 Rank calibration

**Notes for later waves:**
- T53 (votes/blend calibration + fitting) extends src/score/calibrate.ts: the votes/blend branch currently throws NotImplementedError directly (not via the notImplemented() helper) so the stubs contract test does not treat this file as a stub anymore; T53 should replace that throw with the real votes/blend implementations.
- loadCalibrationWeights() does not enforce that the blend weights sum to 1 (only that there are exactly 3 finite numbers) since T53's fitted weights from logistic regression need not sum to 1 -- worth confirming that assumption holds when T53 lands.
- config/calibration.json shape is { blend: [w1, w2, w3] }, matching CalibrationWeights directly; T53's fitting script should write back in that same shape.

**Reviewer notes:**
- Non-blocking: NotImplementedError.where is documented in src/util/errors.ts as a repo-relative module path, but calibrate.ts passes a full sentence ('src/score/calibrate.ts: 'votes' calibration is M6 (T53); ...'). Anything in later waves that matches on `where` as a path (e.g. the stubs contract test or an error renderer) should be aware. Harmless for the acceptance test, which only checks the ...
- Non-blocking: loadCalibrationWeights deliberately does not enforce sum-to-1 or a [0,1] range on weights; T53 should decide whether fitted weights carry that invariant and, if so, add the check there.
- Non-blocking: src/score/calibrate.ts:63-72 contains a redundant `as unknown[]` cast and a dead undefined-guard (length===3 plus every(isFiniteNumber) already establishes w1..w3); it exists to satisfy noUncheckedIndexedAccess and is fine to leave, but T53 could tidy it when extending the file.

## T14 ConsoleRenderer and events fixture

**Notes for later waves:**
- T39 (WatchRenderer) can now `import { formatDiffLines, formatGridLines, type Blocks, type FinalLetters } from '../render/console.js'` for its diff overlay as docs/plan.md's T39 block requires, rather than duplicating the diff/grid formatting logic.
- formatDiffLines/formatGridLines accept Blocks | null and FinalLetters | null (not just Blocks/FinalLetters) so callers get the same 'grid unavailable' fallback ConsoleRenderer uses before grid:init/grid:final have been seen.

**Reviewer notes:**
- Fixture integrity: grid:init blocks/numbers/slots match test/fixtures/puzzles/synthetic-5x5.json cell-for-cell; tMs is monotonic non-decreasing across all 44 events (matters for T15 acceptance 6 and T51 replay); score:final numbers (21/22 letters, 9/11 words) are consistent with the single wrong letter at r1c1 affecting slots 5A and 2D.
- For T45 (solve handler): no event carries the puzzle solution, so the level-0 diff only appears when the caller passes `opts.solution` to ConsoleRenderer; otherwise the block prints 'Diff: no solution supplied'. T45 should pass the normalised puzzle's solution matrix.
- Naming: the plan text says `colour: boolean` but the T0 stub (frozen on main) named the option `color`, and the builder correctly kept `color`. Downstream tasks (T39, T45) should use `color`.
- For T39: console.ts now exports pure `formatGridLines(blocks, letters)` and `formatDiffLines(blocks, letters, solution, paint)` plus `Blocks`/`FinalLetters` type aliases, intended for read-only import by the WatchRenderer diff overlay.

## T15 EventBus, JsonlEventSink, replay

**Notes for later waves:**
- T14 (ConsoleRenderer) can rely on EventBus/JsonlEventSink/replay now being real; no coordination needed since T15 only touched its own Owns list.
- JsonlEventSink uses a persistent open fd (openSync/writeSync/fsyncSync/closeSync) rather than an async write queue, so it is safe to call the handler from a hot synchronous emit loop without backpressure concerns; close() is idempotent.
- replay() logs malformed lines via src/util/log.ts's log.warn (stderr, respects CROSSWORD_LOG_LEVEL); a consumer wanting to count/collect malformed-line reports in production code (not just tests) will need to spy on or extend that logger rather than getting them back from replay() itself, since replay's only side channel to the caller is the handler callback for well-formed lines.

**Reviewer notes:**
- Non-blocking test tightening for a later wave: test/unit/render/jsonl.test.ts 'round-trips a bus-emitted stream' should also capture the bus-side events (bus.on((e) => emitted.push(e))) and assert expect(received).toEqual(emitted) so the deep-equal wording of acceptance 4 is locked in by the repo suite rather than only by type/seq/runId projections.
- Design observation for T39/T45 (replay consumers): src/render/replay.ts calls the handler directly and does not catch a throwing handler, unlike the bus. If a renderer throws mid-replay the whole replay rejects. Callers that want bus semantics during playback should route replay through a createEventBus and pass bus.emit-like wrapping, or T39 can decide replay should catch and warn per line.
- Scalability observation: replay reads the whole .events.jsonl into memory with readFile and split('\n'). At -vvv the stream includes llm:request full prompt text and llm:response raw bodies, so large traces could be memory heavy. A readline/stream-based loop would be a drop-in later change with the same handler contract.
- Robustness observation: replay hands any successfully parsed JSON value (including a number, null or an object without `type`) to the handler as SolverEvent without a shape check. Fine for files the sink wrote; a later wave may want a minimal `typeof event === 'object' && 'type' in event` guard with the same line-number warning path.
- Sink behaviour note: after close(), sink.handler silently drops further events (no warning). Acceptable for T15; T45 should make sure the sink is closed only after run:end has been emitted.

## T16 Scorer

**Deviations:**
- Spec conflict: spec.md's 'Solver pipeline' step 8 says the scorer 'loads the solution through loadPuzzleWithSolution', but the T16 task block's Deliverable and Decisions baked in are explicit that score() takes the solution as an argument and 'is the only module that ever sees the solution, and it takes it as an argument rather than loading it.' Per the plan's rule #6 (task text wins on conflic...

**Notes for later waves:**
- score()/diff() determine block-vs-non-block purely from solution[row][col] === "" rather than from Slot or Cell.block data, since score()'s signature (per the task) does not receive Cell data. Callers (e.g. T44's solve orchestration, T17's runRecorder) should pass the same PuzzleWithSolution.solution array used elsewhere so block-cell semantics stay consistent across the pipeline.
- CellVerdict ('right'|'wrong'|'empty'|'block') was already declared in the T0-authored stub and is unchanged; renderers (T14 console, T39 watch) can import it directly from src/eval/scorer.ts.
- diff()'s output matrix is sized to solution's dimensions (height rows x width-per-row), not snapshot.letters' dimensions; they are expected to always match in practice since both come from the same puzzle.

**Reviewer notes:**
- Hygiene clean: no `any` in changed files; no non-ASCII bytes in the diff; single commit 4fb3984 'T16: implement scorer' carries no attribution/Co-Authored-By/Claude-Session lines; notImplemented() import and calls removed from scorer.ts.
- Builder's claimed deviation is legitimate: spec.md 'Solver pipeline' step 8 (line 631) says the scorer loads the solution via loadPuzzleWithSolution, but the T16 task block's Deliverable, Decisions and Out-of-scope all say it takes the solution as an argument. Task text wins per plan rule 6. The docs owner may want to reword spec step 8 to 'the orchestrator loads the solution and hands it to ev...
- Design note for T44/T21 (non-blocking): block-ness is derived solely from solution[row][col] === '' (B11), not from Puzzle.cells[].block. This is correct given the deliverable's signature, but it makes the scorer's denominator depend on every loader emitting '' at exactly the block cells. T21's loader tests should assert that alignment for each format, since a loader that emitted a placeholder ...
- Comparison is strict, case-sensitive string equality. This relies on both the grid model (validate/normalise uppercases) and loaders (B11) producing uppercase A-Z. Consistent with the spec; worth a loader post-condition assertion in T21 that solution letters are uppercase.

## T17 RunRecord builder

**Deviations:**
- test/fixtures/events/full-run.events.jsonl does not exist yet (T14 owns it), so the tests still drive the recorder from the in-file `fullRunEvents()` builder that stands in for it - unchanged from the original commit, restated here so it is not lost.
- Acceptance criterion 1 for T17 is therefore satisfied against that synthetic stream rather than the named fixture; when T14 lands, the recorder tests should be re-pointed at test/fixtures/events/full-run.events.jsonl.

**Notes for later waves:**
- T45 (`xw solve`) and T47 (`xw bench`) must now handle a rejecting `written()`. `IndexUpsertError` is exported from src/eval/runRecorder.ts and carries `recordPath`, `puzzleId` and `cause`: the intended handling is to report it (the spec's "clear error" for the 5 s puzzles/.index.lock timeout) without treating the run as lost, because the run record is already durable at `recordPath`. Any other ...
- If a caller never awaits `written()`, the recorder logs the failure via src/util/log.ts at error level instead - so a bench worker that fires and forgets still leaves a trace, but the preferred integration is to await `written()` per run.
- T21's `upsertIndexRow` should reject (not resolve) on lock timeout for this to work; the RunRecorder assumes a rejected promise is the failure signal.
- The RunRecorder still cannot import src/puzzle/library.ts directly (wave isolation), so `updateIndex` stays an injected `RunRecorderIndexUpdate`. Whoever wires T21 in passes `upsertIndexRow`, the `readIndex()` row for this puzzle id as `previousRow`, and the date/title/width/height/files/parsedBy fields.

**Reviewer notes:**
- Acceptance 1 and 2 are verified against the in-file `fullRunEvents()` synthetic stream, not `test/fixtures/events/full-run.events.jsonl` (owned by wave-1 sibling T14; not present on this branch). When T14 merges, re-point the recorder tests at the fixture and recompute the literal expectations (currently backtracks=2, repair.accepted=1, calls.tier1.count=2) against it.
- `perSlot.parseFailures` is always 0 and `RunRecord.error` is never populated: no event in the frozen `src/events/types.ts` union carries a parse failure or an error message (RunEndEvent has only `status`). T33/T45 will need a channel for these (a new event, or a recorder method) if the fields are to be meaningful.
- Per-slot usd/latency and tier cacheHits are attributed by a FIFO of `cache:lookup` events paired with the next `llm:usage` (runRecorder.ts:319-327, 561-579), since `llm:usage` carries no slotId. A `cache:lookup` that is never followed by an `llm:usage` (e.g. an --offline-lenient miss, or a failed call in a run that continues) leaves a stale entry and shifts every later per-slot attribution by o...
- Cache-hit `llm:usage` events increment `calls.<tier>.count` as well as `cacheHits`, so `count` is total calls including hits. Consistent with the test, and T40's tier-2 share formula, but worth knowing when reading records.
- A relative `--out` is resolved against `repoRoot()`, not `process.cwd()` (runRecorder.ts:285-288). Equivalent inside the container (cwd=/app), but T45 should confirm this is the intended CLI semantics.
- If a caller invokes `written()` before `run:end` (which rejects by design), `writtenConsumed` is already true, so a later index-upsert failure is neither logged to stderr nor seen unless `written()` is called again. Minor; only matters for callers that poll early.

## T18 Escalation policy

**Deviations:**
- EscalationContext (frozen in src/policy/types.ts) has no dedicated per-slot wipeout counter, but trigger 4 is spec'd as 'the same slot has caused three or more wipeouts' -- a raw historical count that reasksUsed (capped at reasksPerSlot, typically 2) cannot represent. Implemented the closest available proxy: trigger 4 fires when reasksUsed has reached profile.reasksPerSlot (the slot has spent i...

**Notes for later waves:**
- T38 (search hooks) should either (a) accept the reasksUsed-exhaustion proxy for trigger 4 as-is, or (b) request EscalationContext grow a wipeoutCount field (owned by T0/contract authority) before wiring the real search loop to decide() -- worth flagging in that task's PR if the proxy proves too coarse against real puzzles.
- decide() intentionally ignores ctx.budget/ctx.spent (ResolvedBudget/BudgetSpend) entirely -- it only checks the three escalation-specific caps (maxTier2CallsPerPuzzle, escalationsPerSlot, reasksPerSlot) via ctx.tier2CallsUsed/ctx.escalationsUsed/ctx.reasksUsed against ctx.profile, per 'Out of scope: budget accounting (T19)'. T38 should keep general budget-cap enforcement (usd/tokens/wallMs/back...
- Trigger 5's desired action is 'escalate' unconditionally for all three policies (including eager and reask-first, not just patient) -- this reading of 'patient... escalate only on trigger 5' as patient's one exception, while the other two policies escalate at trigger 5 too (unremarkably, since they already escalate elsewhere), matches all documented acceptance criteria; worth confirming against...

**Reviewer notes:**
- Ownership: diff main..HEAD = src/policy/escalation.ts, test/unit/policy/escalation.test.ts only; both are in T18's Owns list. Hygiene: no `any`, no non-ASCII in diff, one commit (0f21710) with no attribution/Co-Authored-By/Claude-Session lines, `notImplemented(` gone from the module.
- Trigger 4 proxy (disclosed deviation, src/policy/escalation.ts hasThrashed, line 56-58): fires when reasksUsed >= reasksPerSlot and the domain is currently non-empty. Practical effect under the default reask-first profile (reasksPerSlot 2): the decide() call immediately after the second re-ask returns a NON-EMPTY domain yields trigger 4 -> `escalate`, so one tier-2 call is spent on a slot that ...
- Criterion 5 caveat: the trigger-4 row of the eager 'never returns reask' test uses reasksPerSlot: 1 rather than 0, and the accompanying table comment claims trigger 4 is unreachable with reasksPerSlot: 0. That claim is only true in production (T38 never re-asks when the cap is 0, so reasksUsed stays 0); structurally, reasksUsed: 1 with reasksPerSlot: 0 and domainSize > 0 does reach trigger 4 (1...
- Trigger 5 maps to `escalate` for every policy, including reask-first with re-asks remaining. This is consistent with the baked-in 'patient escalates only on trigger 5' wording and is a defensible last-resort choice (at termination the T38 re-ask guards have usually already blocked further re-asks), but it means 'reask-first prefers reask while reasksPerSlot remains' does not apply at terminatio...
- T38 integration: decide() does not apply the re-ask guards (patternFixedLetters, lastPatternQueried and currentPattern in ctx are unused; the plan assigns the guards to T38). On the seed pass, trigger 3 under reask-first/patient returns `reask` while the pattern has no fixed letters, which T38's guard will refuse. T38 must treat an unexecutable `reask` decision gracefully (e.g. as `none`) rathe...
- decide() reads the tier-2 cap from ctx.tier2CallsUsed vs ctx.profile.escalation.maxTier2CallsPerPuzzle and ignores ctx.budget.tier2Calls / ctx.spent.tier2Calls. Both are legitimately in ctx; T38 should keep tier2CallsUsed and spent.tier2Calls in step so the two views cannot disagree.

## T19 Budget policy

**Notes for later waves:**
- The GLOBAL_CAPS vs phase-scoped distinction (usd/tokens/tier2Calls/wallMs are run-global; backtracks/repairCalls are phase-scoped) is now load-bearing for any future caller of BudgetTracker: a phase-scoped cap's exceeded state is only ever surfaced by charging that exact cap, never incidentally by charging a different cap or by checkWallClock(). Callers driving the search phase and repair phase...
- hits() now contains at most one BudgetHit per distinct cap for the lifetime of a tracker (first crossing only). Any consumer of hits() for a budget:hit report or 'budget-hit counts by cap' should treat it as a set of first-crossing events, not a full history of every over-budget charge.

**Reviewer notes:**
- Acceptance 1 stands in for the `baseline` built-in with ProfileSchema.parse({ name: 'baseline' }) because src/profiles/builtins.ts (T23) is still a notImplemented stub. Once T23 lands, this test (test/unit/policy/budget.test.ts line 13) should switch to getBuiltin('baseline') so it actually exercises the built-in rather than the schema defaults.
- Interface shape changed from the T0 stub: spent() renamed to snapshot() (per plan acceptance 7), charge() narrowed from BudgetCap to ChargeableBudgetCap (wallMs is not chargeable), hits() now returns readonly BudgetHit[], and checkWallClock() was added. The only external consumer is a type import in src/solver/hooks.ts (T38); typecheck passes. T38/T44 builders should note charge('wallMs', ...) ...
- checkWallClock() is named for wall-clock but evaluates all run-global caps (usd, tokens, tier2Calls, wallMs) and can return any of them. This is documented in its JSDoc, but T44's search-loop caller must handle any BudgetCap in the return, not just 'wallMs'.
- backtracks and repairCalls are treated as phase-scoped: a charge to repairCalls never surfaces an already-exceeded backtracks cap (and vice versa), per the prior review finding and docs/spec.md line 635. This is a deliberate refinement of the 'first in declared order' decision; T38/T44 should not rely on charge('repairCalls') to re-report backtracks exhaustion.
- hits() records one BudgetHit per cap on first crossing only; the run recorder's budgetHits (T4/T44) therefore sees at most six entries per run. If a later wave wants per-charge hit counts they must be derived elsewhere.
- No guard against negative or NaN charge amounts in charge(); not required by the plan and callers control amounts, but a defensive assertion could be added in a later wave if desired.

## T20 Variable ordering

**Deviations:**
- The task's declared Reads list names only src/candidates/types.ts and src/grid/types.ts, but the pre-existing T0-authored stub at src/solver/ordering.ts (already scaffolded before this task ran) declares chooseSlot's real signature using Slot (src/puzzle/types.ts) and Grid (src/grid/model.ts, owned by T3, already merged to main). I treated that stub signature as the binding contract rather than...

**Notes for later waves:**
- chooseSlot's `grid` parameter is the concrete Grid class from src/grid/model.ts, not a structural interface, because Grid has private fields - tests (and T37's search core) that need a grid for chooseSlot must construct a real `new Grid(puzzle)` from a Puzzle fixture rather than a plain fake object.
- chooseSlot returns `Slot | undefined`, undefined only for an empty `unassigned` array; T37's search loop is expected to check for an empty unassigned list itself before calling in (per spec step 4a: 'if every slot is assigned, go to 7').
- The PRNG (opts.rng) is called at most once per chooseSlot invocation, and only when a full tie survives every other key - useful to know if T37's tests want to assert exact rng call counts.
- mrv ordering's tie-break cascade after the swapped primary key (size) falls through to margin, then unassigned crossings, then PRNG - the plan text only specifies the primary-key swap, so this ordering of the remaining cascade is this task's interpretation; flag if T37/T44 expect something different.

**Reviewer notes:**
- Plan wording tension for later waves (not a defect in T20): the 'Decisions baked in' bullet says a single-candidate domain 'has the largest possible margin and is therefore branched on first', but the Deliverable and acceptance 6 define its margin as bestScore, which is only in [0,1]; a two-candidate domain with scores 0.9/0.1 (margin 0.8) will outrank a singleton scored 0.4. The implementation...
- Margin ties are tested with exact float equality (a.margin !== b.margin). Two slots whose margins are 'equal' in decimal but differ by an ulp after subtraction (e.g. 0.7-0.4 vs 0.5-0.2) will not fall through to the size/crossings tie-breaks. Calibrated scores rarely tie exactly so this is unlikely to matter, but T37 may want an epsilon if margin ties are expected to be common after calibration ...
- Under margin ordering an empty domain (margin -Infinity) is branched last; under mrv (size 0) it is branched first. The doc comment on marginOf says emptiness 'surfaces immediately in search' which is only true for mrv; in practice T37's forward checking should route an emptied domain to re-ask before chooseSlot sees it, so this is a comment-accuracy nit only.
- Minor efficiency note: chooseSlot runs compareKeys twice per slot (min pass then filter pass) and unassignedCrossingsOf walks every covering slot per cell on every call. Fine for crossword-sized grids; only worth revisiting if profiling in T37 shows ordering in the hot path.

## T21 Puzzle library and locked index

**Notes for later waves:**
- readNormalised/loadPuzzleById/loadSolution resolve a puzzle id by scanning puzzlesDir's source subdirectories for <id>.json - they do not consult puzzles/index.json at all, so a normalised file can be read back even before (or without) an index row existing for it. T27 (fetch handler) and T30 (list/show) should rely on this directly rather than assuming readNormalised needs the index.
- The lock-timeout CliError uses ExitCode.UNEXPECTED (code 1) per the task's decision text; callers that catch it (e.g. T17's RunRecorder IndexUpsertError wrapping) should not assume a more specific exit code.
- schemas/puzzle-index.schema.json describes the whole puzzles/index.json file (an array), not a single row - library.ts validates one row by compiling a $ref to the schema's #/$defs/row def. Any other code that wants to validate a single row against that schema should do the same rather than compiling the top-level schema directly.

**Reviewer notes:**
- Naming: plan.md's T21 block says loadPuzzle(id) but the T0 stub on main exported loadPuzzleById; the builder kept the stub's name. Later tasks (T17 RunRecorder, T30 list, solver wiring) should import loadPuzzleById, not loadPuzzle.
- Non-blocking: readNormalised locates a puzzle by scanning every source subdirectory for <id>.json and returns the first hit in readdir order. If the same id exists under two sources (e.g. an xd puzzle and a `file` import with the same basename) the choice is silent and filesystem-order dependent. A later wave may want readNormalised to take an optional source, or to consult the index, or to err...
- Non-blocking: the 'files paths are always POSIX and repo-relative' decision is not enforced by upsertIndexRow (the frozen schema only requires minLength 1); it relies on callers using toRepoRelativePosix from src/util/fs.ts. T17 and the source adapters must do so.

## T22 File source adapter

**Deviations:**
- normalise() throws a plain Error rather than calling the shared notImplemented() helper. Reason: the stubs.test.ts contract test scans a file for the literal 'notImplemented(' text and, if present anywhere, requires *every* exported/returned function in that module to throw NotImplementedError when called with no args - so leaving normalise() as a real notImplemented() call would have forced li...
- SourceListOptions.path (declared for the offline xd source) is reused as the file source's 'local path or URL' input, since FileSourceOptions (my own, file-local interface) only takes `fetch` per the task's explicit constructor-injection decision, and the acceptance text's `list({})` phrasing didn't specify a calling convention. Documented for T29/T27 below.

**Notes for later waves:**
- T29 (xw fetch handler): call getSource('file').list({ path: <the CLI positional path-or-URL arg> }) - the file source reads its target from SourceListOptions.path, not from a constructor option, so the registry's single pre-built `fileSource` instance (fetch: undefined, meaning it falls back to globalThis.fetch) works as-is; only `fetch` needs injecting at construction time if T29 wants determi...
- src/sources/file.ts's `normalise` field always rejects with a plain Error explaining it is unused; do not wire fetch's per-puzzle parsing through ref adapter's normalise - use src/puzzle/loader.ts (loadPuzzleWithSolution/loadPuzzle) as T29's deliverable text already specifies.
- The accepted extension set (puz, ipuz, jpz, xd, json) and the usage-error/not-found-error exit codes (2 and 3) match src/puzzle/loader.ts's own EXTENSIONS list and error codes, so a file-sourced puzzle rejected at fetch-time by the source adapter and one rejected later by the loader will look consistent to a user.

**Reviewer notes:**
- Deviation accepted: normalise() on the file adapter rejects with a plain Error rather than via notImplemented(). The reasoning holds - test/contract/stubs.test.ts scans for the literal 'notImplemented(' and would then call list() with no args and require NotImplementedError, so the helper cannot coexist with a real list(). Plan T29 explicitly parses 'via puzzle/loader', so SourceAdapter.normali...
- Calling convention for T27/T29: the file source takes its local path or URL via SourceListOptions.path (the existing --path flag on `xw fetch`, currently described as 'local corpus directory or zip, for the xd source'). T29 should pass opts.path through for `xw fetch file`, and the --path help text in src/cli/index.ts (frozen, T0-owned) could mention the file source in a later wave. Acceptance ...
- Non-ok HTTP responses of any status (including 5xx) map to NOT_FOUND (exit 3), and a network-level fetch failure (DNS, connection refused) propagates as a raw TypeError (exit 1). Neither is specified by T22; T29 may want to decide whether a transport failure on `xw fetch file <url>` should be mapped to a CliError.
- Sibling source stubs (src/sources/guardian.ts, src/sources/xd.ts) still use notImplemented(); once T27/T28 implement list()/download() they will hit the same stubs.test.ts constraint and will need to make the same choice for normalise() - consistency across the three adapters would be nice.