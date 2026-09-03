# Wave 2 build notes (for waves 3 and 4)

## Summary

| id | status | fixRounds | escalated |
|--|--|--|--|
| T24 | merged | 1 |  |
| T25 | merged | 2 | opus |
| T26 | merged | 1 |  |
| T30 | merged | 1 |  |
| T31 | merged | 0 |  |
| T32 | merged | 0 |  |
| T36 | merged | 0 |  |
| T37 | merged | 0 |  |
| T27 | merged | 0 |  |
| T28 | merged | 0 |  |
| T33 | merged | 1 |  |
| T34 | merged | 2 | opus |
| T35 | merged | 0 |  |
| T39 | merged | 1 |  |
| T40 | merged | 0 |  |
| T41 | merged | 0 |  |
| T29 | merged | 0 |  |
| T38 | merged | 2 | opus |

## T24 Loader adapter for .puz/.ipuz/.jpz

**Notes for later waves:**
- For any later task touching src/puzzle/adapters/xwordly.ts or reading .puz files: the module now has two clue-source paths - sourceCluesFrom() (trusts the package's across/down split, used for .ipuz/.jpz) and puzSourceClues() (reconstructs true file order from numbering.runs, used only for .puz, selected via isPuzMagic() checking the literal magic string at its fixed byte offset). Any future .puz-producing fixture generator must interleave clue strings by number (across before down at a share...
- test/unit/puzzle/xwordly.test.ts now exports no new symbols but defines buildSyntheticPuz()/GRID_5X5/CLUES_5X5_SPEC_ORDER/nullTerminated()/le16() as module-local helpers with a full .puz section/offset comment table; a later task adding more .puz fixtures for this adapter could reuse the same helper pattern (parameterise GRID_5X5 and the clue list) rather than hand-authoring new binaries.
- Checksums in the generated .puz are still left zeroed (unchanged from before this fix) since @xwordly/xword-parser's readHeader reads but never validates them - documented both in the adapter's top-of-file comment and in the generator's comment table. If a later task needs a checksum-validating .puz reader (e.g. for a stricter format-compliance test), the checksum algorithm was not implemented here and would need to be added from scratch.

**Reviewer notes:**
- Criterion 1 literal wording vs frozen fixture: synthetic-5x5.json and synthetic-7x7.json (read-only for T24) carry parsedBy 'xd-crossword-tools', which contradicts criterion 5; the test therefore also strips parsedBy from both sides of the deep-equal and pins '@xwordly/xword-parser' in a separate test. Reasonable resolution, but the builder's summary reports deviations: [] while both commit messages refer to a 'deviations note'; a later wave may want the canonical json fixtures to stop encodi...
- Style plumbing: XwordlyAdapterContext adds an optional `style` in the adapter's own file (additive, no frozen-file edit), but the frozen loader.ts never forwards a style, so every puzzle loaded via `xw solve <path>` gets 'unknown'. T29/T28 (fetch, source adapters) will need PuzzleAdapterContext to grow a `style` field (T0-owned contract fix) for the 'style comes from the caller' decision to be reachable end to end.

## T25 Loader adapter for .xd

**Deviations:**
- Pre-authorised contract change used: 'xd-hand' added to the ParsedBy union in src/puzzle/types.ts. It is exactly one line and nothing else in that file changed (an earlier commit had also rewritten the doc comment above it; that comment is now back to its original single line).
- Beyond the task text: the ` ~ ` answer is now validated against the solution grid instead of being discarded. This introduces a new class of load error (exit 3) for an .xd file whose stated answers disagree with its own grid. Comparison is lenient (uppercase, non A-Z stripped) so punctuated answers such as O'HARE still match OHARE.
- Beyond the task text: a block containing any clue-shaped line is now a clue block and a non-conforming line in it is a load error. Previously such a block was ignored with a warning per the 'unknown section' decision. A free-text notes block whose line begins like `A1.` would therefore now fail the parse instead of being warned about - judged the right trade, since silently dropping a whole clue block is the defect being fixed.
- The `editor` metadata key is recognised (so it is never treated as unknown) but has nowhere to go: the frozen Puzzle interface has no editor field. Unchanged from the original submission, restated here.
- Acceptance 1's deep-equal compares parsedBy separately: the frozen fixture synthetic-5x5.json says 'xd-crossword-tools' while the hand parser produces 'xd-hand'.

**Notes for later waves:**
- T48 (licence-clean xd fixtures): the .xd loader is now strict about three things a hand-picked corpus file must satisfy - (a) every clue's answer after ` ~ ` must equal the grid letters for its run once both are uppercased and reduced to A-Z, (b) no `.` (unfilled) cells and no rebus braces in the grid, (c) every clue must name a run that exists. Any of these is a CliError code 3 naming the clue and cell. A run with no clue is only a warning.
- The .xd adapter's error messages use the file's own clue notation (A1, D12), not the slot-id notation (1A, 12D) used in Slot.id and elsewhere. Anything asserting on those messages should expect the A-first form.
- src/puzzle/numbering.ts buildSlots ignores a clue with no matching run by design (B20). Any other adapter (T24 ipuz/puz/jpz, T26 Guardian) that feeds it source clues has the same silent-drop exposure T25 was failed for: check clue -> run coverage explicitly, not just the numbers grid. The Guardian payload's per-entry `number`+`direction` makes this the same one-pass check.
- assertNumberingMatches only compares set-shaped reconstructions when the source has no real numbers grid (as .xd does not); it cannot catch a clue misnumbered to a value stated elsewhere. Treat it as necessary, never sufficient.

**Reviewer notes:**
- Frozen-fixture drift for a later wave: test/fixtures/puzzles/synthetic-5x5.json says parsedBy 'xd-crossword-tools' while the adapter now produces 'xd-hand'; the acceptance-1 test excludes parsedBy from the deep-equal to cope. Once the fixture is unfrozen, update it to 'xd-hand' and consider dropping the now-unused 'xd-crossword-tools' literal from ParsedBy (T21/T48 territory).
- B20 edge case the tests do not cover (non-blocking, design-inherent): because .xd carries no numbers grid, suppliedNumbersFrom derives the file's numbering from the set of stated clue numbers. A number whose ONLY run has no clue (e.g. delete the A9 line from synthetic-5x5.xd; 9 has no down run) is therefore never stated, the zip leaves r4c3 as null, and the load fails with 'clue numbering mismatch at r4c3: computed 9, source supplied null' rather than loading with that run as a non-slot per B...
- Real-corpus notes for T48: the xd spec allows digits in the grid for rebus cells; a grid line containing a digit fails GRID_CHAR_RE, so the whole grid block is classified 'unknown' and the error is 'no grid section found' rather than a cell-naming rebus error (T24 asks for r{row}c{col} for rebus in the xwordly path; .xd has no such acceptance). Lowercase grid letters (xd's marker for circled/special cells) are silently uppercased, which is fine for solving. A clue line whose answer is empty (...
- Builder's stated deviations are accurate and reasonable: answer-vs-grid cross-check adds a new exit-3 class for self-inconsistent files; any clue-shaped line makes a block a clue block (a free-text notes block starting 'A1.' would now error instead of warn); 'editor' metadata is recognised but has no Puzzle field to land in (frozen interface) - a later wave might add Puzzle.editor if wanted.
- Adapter `name` changed from the stub's 'xd-crossword-tools' to 'xd-hand'; nothing in src looks adapters up by name (only extensions), and the contract stubs test still passes, so no impact.

## T26 Guardian JSON puzzle adapter

**Notes for later waves:**
- T28 (Guardian source adapter) reads test/fixtures/guardian/cryptic-sample.json directly - its clue texts have changed (see summary) but the shape, ids, positions, lengths, solutions and enumerations are all unchanged, so nothing in T28's expected wiring should break.
- The B42 cross-slot leak check is easy to violate by accident when hand-authoring a fixture: a definition clue for one answer can innocently contain a substring of a totally unrelated answer elsewhere in the same grid (e.g. 'material' leaking ATE, 'plant' leaking ANT, 'past' leaking PAS). Any later task that hand-writes a puzzle fixture with real English clue text (T25 xd adapter, T48 fixture curation) should run the same cross-slot substring check against the full solution set before committi...

**Reviewer notes:**
- src/puzzle/adapters/guardian.ts:284 - guardianAdapter.parse does JSON.parse synchronously before Promise.resolve, so a malformed .json file throws a raw SyntaxError synchronously from a Promise-returning method (a `.catch()`-chained caller would miss it; `await` in try/catch is fine) and would surface as a crash rather than a CliError exit 3. Not an acceptance criterion for T26; whoever wires `xw solve <path>` (T44/T51) may want to wrap JSON.parse in notFoundError and make parse `async`.
- src/puzzle/adapters/guardian.ts:128-148 - all separator kinds in separatorLocations are merged and rendered with commas, so a Guardian hyphen separator ({"-": [3]}) yields "(3,4)" rather than "(3-4)". Constrained by T7's normaliseEnumeration(lengths) API, which cannot express separator characters; enumeration is prompt-only (B21), so this is cosmetic. A later wave could extend normaliseEnumeration to take (length, separator) pairs.
- The frozen contract B42 test (test/contract/schemas.test.ts) only iterates test/fixtures/puzzles/synthetic-*.json; the Guardian fixture's B42 coverage lives solely in the unit test. When T28 normalises a Guardian puzzle to puzzles/<source>/<id>.json, consider adding a committed normalised Guardian fixture to that list so the contract test covers it too.

## T30 xw list and xw show handlers

**Notes for later waves:**
- src/cli/list.ts's table-width cap (fitWidths/truncateTo, MIN_FREE_TEXT_WIDTH = 8) only shrinks the id/style/source columns; it assumes date, size, slots, best-letters and last-run stay within their fixed formats (ISO date or '-', WxH, integer, percentage or '-', ISO date or '-'). If a later wave ever lets one of those columns hold free-form or unbounded text, the 80-column guarantee would need to extend to it too.
- The 8-character floor (MIN_FREE_TEXT_WIDTH) means an extremely long id/style/source combination together with wide realistic values in the other five columns could in theory still exceed 80 (the algorithm only shrinks id/style/source, never the other five); this is not reachable with today's fixed-format columns but worth knowing if COLUMNS grows.

**Reviewer notes:**
- show.ts printGrid renders open cells as '.' only and never prints clue numbers in the grid; the plan's phrase 'numbered grid' is satisfied only via the numbered Across/Down clue lists. Acceptance 6 explicitly expects '. . # . .' so this is consistent with the plan, but a later polish task may want cell numbers rendered.
- list.ts: a non-empty index filtered down to zero rows prints the header line only (no rows, no B33 message). This is the deliberate reading of B33 (empty index vs filtered-to-empty) and is commented in the code; if a friendlier 'no matches' line is wanted it belongs to a later CLI polish task.
- The production path resolveLibraryOptions (loadConfig -> resolvePuzzlesDir({ config })) in both handlers has no unit test; unit tests inject libraryOptions directly and test/contract/cli.test.ts only checks option registration. I verified by reading src/config.ts that loadConfig returns { config: {} } when the default config file is absent, so a fresh checkout works, but an end-to-end `xw list` smoke test would be worth adding when a CLI integration test task lands.

## T31 Prompt templates

**Deviations:**
- Acceptance 7 asks for a JSON object 'identical to' the schema file's single-response branch; the prompt inlines that branch with its `#/$defs/candidate` $ref RESOLVED (and the test resolves the file's refs before deep-equalling), because a model cannot follow a $ref into a document it was never sent.
- Each batched clue object carries an optional `enumeration` key beyond the spec's `{ id, clue, length, pattern, style }` shape, because the seed template is required to carry the enumeration and dropping it inside a batch would degrade batched seeding for a reason unrelated to batching.
- src/llm/prompts.ts gained one export beyond the stub signature, `promptKindFor(purpose): PromptKind`, so T34 and the inference log get the purpose-to-template mapping from its single owner (B23) rather than re-deriving it.

**Notes for later waves:**
- T34 (CandidateService): import `promptKindFor` from src/llm/prompts.ts for both the cache key's `promptKind` field and the render call; do not re-derive the mapping. It returns 'constrained' for reask and repair, 'seed' for seed/smoke/calibrate and 'escalate' for escalate.
- T34: renderPrompt sorts `rejected` (answer, then reason) and `crossingContext` (slotId) exactly as util/hash.ts cacheKeyFields does, so prompt bytes and cache key stay in lockstep. If a future change re-orders one, it must re-order the other or one cache entry will stand for two different prompts.
- T34: renderBatchedSeedPrompt throws a plain Error (not a CliError) for a non-seed purpose or an empty batch - both are programming errors, so the service should never let one reach it rather than catching it.
- T34/T32: `RenderOptions.inlineSchema` is the only knob; nothing else about the prompt depends on the model or the tier, and a test asserts tier 1 and tier 2 render identical bytes and that neither the source nor any rendered prompt contains 'nemotron' or 'deepseek'. T32 sets inlineSchema from capabilitiesOf(model).supportsStructuredOutputs.
- T32: the JSON Schema this task inlines is the single (and batched) branch with $refs resolved. T32's `response_format.json_schema` should send the schema file itself; the two are deliberately different objects and the prompts test pins the inlined copies against the file so they cannot drift.
- The six golden files under test/fixtures/prompts/ are compared byte for byte. Any deliberate wording change regenerates them with `UPDATE_GOLDENS=1 vitest run test/unit/llm/prompts.test.ts`, and for a shipped promptVersion that lands with the regenerated cache in the same commit (B49). No later task may bump PROMPT_VERSION.
- T49 (M2 spike): the one-shot example and the inline schema are the exact bytes tier 1 receives when a model lacks structured outputs; if the spike finds a parse-failure pattern, the fix belongs in this file and lands with regenerated goldens.
- The batched request's clue objects carry an optional `enumeration` key alongside id/clue/length/pattern/style; T49's batch-size bench should be aware the batched form is not byte-identical to the spec snippet in that one respect.

**Reviewer notes:**
- For later waves (T34/T12): the batched user message asks for 'up to max(n)' across the batch and lists neighbouring clues, so a clue's prompt bytes inside a batch depend on its batch-mates while its cache key carries only its own n plus batchSize. This is inherent to batching rather than a T31 defect, but the cache-key invariant ('every field that changes the prompt bytes is in the key') is only true per clue for batchSize 1.
- Doc inconsistency outside T31's scope: docs/crossword-algorithms.md 'Candidate generation with the LLM' still says the parser takes the FIRST balanced JSON object, while docs/spec.md and src/llm/parser.ts take the LAST. The prompt follows the parser (correct); the algorithms doc should be corrected by whoever next owns docs/**.

## T32 Tier router

**Deviations:**
- route() gained an optional third parameter `opts: RouteOptions = {}` (currently only `seed?: number`) beyond the two-arg `route(req, profile)` the deliverable text describes, because neither CandidateRequest nor Profile (both frozen/read-only) carries the CLI --seed value that B38 requires the router to gate on capability and forward. This mirrors the precedent set by T8's pricing.ts, which added an optional trailing `path` param beyond its own T0 stub signature for the same reason (a value w...
- RoutedRequest.request.messages is left as an empty array with a code comment: prompt rendering is explicitly out of scope for T32 ('the prompts themselves (T31)'), prompts.ts is a same-wave sibling module this task does not read, and CandidateRequest alone does not carry the full prompt-rendering context (title, rejected reasons, crossing context wording, etc.) that T31's renderPrompt needs. T34 (CandidateService, which reads both llm/tierRouter.ts and llm/prompts.ts) is expected to fill mess...

**Notes for later waves:**
- For T34 (CandidateService): RoutedRequest.request.messages is always [] - call llm/prompts.ts renderPrompt(req, promptKind, { inlineSchema: routed.inlineSchema }) yourself and merge its messages into the LlmRequest before calling the transport. Everything else on routed.request (model, temperature, maxTokens, topP, responseFormat, extra) is ready to send as-is.
- For T33/T34: route() has a required side effect of calling getLimiter(model, {rpsFraction, maxConcurrency}) with the tier-correct options. Any code path that could touch a model's rate limiter (e.g. via getLimiter directly) before the first route() call for that model would permanently lock in the wrong maxConcurrency for it, since getLimiter ignores opts after first creation. Always route() before acquiring from a model's limiter.
- REASONING_OFF_PARAM is set to the placeholder string 'reasoning_effort' with value `true` in request.extra - both the key name and the value shape are TODO(T49) placeholders (the M2 spike). Do not treat `true` as meaningful API semantics; it only proves the branch fired for tests.
- capabilitiesOf(model) and getLimiter(model, opts) are both called by tierRouter with the real repo-root catalogue (no `path` override), consistent with wave1 guidance that production callers of T8's functions should call with just the model id.
- --seed threading: opts.seed on route() is meant to be populated from SolveOptions.seed (src/cli/options.ts, frozen) by whichever wave-3+ code wires solve options into CandidateRequest construction; tierRouter itself has no access to CLI options.

**Reviewer notes:**
- Orchestrator decision needed (not graded as a defect): the note to the builder said to 'send nothing until it is known' for the reasoning-off parameter, but plan acceptance 4 requires REASONING_OFF_PARAM to be emitted, and the builder followed the plan. src/llm/tierRouter.ts line 96 puts `extra.reasoning_effort = true` on every tier-1 seed call (Nemotron advertises `reasoning`), and T33's transport will presumably forward `extra` to the wire. `true` is not a plausible value for an OpenAI-comp...
- response_format.json_schema embeds the raw schema document verbatim, exactly as the spec's 'Candidate service' step 2 and B9 word it. OpenAI-compatible endpoints usually expect `json_schema: { name, schema, strict? }`. T33/T49 should confirm Nebius's accepted shape; if a wrapper is needed, the change belongs in tierRouter.ts (or the spec) in a later wave.
- The router tests mock the whole src/llm/pricing.js module and use fake model ids; no committed test routes the real default models or reads test/fixtures/models.min.json. Coverage of the T8->T32 integration is transitive (pricing.test.ts pins Nemotron/DeepSeek capabilities) plus the reviewer's manual Docker run. A single unmocked test using ProfileObject.parse({name}) defaults against models.json would close that gap cheaply in a later wave.
- route() calls getLimiter on every invocation (cheap Map lookup after the first), so the 'first touch sets final options' guarantee only holds if route() runs before any other getLimiter(model) call for that model. T34 naturally calls route() before transport.complete(), but nothing else (e.g. a future warm-up or xw cache/smoke path calling getLimiter directly) should touch a model's limiter first.

## T36 AC-3 prepass

**Deviations:**
- Ac3Result (frozen src/solver/types.ts) has no `suspect` or `capped` field that acceptance 3 and 7 name, so `ac3` returns an exported `Ac3PrepassResult extends Ac3Result` adding `suspect: string[]` (same slots as `wipeouts`) and `capped: boolean`; it stays assignable to the frozen `Ac3Fn`, and the test asserts that. Needed contract change if anyone wants it first-class: add `suspect` and `capped` to `Ac3Result`.
- The plan's decision "reductions go through DomainStore.reduce at depth 0 so they are trailed" is not achievable as written - T4 makes a depth-0 reduce permanent because there is no frame - so reductions are applied at depth 0 (permanent, and the prepass never mutates base domains) and the wipeout restore is achieved by never applying the failing revision rather than by undoing it. Reason: pushing a frame would make every prepass reduction vanish on the search's first undoTo(0).
- An arc whose target domain is empty is visited (ac3:arc emitted) but not revised. Reason: an unseeded or fully rejected slot is already on the escalation queue from step 2, and treating it as a constraint would wipe out every neighbour in turn, which is the cascade B40 exists to stop.

**Notes for later waves:**
- T44 (solve orchestration): `ac3` is a plain exported function, not a `const: Ac3Fn`, and returns `Ac3PrepassResult` (Ac3Result plus `suspect` and `capped`). It is assignable to the `Ac3Fn` slot in SolveDeps; read `suspect`/`capped` only if you hold the concrete import. `opts` has a default of `{}` so `ac3(grid, domains, emit, {})` and `ac3(grid, domains, emit)` are both fine.
- T18/T38 (escalation): AC-3 marks suspect through `DomainStore.markSuspect`, which T4 does not trail, so the mark outlives every backtrack; `result.suspect` is the same list in wipeout order. AC-3 itself makes no escalation decision.
- T37 (search): the prepass leaves the store at depth 0 with its reductions permanent, so the search can `push()` its first frame straight away and `undoTo(0)` never resurrects a candidate AC-3 removed. AC-3 emits no phase events; T44 owns `phase:start('prepass')`/`phase:end`.
- `Ac3Options.maxArcs` semantics as implemented: undefined means the 50,000 default from the T36 decision list, 0 means no cap (the frozen type's doc comment). A profile that wants an uncapped prepass must pass 0 explicitly.
- Arc identity is the ordered slot pair, and two slots sharing more than one cell collapse into one arc requiring agreement at all shared cells. No synthetic fixture exercises that today; it exists so an unusual grid cannot silently lose a constraint.
- test/fixtures/domains/*.json now has a shape later solver fixtures can reuse: `{ name, description, puzzle | puzzleRef, domains: { slotId: [answers, best first] } }`, with the test deriving Candidate scores from list position. T37's search-*.json could follow it.

**Reviewer notes:**
- Deviation accepted: Ac3Result (frozen) lacks `suspect` and `capped`; ac3 returns an exported Ac3PrepassResult widening it, and the test pins assignability to Ac3Fn. `suspect` is a copy of `wipeouts` (the frozen field's own doc says wipeouts are the suspect slots). T44 will see the extra fields at runtime through SolveResult.ac3 but not in its static type; if anyone wants them first-class, add `suspect: string[]` and `capped: boolean` to Ac3Result in src/solver/types.ts in a contract wave.
- Contract wording mismatch for a later wave: the frozen Ac3Options doc comment says 'maxArcs: 0 or undefined means no cap', but the plan's T36 decision mandates a 50,000 default. The builder reconciled it as undefined -> 50,000 and 0 -> uncapped, with tests for both. T44 should pass maxArcs explicitly (or 0) if it wants the contract's literal reading; otherwise update the comment in src/solver/types.ts to say 'undefined means the 50,000 default'.
- Deviation to be aware of for T18/T44: an arc whose target domain is empty is visited (ac3:arc emitted) but does not revise the source, so an unseeded slot never wipes out its neighbours. This is a sound reading of the spec's cascade warning but means a slot emptied at seed time does not appear in `wipeouts`/`suspect`; the escalation queue from step 2 remains the only record of it.

## T37 Search core

**Deviations:**
- `SearchHooks.onEmptyDomain` returns `Promise<EscalationDecision>` in the frozen src/solver/types.ts, not the boolean the T37 task text and acceptance 8 describe. Reason: types.ts is frozen and T0 wins, so 'candidates were merged' is read as `decision.action !== 'give-up'` plus a non-empty domain after the pattern filter is re-applied; both outcomes are asserted with fakes.
- `SearchOptions` carries no clock, but the task requires an injected one for the 250 ms progress rule. Reason: types.ts is frozen, so search.ts exports `SearchCoreOptions extends SearchOptions` with an optional `now?: () => number` defaulting to `Date.now`; the extra property is optional so the function stays assignable to `SearchFn` (asserted by a test) and T44 needs no change.
- `search:assign.producedBy` is emitted as `tier1`/`tier2` rather than a model id. Reason: `Candidate` carries only `tier: 1 | 2` and no model identity, and the search may not reach the candidate service; `run:start` already carries `models: { tier1, tier2 }` so a renderer or report can resolve the id from the stream.
- `progress.usd` is always 0. Reason: the search spends no money and has no budget tracker handle; T19/T44 own cost accounting and the event's `usd` field is required.

**Notes for later waves:**
- T38: `onEmptyDomain` is treated as successful when the returned decision's action is not `give-up` AND the slot's domain is non-empty after the search re-applies the pattern filter. Merging candidates and returning `{ action: 'none' | 'reask' | 'escalate' }` makes the search retry the slot; returning `give-up`, or returning without merging anything that matches the current pattern, makes it backtrack. The search re-applies the pattern filter itself after every hook return, so T38 may merge ca...
- T38: `chargeBudget` is called exactly once per backtrack as `chargeBudget('backtracks', 1)`, before the unwind. A non-null `exceeded` ends the search immediately and gracefully with the best partial fill; the search never throws and never retries after a reported cap.
- T38: `onSearchTermination` is called exactly once, always (with `[]` when the search completed), after the best partial fill has been restored to the grid and after the domain store has been unwound to the depth the search was handed. Decisions it returns are ignored by T37 - acting on them is T44's call.
- T44: `search` leaves the domain store at exactly the depth it was given (`undoTo(baseDepth)`), so the trailed forward-check reductions are gone when repair runs, while any re-ask merged into a base domain survives (B39). The grid, by contrast, keeps the best partial fill.
- T44/T39: when the search ends on a partial fill it unassigns the current branch and re-assigns the best fill it ever held, emitting real `search:unassign` and `search:assign` events for both, so a renderer replaying the stream ends on the same grid the caller is handed. A run's `search:assign` count is therefore not the number of distinct slots filled.
- T39/T41: `search:backtrack.reason` is one of `wipeout`, `empty-domain`, `values-exhausted` or `lds-limit`, and `slotId` names the slot being *undone* (the backjump target), not the slot that failed. `search:wipeout` names the slot that failed.
- T36 (AC-3): the search calls `domains.push()` before each assignment and `undoTo(frame.depthBefore)` on backtrack, so it never depends on prepass reductions being trailed. A permanent depth-0 AC-3 reduction is safe from the search's point of view.
- `coverage/` is not in the frozen `.gitignore` even though eslint ignores it, so `vitest run --coverage` (which T2's CI job runs) leaves an untracked directory. Whoever next owns `.gitignore` may want to add it.
- The `test/fixtures/domains/search-*.json` shape is `{ description, puzzle | grid, domains }`: `puzzle` names a file under `test/fixtures/puzzles`, `grid` is rows of `.`/`#` expanded by a test-local numbering helper, and `domains` maps slot id to `[{ answer, score }]` with rank taken from array order. T36's `ac3-*.json` fixtures could reuse it if that is convenient.

**Reviewer notes:**
- Design consequence for T42/T44, not a defect: recordBest() runs right after assignment and before forwardCheck, so the restored 'best partial fill' can include an assignment that immediately emptied a crossing domain (the unsolvable-fixture test deliberately expects {1A:'CAT'} even though CAT wipes out 2D). After restore the DomainStore is at base depth, so domains are not forward-check-consistent with the restored grid; downstream code should rebuild patterns from the Grid, not trust domains.
- Behavioural note for T38: a slot that can never be filled (e.g. seeded empty with no crossings) is re-visited after every backjump, so hooks.onEmptyDomain is called on every visit and the search burns backtracks until maxBacktracks or a budget cap. T38's re-ask guards (pattern unchanged, reasksPerSlot) must make repeat calls cheap.
- Deviations accepted as justified by the frozen contract: onEmptyDomain returns EscalationDecision (treated as refilled when action !== 'give-up' and the pattern-filtered domain is non-empty); SearchCoreOptions extends SearchOptions with optional `now` (assignability to SearchFn asserted by a test); search:assign.producedBy is 'tier1'/'tier2' because Candidate carries no model id (spec text says model id; T14 renderer / report can map via run:start.models, or T44 could wrap emit); progress.usd...
- Minor semantics worth knowing for later tuning: abandoning a node for exceeding ldsLimit is counted as a backtrack and charged to the 'backtracks' cap (reason 'lds-limit'); a discrepancy costs 1 for any non-first value regardless of index, matching the spec wording rather than classic LDS index-k cost; tryRefill trails its pattern re-filter (reason 'pattern') at the current depth, a harmless departure from B39's 'not trailed' wording since it is re-derived on every visit.

## T27 xd source adapter

**Notes for later waves:**
- T27's xd fixtures (test/fixtures/sources/xd-mini/ and xd-mini.zip) are two hand-authored .xd files dated 1963-05-01 and 1998-11-12 in an otherwise flat directory (no publisher/year subdirectories) - real corpus layout may be nested, which the date-extraction regex (first yyyy-mm-dd substring anywhere in the relative path) already handles, but it has not been exercised against a nested fixture.
- The xd source encodes zip-backed refs' PuzzleRef.url as an internal 'zip:<absZipPath>::<entryName>' scheme (parsed back in download()); this is a private encoding local to src/sources/xd.ts, not part of the SourceAdapter/PuzzleRef contract, so nothing outside this file should parse or depend on its shape.
- Following T22's precedent, src/sources/xd.ts's normalise() now also just rejects with a plain Error naming src/puzzle/loader.ts - T28 (guardian source, also wave 2) will hit the same stubs.test.ts constraint once it implements list()/download() and should make the same choice for consistency across all three adapters, per T22's reviewer note.

**Reviewer notes:**
- Date detection picks the first yyyy-mm-dd substring anywhere in the relative path, so a corpus root folder that itself carries a date (e.g. 'snapshot-2024-01-15/...') would shadow the per-file date for every entry. Fine for the real corpus layout; worth remembering for T48 fixture layout.
- The directory-case PuzzleRef.url is a bare absolute filesystem path rather than a file:// URL; consistent with how download() consumes it, but T29/T30 should not assume url is always a URL for the xd source.

## T28 Guardian source adapter

**Notes for later waves:**
- T29 (xw fetch handler): call getSource('guardian').list({ series, limit }) then, per ref, .download(ref) then .normalise(bytes, ref) - normalise() recovers series/style from ref.url (matching /crosswords/<series>/<digits>.json$), not from any extra field on PuzzleRef, so a ref built by anything other than this adapter's own list()/download() must have a URL of that exact shape for normalise() to work.
- GuardianSourceOptions now carries an injectable now/sleep clock pair (defaulting to Date.now/setTimeout) alongside fetch, per A2's 'injectable clock, independent of llm/rateLimiter' decision - useful if T29's tests or a future bench-mode caller wants deterministic/instant timing without vi.useFakeTimers().
- guardianUserAgent(version?) is exported from src/sources/guardian.ts for anyone (e.g. a future README generator or T1's docs) that wants the exact real User-Agent string without duplicating the template.
- PuzzleRef.id for guardian refs is `guardian-<series>-<numericId>` (e.g. guardian-cryptic-29296); no date/title fields are populated since the Guardian JSON payload (per T26's GuardianPayload type) carries neither at the point list() can see it.
- list()'s per-id probe performs a full fetch + light JSON-shape check (not the full parseGuardianPayload/numbering validation) before deciding to keep walking; full validation happens later in normalise(). A puzzle that fails T26's stricter checks (e.g. numbering mismatch, solution/length mismatch) will still appear as a ref from list() and only fail when the caller calls normalise().

**Reviewer notes:**
- Hygiene: no `any` (the only grep hit is the comment text 'beyond this: any anchor' in src/sources/guardian.ts:101, a false positive); 0 non-ASCII bytes in main..HEAD; single commit 'T28: implement Guardian source adapter' with no attribution/Co-Authored-By/Claude-Session lines; no notImplemented() in src/sources/guardian.ts so it drops out of test/contract/stubs.test.ts's scan (consistent with the T22 precedent in wave1-notes.md). Decisions spot-checked in code: own 1 rps gate with injectable...
- For T29 / a later wave: list() does a full GET + JSON parse + shape check of every id it walks, and download() then re-fetches the same URL, so each fetched puzzle costs 2 requests (limit 20 = 41 requests, ~41 s at 1 rps). ProbeResult.bodyText is populated but never used. Caching the probe body (or returning it on the ref) would halve traffic on the unofficial endpoint, which is the spirit of A2. Not a correctness defect.

## T33 Nebius transport client

**Notes for later waves:**
- The limiter-slot-leak fix in src/llm/client.ts's complete() loop changes control flow structure (added an outer try/finally per attempt with an observeOnce guard) but preserves all existing behavior on the happy/retry/error paths verified by the pre-existing 9 tests plus 2 new ones (11 total, all passing). Any future edit to src/llm/client.ts's retry loop must keep the invariant: exactly one limiter.observe() call per limiter.acquire() call, on every exit path (return, throw, break, continue).

**Reviewer notes:**
- Signature extension in an owned file: NebiusTransportOptions.apiKey went from required (`apiKey: string` in the wave 0 stub) to optional, defaulting to $NEBIUS_API_KEY, plus new optional emit/random/sleep/env fields. Backward compatible for T45/T46 callers; the missing-key case throws providerError (exit 5) with hint 'cp .env.example .env' and is covered by the 'throws a CliError naming the .env hint, never an opaque 401' test.
- Base URL precedence for the wiring task (T45/T46): the plan's decision reads '$NEBIUS_BASE_URL or the config's nebiusBaseUrl or the Nebius default' (env first), but createNebiusTransport resolves opts.baseUrl > $NEBIUS_BASE_URL > default (src/llm/client.ts line 256). If the caller passes config.nebiusBaseUrl as opts.baseUrl it will shadow the env var; the caller should pass `env.NEBIUS_BASE_URL ?? config.nebiusBaseUrl` (or leave baseUrl undefined when config has none) to preserve the document...
- Aborted attempts write no inference-log record: on AbortError the transport rethrows before inferenceLog.write (src/llm/client.ts line 308), so an aborted attempt is absent from the log even though InferenceLogRecord.error is documented as 'Transport or abort error message'. The limiter slot is released correctly (finally block). Whoever owns abort/Ctrl-C handling (T45/T46) may want a record with error set for the aborted attempt; acceptance did not cover it, so this is non-blocking.
- Mid-body failure surfaces as a raw error: `response.text()` (line 333) is outside the fetch try/catch, so a connection reset while reading the body propagates as a non-CliError (exit 1 UNEXPECTED with a stack trace) instead of being retried or mapped to exit 5, and no record is written for that attempt. The limiter slot is still released via finally. Hardening idea for a later wave: treat a body-read failure like a network error (log a record, back off, retry).
- Record placeholders: because the transport knows nothing about candidates, every record it writes carries purpose 'smoke', promptKind 'seed', tier 1, cacheKey '', batchSize 1, batchIndex null, sampleIndex 0, runId/puzzleId/slotId null (documented at lines 28-46). T34/T45 will need a decorator or an LlmRequest extension to populate these; report --inference (T41) should not assume purpose/tier on transport-written records are meaningful until that lands.
- Test wall time: the six-429 acceptance test takes ~3.8s because each observe({status:429}) halves the shared limiter's rps (9 -> 4.5 -> 2.25 -> 1.125 -> 1) and the next acquire() waits on the real sliding window. This is correct behaviour under the spec, but a later wave could inject a limiter or pass a higher rpsFraction in that one test if suite time becomes a concern.

## T34 CandidateService

**Deviations:**
- Deliberately NOT changed: the `slot:ask` event still carries the clue's chunk position even when that clue turns out to be a cache hit. Three reasons: the event is emitted before the cache lookup (askSingle does the same and simply always passes null), src/events/types.ts documents no null-on-hit rule for it (unlike InferenceLogRecord.batchIndex, which states it explicitly), and eval/runRecorder.ts:479 derives RunRecord.perSlot.batchIndex from that event - if it went null on a replay, `xw rep...
- Pre-existing (T6 wave-1 drift, unchanged this round): validateCandidates returns `echoWaived`, but src/events/types.ts is frozen and has no waiver event, so the waiver is reported through log.debug in finish() rather than emitted. A waiver event type is the contract change that would be needed.

**Notes for later waves:**
- T46/T49 (`xw report --by batchIndex`): the inference log and RunRecord.perSlot now disagree by design on replays - an inference record for a cache hit has batchIndex null (frozen contract), while perSlot.batchIndex keeps the chunk position because runRecorder reads it from slot:ask, which fires before the cache lookup. Positional analysis of a replayed bench must therefore come from perSlot, not from the inference log; the log's `--by batchIndex` view will only ever see cold calls.
- T33 (Nebius client) writes InferenceLogRecord values itself: the cache-hit invariants (batchIndex, request and rawResponse null, usdBilled 0, usage from the cached blob) live in src/candidates/service.ts writeRecord, not in a shared helper, so a second producer of records must re-establish them.
- T18/T38: RunCandidateService.parseFailures(slotId) counts, per slot and cumulatively for the run, each failed single attempt plus each batch element the parser could not realign; two failed attempts of one single ask therefore read as 2, which is the tier-1 failure the escalation policy acts on.

**Reviewer notes:**
- Echo waiver deviation is justified: src/events/types.ts (frozen) has no waiver event (grep for waiv/echo returns nothing), so the waiver is reported via log.debug in finish(). A later wave that owns src/events/types.ts should add a `candidate:echo-waived` (or similar) event and have the service emit it.
- Integration note for T33/T44: the service writes an InferenceLogRecord for every cold call attempt (needed because it alone knows purpose/promptKind/cacheKey/slotId), but the T33 plan block and the spec Decisions log say the transport client also writes one record per attempt. When T33 lands, cold calls will be double-logged unless T33's record-writing is dropped or the two are reconciled. Not a T34 defect (T0's CandidateServiceDeps already carried inferenceLog).
- Integration note for T18/T38: parseFailures(slotId) accumulates across a batch element failure plus each failed single attempt, so a batch miss followed by one failed single attempt and a successful temperature-0 retry yields parseFailures 2, which src/policy/escalation.ts:70 treats as trigger 1 even though the slot has a good domain. Plan acceptance only requires the count to be 2 after two single failures; whether a batch element failure should count is a T18/T38 semantic to settle.

## T35 xw cache subcommand

**Deviations:**
- src/cli/options.ts's CacheClearOptions has no `yes` field and src/cli/index.ts's `cache clear` subcommand registers no `--yes` flag in its commander chain (both frozen, outside T35's Owns list), yet the T35 task text requires clearing the whole cache to be gated behind an explicit confirmation (acceptance 4). Implemented the closest correct thing: cache.ts defines a local `CacheClearInput` type extending the frozen `CacheClearOptions` with an optional `yes` field and enforces the gate against...
- The task deliverable's 'last-run hit rate' has no data source within CandidateCache/util/fs (the only Reads T35 was given) and is not covered by T35's Acceptance list. Implemented it as a best-effort read of the raw inference log (logs/inference/*.jsonl, an already-implemented Wave 1 (T10) contract type) grouped by runId, since that is the only well-defined source of hit/miss history in the codebase; it degrades to 'n/a' when no log is found. This is additional behavior beyond the tested acce...

**Notes for later waves:**
- cache.ts exports `CacheCommandOverrides` ({cacheDir?, inferenceLogDir?, measureBytes?}) as the third/last positional parameter to all four command functions (cacheStatsCommand, cacheClearCommand, cacheExportCommand, cacheImportCommand) purely for test injection -- the real CLI (src/cli/index.ts) never passes it.
- cacheClearCommand's first parameter is typed `CacheClearInput` (a local type in src/cli/cache.ts extending options.ts's CacheClearOptions with an optional `yes?: boolean`), not `CacheClearOptions` directly -- see the deviations note. Whichever task eventually adds a real `--yes` flag to the `cache clear` commander definition in src/cli/index.ts / CacheClearOptions in src/cli/options.ts should just widen CacheClearOptions itself with `yes?: boolean` and cache.ts's CacheClearInput can then be d...
- The export/import tarball format is a minimal hand-rolled USTAR reader/writer (gzip via node:zlib) local to src/cli/cache.ts, not the `tar` npm package (not in the frozen package.json's dependency list) and not a shelled-out system `tar` binary. It only needs to round-trip through its own reader (verified byte-for-byte via export then import into a fresh directory, compared by recursive path+sha1 listing) -- T50 (committed offline test cache) should go through `xw cache export`/`xw cache impo...
- openCandidateCache's CandidateCacheOptions.measureBytes and CacheStats.overSizeWarning (from T12) are exercised by cacheStatsCommand exactly as documented in the T12 wave1 notes -- no drift found there.

**Reviewer notes:**
- FOLLOW-UP NEEDED (frozen files, outside T35 Owns, builder flagged it): `xw cache clear --yes` fails with commander's 'error: unknown option --yes' (exit 2), so a whole-cache clear is unreachable from the real command line. Fix in a later wave by the T0 owner: add `.option('--yes', 'confirm clearing the whole cache', false)` to the `cache clear` builder in src/cli/index.ts and `yes?: boolean` to CacheClearOptions in src/cli/options.ts; cache.ts's CacheClearInput already accepts it, so no chang...
- Performance (beyond acceptance, not a defect): lastRunHitRate reads every logs/inference/*.jsonl file fully into memory and retains every run-scoped record in a Map. Raw inference logs carry request/rawResponse bodies, so on a machine with many runs `cache stats` may become slow and memory-heavy. A cheaper approach for a later wave: read only the newest file(s) or stream lines and keep only counts per runId.

## T39 WatchRenderer

**Notes for later waves:**
- No contract or interface changes were needed; this was a pure bug fix inside src/render/watch.ts's private truncate() method plus one new test. Nothing for downstream tasks (T40/T41 or wave 3) to react to.
- The fix generalizes: truncate() now correctly handles any ANSI SGR sequence (not just the specific tier/confidence combinations used by WatchRenderer today), so it will keep working if future colouring adds more SGR codes to a cell.

**Reviewer notes:**
- Non-blocking for T45 (`xw solve`): the renderer never calls log-update's `done()` (or `clear()`), and exposes no close/finish method. The CLI will need to call `logUpdate.done()` after run:end so later stdout output (score/cost blocks, prompt) does not overwrite the last frame. Consider a `finish()` method on WatchRenderer when T45 wires it.

## T40 Report aggregation

**Deviations:**
- The repo's frozen .gitignore has a bare `runs/` pattern, which (having no leading slash) also matches test/fixtures/runs/aggregate/ - the exact path this task's Owns list requires for fixtures - and would silently exclude them from any commit. Rather than edit the frozen .gitignore, the fixture files were staged with `git add -f`. The underlying fix, for whoever owns .gitignore, is anchoring that pattern to the repo root (e.g. `/runs/`) so it stops also matching same-named directories under t...
- The plan's acceptance-3 wording ('usd per correct word ... changes when a fixture's usdBilled alone is edited (proving billed is not used)') is self-contradictory as literally written; implemented and tested the reading consistent with its own parenthetical and with B2 ('usdBilled is reported alongside but never divided by anything'): editing usdBilled alone leaves the ratio unchanged, editing usdCounterfactual alone changes it.
- compare()'s exported signature takes two GroupAggregate values, matching the pre-scaffolded T0 stub already in aggregate.ts, rather than the two group-name strings the acceptance prose shows (compare("baseline","patient")); the test resolves those names to their GroupAggregate via aggregation.groups.find(...) before calling compare(), which reproduces the acceptance behaviour without diverging from the file's own pre-existing type contract (precedent: T4/T20 both treated a pre-scaffolded owne...

**Notes for later waves:**
- T46 (xw report CLI): aggregate() is grouping-mode-aware - 'profile'/'puzzle'/'stratum' produce one GroupAggregate per whole RunRecord, but 'tier'/'batchIndex' produce one per flattened perSlot entry instead (spec: 'groups by producing tier' / 'groups by the clue's position within its batch' are properties of a clue, not a run). For the slot-level groupings, GroupAggregate.letters/words/perfect all collapse to the same correct-fraction indicator (no per-letter truth exists on PerSlotRecord), u...
- opts.splitVariance is an explicit caller-supplied flag, not auto-detected from repeatIndex spread in the data; T46/bench must pass splitVariance: true itself when it knows repeat > 1 for the runs being aggregated.
- GroupAggregate.variance (when present) decomposes letter-accuracy variance only, via a per-puzzle sub-partition of the group's records: withinPuzzle is the mean of each puzzle's own sample (n-1) variance across its repeats (null if no puzzle in the group has >=2 repeats); acrossPuzzle is the sample variance of each puzzle's mean letter accuracy (null if the group has <2 distinct puzzles). Slot-level groupings never carry a variance field.
- The difficulty view (Aggregation.slotDifficulty) is computed globally across every input record regardless of the 'by' option, keyed on (puzzle.id, slot.slotId); a profile counts as having gotten a clue 'wrong' if ANY of its runs on that puzzle had that slot incorrect (relevant if T46/bench ever feeds it repeat > 1 records for the same puzzle+profile pair).
- .gitignore's bare 'runs/' pattern will keep swallowing any future fixture directory literally named runs/ under test/fixtures/** (or anywhere else) unless a later task narrows it to '/runs/'; worth a one-line fix by whoever next touches that frozen file, since every affected task will otherwise need its own git add -f.

**Reviewer notes:**
- Contract change for T46 to note: GroupAggregate.letters/words/perfect.stdev is now `number | null` and variance components are `number | null` (the T0 stub had plain `number`). This is required by the baked-in decision (stdev null for n=1) but T46's renderer must handle nulls.
- Non-blocking ordering quirk for T46: groups are sorted with String.localeCompare, so `--by batchIndex` with batch sizes above 10 yields order '0','1','10','11','2',... T46 should sort batchIndex/tier groups numerically when rendering the positional drop-off table (or T40 could sort numerically when the key parses as an integer).
- Slot-level groupings ('tier', 'batchIndex') report letters/words/perfect all as the same per-slot correct fraction (documented approximation in the code), usdPerPuzzle as mean per-slot usd, meanWallMs as mean per-slot latencyMs, and tier2Share as the share of slots produced by tier 2 (denominator includes wordlist/null-produced slots). T46 should label these columns accordingly for the slot-level views.
- compare() keeps the T0 stub signature (two GroupAggregate values) rather than the plan prose's (two group-name strings); consistent with the T4/T20 precedent. T46 resolves names via aggregation.groups.find before calling compare.

## T41 Inference log report

**Deviations:**
- InferenceReport gained two fields beyond the T0 stub (skippedLines, clueUnderstoodDefaulted) plus two new exported helpers (InferenceLogReader/readInferenceLog/loadInferenceReport) not named verbatim in the stub. inference.ts is fully owned by T41 (not a frozen contract file), and both additions are additive and required to satisfy the task block's own acceptance criteria (skippedLines, acceptance 7) and the orchestrator's task-specific note (clue_understood-defaulted count) - no frozen file ...
- clueUnderstoodDefaulted is a documented proxy (parsed.clue_understood === 0), not an exact count: the frozen src/llm/types.ts InferenceLogRecord has no field carrying the parser's 'defaulted' warning (that lives only in llm/parser.ts's in-memory ParseOutcome.warnings, which T11 never threads into the persisted log record). Implementing the closest correct thing from data actually available in the log, as instructed; a true fix would need a new optional field on InferenceLogRecord, which is ou...

**Notes for later waves:**
- T46 (CLI report --inference) should call loadInferenceReport(reader, filters) with an InferenceLogReader that globs `logs/inference/*.jsonl` (via resolveInferenceLogDir from src/util/fs.ts) and reads each file synchronously; aggregateInference itself stays pure/sync over an already-read record array if a caller prefers to manage reads separately.
- If a later task wants an exact (non-heuristic) count of parser-defaulted clue_understood values, it would need to add an optional field to InferenceLogRecord in src/llm/types.ts (frozen; T41 could not do this) and have the code that builds InferenceLogRecord from ParseOutcome.warnings (likely T33/T34's territory) populate it. Until then, clueUnderstoodDefaulted in InferenceReport is a documented proxy (clue_understood === 0), not a true defaulted-flag count.
- callsPerModelPerDay/usdPerDay/parseFailureRate are all deterministically sorted (by day then model, or by model) so report output and test assertions are stable regardless of input record order.
- InferenceLogReader is `() => ReadonlyArray<{ path: string; text: string }>` - a simple synchronous injection seam. A real CLI implementation reading many/large daily files may want an async variant; T41 kept it sync to match the sync JSON-line parsing style used elsewhere (e.g. src/render/replay.ts) and because tests need no I/O.

**Reviewer notes:**
- For T46 (CLI wiring): passesFilters compares utcDateOf(ts) against filters.since/until as plain strings, so the CLI must normalise --since/--until to exactly 'YYYY-MM-DD' before calling; an ISO timestamp such as '2026-01-02T00:00:00Z' would exclude that day from --since (string compare) and a non-zero-padded date would misorder. The spec says `--since <date>`, so this is a CLI-side normalisation responsibility, not a defect here.
- Hardening idea, out of T41 scope: utcDateOf calls new Date(ts).toISOString(), which throws RangeError('Invalid time value') on a JSON-valid record with an unparseable ts, aborting the whole aggregation. T10 always writes a valid ISO ts so this cannot arise from real logs; if a later wave wants malformed-record tolerance (as opposed to malformed-line tolerance), count such records alongside skippedLines instead.
- InferenceReport gained skippedLines and clueUnderstoodDefaulted beyond the T0 stub. Both are additive on a file T41 owns outright (not a frozen contract file); T46 will see them as extra fields to print and should decide whether to surface clueUnderstoodDefaulted given it is a proxy (a model that genuinely reports clue_understood 0 is indistinguishable from a parser default).

## T29 xw fetch handler

**Deviations:**
- No file-scope deviations (only src/cli/fetch.ts and test/unit/cli/fetch.test.ts were touched, as Owned). Found-but-not-fixed contract gap: schemas/puzzle.schema.json and schemas/puzzle-index.schema.json's parsedBy enum lists only '@xwordly/xword-parser', 'xd-crossword-tools' and 'guardian-json' - 'xd-hand' is missing, even though src/puzzle/types.ts's ParsedBy union already includes it (added by T25 under its own pre-authorisation) and src/puzzle/adapters/xd.ts unconditionally produces 'xd-ha...
- Guardian-fetched puzzles will normalise with style: 'unknown' rather than the series-derived 'cryptic'/'quick', because the generic dispatch path this task is directed to use (puzzle/loader.ts's loadPuzzleWithSolution -> PuzzleAdapterContext, which has no style field) is a different, less-informed path than src/sources/guardian.ts's own normalise() hook (which does compute the correct style from the series but is explicitly not meant to be called, per T22/T28's own code comments and the task-...

**Notes for later waves:**
- Style loss for Guardian fetches: `xw fetch guardian --series cryptic ...` will index/print style 'unknown', not 'cryptic'/'quick', because T29 (per its binding orchestrator note) parses every ref through puzzle/loader.ts's extension dispatch rather than through src/sources/guardian.ts's own normalise() hook (which does know the series-derived style). Fixing this cleanly would mean adding an optional `style` field to `PuzzleAdapterContext` in src/puzzle/adapters/index.ts (plan.md says 'no late...
- Blocking bug for real `xw fetch xd`: schemas/puzzle.schema.json and schemas/puzzle-index.schema.json's `parsedBy` enum omits 'xd-hand', but src/puzzle/adapters/xd.ts always emits it, so every real `xw fetch xd ...` invocation will throw a schema-validation Error out of writeNormalised/upsertIndexRow. Needs a one-line enum fix in both JSON schema files (frozen for T29). This did not surface in T21's or T25's own test suites because neither exercises the two together end-to-end.
- For any source whose puzzle ext is 'json' (guardian, or the file source importing a local/remote .json), the 'original' file and the normalised file share the exact same path (puzzles/<source>/<id>.json) per the literal path scheme in T29's deliverable text, so the normalised write silently supersedes the original raw bytes on disk once parsing succeeds (only on a parse *failure* does the original survive distinctly). This matches the deliverable's specified paths exactly and both index.files...
- T29's own tests never exercise the real guardian/xd/file source adapters end-to-end (per its acceptance criteria, which specify a stub adapter) - the first place a real end-to-end `xw fetch <source>` gets exercised is presumably wave 3/4 integration tests or manual verification; that is where the two issues above will actually surface as failures.

**Reviewer notes:**
- CONTRACT GAP (outside T29 Owns, inherent in the B16/B34 layout): src/sources/guardian.ts line 230 sets ext: 'json', so for the guardian source the original lands at puzzles/guardian/<id>.json and writeNormalised then writes the normalised file to the identical path, overwriting the raw Guardian payload. The index row records files.original === files.normalised (the acceptance-1 test even asserts this for the .json stub ref). T29 followed the plan's fixed layout literally, so this is not a T29...
- Non-blocking: because commander always supplies --out (default 'puzzles/'), resolvePuzzlesDir({ flag: opts.out }) means $CROSSWORD_PUZZLES_DIR and any config puzzlesDir are never consulted by fetch, while list/show (no --out flag) will consult them. A user relying on the env var would fetch into ./puzzles but list from elsewhere. The builder documented this in the fetchCommand docblock; the spec's CLI reference does not require env precedence for fetch, so it is consistent with the contract a...

## T38 Search hooks: re-ask, escalation, budget

**Deviations:**
- None. No contract change was needed: the fix is entirely inside src/solver/hooks.ts, and the T18 trigger-4 proxy and T19 ChargeableBudgetCap/checkWallClock shapes are used as wave 1 left them.

**Notes for later waves:**
- T38: a crossed cap gates the hooks' *spending* only for the run-global spend caps (usd, tokens, wallMs). The phase-scoped counters (backtracks for search, repairCalls for repair) are reported as budget:hit and returned from chargeBudget, but the owning loop is responsible for ending its own phase on them - T37's search already does this via budgetExceeded. T42 (repair) must do the same for repairCalls rather than expecting the hooks to stop themselves.
- T38: once a run-global spend cap is crossed, decide() is still consulted on every hook call (it is pure and free); only execution is refused. At 'at-termination' that refusal is reported as give-up and calls domains.markSuspect, so after a budget-exhausted run every still-empty slot is suspect. T42/T44 consuming isSuspect should expect suspect marks from three sources now: an AC-3 wipeout (T36), a policy give-up, and a budget-exhausted termination pass.
- T44: hooks.chargeBudget('wallMs', n) is an observation, not a charge (T19 excludes wallMs from ChargeableBudgetCap) and, like every T19 evaluation, can return any run-global cap - not just the one charged. The search loop must handle any BudgetCap in the return value.
- T38 keeps its own tier2CallsUsed in step with budget.snapshot().tier2Calls, because T18 reads ctx.tier2CallsUsed while T19 tracks spent.tier2Calls; any later caller that charges tier2Calls outside these hooks would desynchronise the two views.

**Reviewer notes:**
- Acceptance walk (all PASS, evidence in /Users/ben/Projects/crossword-agent/.claude/worktrees/wf_1f426c8a-c24-68/test/unit/solver/hooks.test.ts): 1 're-asks once for a pattern with a fixed letter, merges and emits slot:reask' (asserts purpose reask, one request, merged domain, one slot:reask, action reask); 2 'does not re-ask twice for the same pattern and reports no executed action' (one request, second returns none); 3 'never re-asks for an all-? pattern' (zero requests); 4 'makes no call fo...
- Decisions baked in spot-checked in src/solver/hooks.ts: per-slot state is a plain Map<string, SlotState> created per createSearchHooks call (lines 103-119, 153); decide is consulted again after every runReask/runEscalate return via the loop's continue (lines 419-463); give-up calls markGivenUp (gaveUp flag + domains.markSuspect) and a given-up slot short-circuits to give-up on any later hook call (lines 374-377, 412-414); escalate requests carry crossingContext (clue, fill, confidence) and th...
- The orchestrator note references a 'wave 1 notes file' with T4, T18 and T19 sections; no such file exists in the worktree or the main project (only docs/plan.md matches). I reviewed src/policy/escalation.ts, src/policy/budget.ts and src/grid/domainStore.ts directly instead, which are the authoritative contracts anyway. The builder honoured them: charge() is only ever called with a ChargeableBudgetCap (wallMs goes to checkWallClock, hooks.ts line 499), tier2CallsUsed and spent.tier2Calls are i...
- Cross-module observation for T44/T18, not a T38 defect: T18's trigger 5 fires only when ctx.domainSize === 0 at termination. src/solver/search.ts restores its best partial fill (unwinding trailed reductions) before calling onSearchTermination, so a still-unassigned slot can arrive with a non-empty live domain; decide then returns none and no last-resort tier-2 call is made for that slot. If the intent of 'still empty' is 'still unfilled', either T18 should treat at-termination as trigger 5 re...
