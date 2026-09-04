# Wave 5 build notes

Compilation of builder, reviewer, and merge results from the wave 5 build workflow (workflow wf_4a3c3dba-58b), covering T56, T57 and T58.

## Summary

| id | reviews | fix rounds | merged |
|---|---|---|---|
| T56 | 2 | 1 | yes |
| T57 | 1 | 0 | yes |
| T58 | 1 | 0 | yes |

## T56: Remove real puzzles; synthetic-only fixtures

Deviations:
- bounds.json: scripts/fixtures-refresh.ts merges new measurements into whatever bounds.json already has on disk rather than replacing it wholesale, so after narrowing FIXTURES to the two synthetic entries and running FIXTURES_REFRESH_OFFLINE_ONLY=1, the four stale nyt-* entries remained; hand-edited bounds.json afterward to drop them, since the script (owned jointly with earlier tasks, not to be re...
- test/unit/puzzle/fixtures.test.ts's puzzles/-tracking check uses a filesystem walk instead of invoking the git binary: src/util/git.ts's own doc comment records that the container this suite runs in has no git binary at all, so `git ls-files` cannot be called from a test that must pass under ./scripts/preflight-docker.sh. The filesystem check (nothing exists under puzzles/) is the environment-safe...

Notes for later waves:
- T57 (docs follow-ups) can cite this commit for its 'Puzzles are never committed' README paragraph and the A3/B47 decisions-log update; no real puzzle content remains anywhere in the tracked tree.
- The synthetic cache still replays with offlineMode 'lenient' for both fixtures (never strict) - unchanged by this task, and exactly the gap T58 (reasoning-off for every tier-1 call) is scoped to close. When T58 refreshes the cache, it should re-run through the same FIXTURES array in scripts/fixtures-refresh.ts (now synthetic-only) and can drop the offlineMode:'lenient' fallback if strict replay st...
- test/fixtures/cache/ now holds 35 entries (down from 386), well under the 20 MB budget test/integration/solve.test.ts asserts.
- fixtures.test.ts's acceptance-1 checks are now: puzzles/fixtures/ absent on disk, and .gitignore has puzzles/** with no !puzzles re-include line. If a future task changes how puzzle fixtures are organized or renames the .gitignore ignore pattern, this test will need updating in lockstep.

Review findings that were fixed:
- /Users/ben/Projects/crossword-agent/.claude/worktrees/wf_4a3c3dba-58b-1/test/unit/puzzle/fixtures.test.ts:76-80 - the 'acceptance 1' test asserts that puzzles/ contains no files at all on disk, but puzzles/<source>/ is exactly where `xw fetch` writes locally fetched (gitignored, never committed) puzzles (src/util/fs.ts:79 default 'puzzles', src/cli/fetch.ts:104, docs/spec.md:194/482, README.md:59)...

Reviewer notes:
- Acceptance walk: 1 PASS - `git ls-files puzzles` prints nothing; puzzles/fixtures/ and its four nyt-*.xd + FIXTURES.md are deleted in commit 394ffbe; test/unit/puzzle/fixtures.test.ts asserts puzzles/fixtures/ is absent and .gitignore has `puzzles/**` with no `!puzzles` re-include. 2 PASS - tracked cache entries 386 (main) -> 35 (HEAD); `grep -rl "Agog\|Senor\|1625" test/fixtures/` prints nothing...
- Independent prune verification: I wrote a scratchpad script that loads the 34 slots of synthetic-5x5 + synthetic-7x7 (clue|length) and checked every file under test/fixtures/cache/: 35 files, 35 matching, 0 non-matching. The prune is exact as the Decisions require.
- Ownership: `git diff --name-only main...HEAD` = .gitignore (pre-authorised; only the two re-include lines and their comment removed), scripts/fixtures-refresh.ts, sets/mixed-30.json, test/fixtures/runs/bounds.json, test/fixtures/runs/snapshots/synthetic-{5x5,7x7}.json, test/integration/solve.test.ts, test/unit/puzzle/fixtures.test.ts, plus deletions of puzzles/fixtures/**, 351 cache entries and 4...
- Hygiene: no `any` types added (only the word in comments); non-ASCII appears only on deleted lines of the removed real-puzzle fixtures and cache entries, none on added lines; commit messages carry no attribution/Co-Authored-By/Claude-Session lines; no notImplemented() in touched modules; sets/mixed-30.json keeps 30 entries, 20 american / 10 cryptic, 30 unique ids.
- Snapshot regeneration: the synthetic snapshots changed only in runId/timestamp/wallMs (the offline replay against the pruned cache reproduced identical accuracy and per-slot fills), which is the expected outcome and confirms the pruned cache is complete for the synthetic fixtures.
- Stale comment (non-blocking, .gitignore is frozen beyond the pre-authorised removal): the surviving .gitignore line `# Fetched puzzles are never committed (B46); the fixtures are.` now ends with a false clause since no fixtures live under puzzles/ any more. A later docs/config task could reword it to `# Puzzles are never committed (no-distribution policy).`
- Stale comments in test/integration/smoke.test.ts (in Owns, non-blocking): the module doc still says `every one of T50's 386 committed cache entries` (now 35) and refers to `the four puzzles/fixtures/*.xd puzzles the task text names`. Only prose, no nyt-* id is referenced, so no behaviour impact; T58 (which touches the cache again) could refresh the count.
- T57 is expected to record in docs that the no-distribution policy supersedes A3/B47; several comments in this branch already point at a 'dated addendum' in docs/decisions/2026-09-03-spec-review.md that T57 has not yet written.
- Aggregate run-record fixtures under test/fixtures/runs/aggregate/ (T52) contain only placeholder clue text (`Clue for 1A` etc.) and synthetic ids p1/p2/p3/rx/ry; nothing derived from real puzzles.

## T57: Documentation follow-ups and sets contract test

Deviations:
- Edited three docs/spec.md lines outside the strictly pre-authorised Decisions-log/Testing-section/touch-ups-note scope (Repository layout ASCII tree, Data model 'Committed:' bullet, Milestones M1 bullet) to strip remaining stale FIXTURES.md references. Reason: acceptance criterion 4 requires `grep -n "not renewed|FIXTURES.md" README.md docs/spec.md` to print nothing across the whole of both files,...

Notes for later waves:
- docs/spec.md's Testing section still claims integration tests 'cover baseline, no-repair and tier1-only', but test/integration/solve.test.ts (post-T56) only exercises the baseline profile (FixtureBound.profile is a literal 'baseline' type). This predates T56 and is not one of the five touch-ups this task's Deliverable named, so it was left untouched; a future docs task should either restore the ot...
- docs/spec.md line ~590 in the Candidate service section still literally reads 'rate.limited'/'rate.adjusted' (dot); the new 'Spec touch-ups recorded' note in the Testing section documents that these are actually emitted as rate:limited/rate:adjusted (colon), but the original sentence at line 590 was left as-is since fixing it was outside this task's Owns scope (only Decisions-log rows, Testing fix...
- Same pattern for the other four touch-ups noted (zod .prefault(), widened SolveDeps/SolveResult, tsconfig.check.json for typecheck, scorer taking the solution as an argument): each is now recorded once in the new 'Spec touch-ups recorded' paragraph, but the original sections they contradict (Candidate service, solver types prose, Stack/CI npm-scripts prose, Solver pipeline step 8) were left unedit...

Reviewer notes:
- Acceptance 1 PASS: README.md gains 'Puzzles are never committed.' paragraph under 'Puzzle data and sources' (lines 59-67) and a new '## Manual pre-release check' section (lines 112-130) documenting `docker compose up -d` then `sh scripts/smoke-container.sh`; the section's claims (CI `image` job only runs `docker compose build`, script prints `smoke-container: OK`, uses `docker exec` against `cross...
- Acceptance 2 PASS: test/contract/sets.test.ts passes in preflight (8 tests). Negative case independently reproduced without editing the worktree: bind-mounted a scratchpad copy of sets/mixed-30.json with `extra: 'x'` on entry 3 over /app/sets/mixed-30.json in the preflight image and ran `npx vitest run test/contract/sets.test.ts`; 'has only id and stratum keys on every entry' failed with `expected...
- Acceptance 3 PASS: preflight exit 0 (see preflightSummary).
- Acceptance 4 PASS: `grep -n "not renewed\|FIXTURES.md" README.md docs/spec.md` prints nothing (grep exit 1). On main the string appeared at README.md:61 and docs/spec.md:167, 195, 1059, 1086.
- Ownership: `git diff --name-only main...HEAD` = README.md, docs/benches/README.md, docs/decisions/2026-09-03-spec-review.md, docs/spec.md, test/contract/sets.test.ts. No merge commits on the branch; own-commit file list is identical. No .env, no frozen-file edit beyond the pre-authorised set. Merge-tree exits 0 (tree e294aae0).
- Builder's declared deviation accepted: three docs/spec.md lines outside the Decisions-log/Testing/touch-ups windows (Repository layout line 167, Data model 'Committed' bullet line 195, Milestones M1 line 1086) were changed only to drop stale FIXTURES.md / puzzles/fixtures references. Those lines carried the string on main, so acceptance criterion 4 (whole-file grep) could not be met without touchi...
- Hygiene: no `any` in sets.test.ts (the only hit is the English word 'any' in a comment); no non-ASCII in branch commits; both commit messages are attribution-free; the test file has no notImplemented(); decisions-record edit is append-only (a new '## Addenda' heading and one dated addendum after the last existing line).
- Spec touch-ups note verified against code: src/events/types.ts emits 'rate:limited'/'rate:adjusted' (docs/spec.md line 590 still says the dot form, recorded rather than rewritten, by design); src/profiles/schema.ts uses .prefault({}) for nested groups; package.json typecheck is `tsc --noEmit -p tsconfig.check.json` and the file exists; src/solver/solve.ts widens SolveDeps with puzzle?/now?/costs?...
- Non-blocking for a later wave: .gitignore line 15 comment still reads 'Fetched puzzles are never committed (B46); the fixtures are.' which is stale after T56 (the addendum correctly says puzzles/ is ignored unconditionally). .gitignore is frozen and not in T57's Owns, so it was correctly left alone.
- Non-blocking: REAL_PUBLISHER_PREFIXES in test/contract/sets.test.ts is just ['nyt-']. The task wording ('a real-publisher prefix like nyt-') is satisfied, but a later wave may want to widen it (e.g. 'lat-', 'wsj-', 'usa-', 'guardian-') once the set is populated with real fetched ids, and/or assert ids match the placeholder pattern until then.
- Non-blocking: minor comment typo in test/contract/sets.test.ts line 41, 'A real-publisher id prefix look like' should read 'prefixes look like'.
- Non-blocking: the Testing section now mentions `--offline-lenient` and bounds.json currently records offlineMode 'lenient' for both synthetic fixtures; T58 intends to move both to strict, after which the parenthetical in docs/spec.md's Integration tests paragraph will be true-but-vacuous. Nothing to change now.

## T58: Reasoning-off for every tier-1 call; refresh cache

Deviations:
- Tier 2 keeps B41's original seed-only gate rather than switching to always-on: the task's Deliverable is scoped to 'every tier-1 call', tier 2 is the escalation model reached only for clues tier 1 could not settle, and nothing has been measured there. Documented in the router and the spike addendum.
- docs/spec.md 'Candidate service' step 2 still says the parameter is sent 'when the model advertises reasoning and the purpose is seed', which is now true of tier 2 only. docs/** is frozen for this task, so the wording is left alone and the conflict is recorded in the spike doc's 'Spec conflict' subsection.
- The refresh reused the already-committed cache rather than wiping it first (the plan's 'old entries are simply overwritten on refresh'), so the 34 seed asks were cache hits and only the previously-unparseable non-seed keys were bought. The reasoning parameter is not a cache-key field, so those seed entries still key-match exactly; the effect is that seed responses in the committed cache date from...

Notes for later waves:
- scripts/fixtures-refresh.ts and test/integration/solve.test.ts module doc comments are now stale: both explain at length why strict --offline cannot converge and why --offline-lenient is the fallback, citing the tier-1 reasoning gap this task closed. Both fixtures now capture and replay strict. Those files belong to T50/T56, not T58, so the comments were left untouched; whoever owns them next shou...
- docs/spec.md 'Candidate service' step 2 needs one sentence changed to say the reasoning-off parameter goes on every tier-1 call and on tier-2 seed calls. T57 is the wave-5 task that owns spec rows.
- synthetic-5x5 is no longer a perfect fixture: measuredLetters 0.9545, measuredWords 0.8182, minLetters 0.9045, perfect false. The wrong fill is a scoring/selection outcome (truth present at truthRank 2 and 0 for the two affected slots), which is the question M6's calibration fitting (T53) is meant to answer. Any bench comparing profiles on this fixture should expect the non-perfect baseline.
- The repair pass accepted MAVOC, which is not in test/fixtures/wordlist.txt; worth a look by whoever next touches src/solver/repair.ts's plausibility gate, since the gate was expected to reject it.

Reviewer notes:
- Acceptance 1 PASS: test/unit/llm/tierRouter.test.ts 'route: reasoning-off parameter (B41 as amended by T58)' loops all six Purpose values (seed, reask, repair, escalate, smoke, calibrate) on tier 1 against supportsReasoning true (expects reasoning_effort: none) and false (expects extra undefined), plus tier-2 seed (sent) and tier-2 escalate/repair (not sent).
- Acceptance 2 PASS: test/fixtures/runs/bounds.json has offlineMode "strict" for synthetic-5x5 and synthetic-7x7; test/integration/solve.test.ts runs each fixture with bound.offlineMode (offline: true, offlineLenient: false) and passed in preflight and in my own --network none container run.
- Acceptance 3 PASS: preflight exit 0. Note scripts/preflight-docker.sh itself does not pass --network none; in-test network isolation is the vi.stubGlobal('fetch') throw in solve.test.ts. I verified separately with --network none.
- Acceptance 4 PASS: docs/spikes/tier1-reliability.md gained a purely additive '## 2026-09-04 follow-up (T58)' section with before (5/2039 repair, 0/74 reask parsed) and after (57/57 parsed, reasoningTokens 0, USD 0.0049) figures and the strict-replay result.
- Ownership clean: diff is src/llm/tierRouter.ts, test/unit/llm/tierRouter.test.ts, test/fixtures/cache/**, test/fixtures/runs/bounds.json + snapshots, and the append-only spike doc section (pre-authorised). No frozen files, no .env in history or worktree, src/candidates untouched, cache key fields unchanged. merge-tree exits 0, no merge commits, no non-ASCII, no attribution lines, no `any`, no notI...
- Committed cache composition: 57 constrained entries from 2026-09-04 with reasoningTokens 0, 34 seed entries from 2026-09-03 (reasoningTokens 0, T50 run), and 1 constrained entry from 2026-09-03 with reasoningTokens 512 (one of T50's five reasoning-on repair records that happened to parse). All key-match since the parameter is not a key field, but a future wipe-and-refresh would make the cache unif...
- docs/spec.md 'Candidate service' step 2 still describes the seed-only gate (line 518); now true of tier 2 only. Needs a docs-owning task to reword (builder recorded this in the spike addendum).
- synthetic-5x5 accuracy fell to letters 0.9545 / words 0.8182 (1A OM / 2D MAVOC chosen over OH / HAVOC with truth still in candidates). Honestly measured and bound set to measured minus 0.05; this is a scoring/selection question for calibration work, not a transport defect.
- Snapshot run records show calls.tier1.count 0 and cacheHits 0 under offline replay (same on main); if a later wave wants offline runs to report cache hits, the run recorder is where to look.

## Merge sequence

- T56 merged first: T56 merged cleanly (no-ff, no conflicts). No attribution lines were present in the branch's commit messages, and .env was not in the diff, so no rewrite was needed. Preflight (docker build + lint + typecheck + vitest) passed: 59 test files, 923 tests passed, 1 skipped. Updated docs/plan.md Status table with row "| T56 | done | e8eb7e9 | wave 5 |" (e8eb7e9 = merge commit short hash) and committed a...
- T57 merged second: T57 merged cleanly (merge commit d6fb7a1). No attribution lines found in branch commits; no .env in diff, so no rewrite needed. Preflight (lint, typecheck, vitest) passed: 60 test files, 931 tests passed, 1 skipped. Status table in docs/plan.md updated with "| T57 | done | d6fb7a1 | wave 5 |" and committed as 09555f7. Pushed to origin/main (b992076..09555f7). Worktree removed, branch task/T57-docu...
- T58 merged third: T58 merged cleanly with --no-ff (merge commit b89dbfa), no attribution lines found in the branch's commit bodies, no .env in the diff. Preflight passed in Docker: lint, typecheck, and vitest all green (60 test files, 942 passed, 1 skipped). Status row appended to docs/plan.md ("| T58 | done | b89dbfa | wave 5 |") and committed as 7aca65b. Pushed to origin/main (09555f7..7aca65b). Cleanup: worktree...

