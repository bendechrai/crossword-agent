# Benchmark results

This directory holds committed benchmark reports, produced by `xw report --md` after each bench run.

`sets/modern-12.json` (2024 LA Times dailies plus current Guardian cryptics; see
[SETS.md](./SETS.md) for the exact fetch recipe) is the standard bench set for
tuning going forward, superseding `sets/mixed-12.json` for new work. The
escalation-policy result below predates the constrained-re-ask and prompt
fixes in T62/T63 - it was run on `mixed-12.json` against a promptVersion-1,
pre-T62 solver - and is kept in place as the historical baseline rather than
rerun or rewritten; a fresh run against `modern-12.json` is future work.
docs/benches/era-test.md tests how much of that low accuracy is era mismatch
(pre-1965 puzzles vs. 2024 ones) rather than a solver defect, on the same
pre-T62/T63 code.

Both benches below are run again in M6 (v1.1) with the repair pass enabled,
because a policy that looks worse before repair may be the one repair rescues
best (docs/spec.md, "Strategy profiles"). The results recorded here through
M5 are pre-repair; a repeat run's results are recorded alongside them, not in
place of them, so the two are always comparable.

## Escalation-policy bench

**Command:**
```
xw bench sets/mixed-30.json --profiles baseline,eager-escalation,patient
xw report --by profile --compare baseline,eager-escalation,patient --md
xw report --by stratum --compare baseline,eager-escalation,patient --md
```

**Metrics:** Perfect-puzzle rate, mean USD per puzzle and USD per correct word (all on `usdCounterfactual`).

**Decision rule (american stratum only):** Pick the profile with the highest perfect-puzzle rate on the american stratum. If the winner's USD per correct word exceeds the best alternative by more than a factor of 1.5, pick the alternative instead. Report the cryptic stratum and letter-accuracy delta alongside, but do not make decisions on either.

**Results:**
See `docs/benches/escalation-policy.md`. The canonical result (bench run 2026-09-04, `sets/modern-12.json`, post T62/T63, commit `f9d3b0b1d9b0cb07bacc5053cee0c9550f10cbfd`) again tied all three profiles at a 0.0000 perfect-puzzle rate on the american stratum, so the rule's cost tie-break decided; `patient` came out marginally cheapest per correct word, but by under 1.1% over the other two, an even tighter margin than the historical mixed-12 run and not a decisive one. A paired before/after comparison on the eight LA Times puzzles against the pre-T62/T63 era-test baseline found a real slot-level regression (612 slots, 103 regressions vs 67 gains, McNemar p about 0.006) attributed mainly to T63's length self-prune cutting candidate volume; whether to roll back that half of T63 is recorded in the same document as a pending decision. A follow-up paired measurement (bench run 2026-09-05, same set, commit `e66bf2c4c9da7974126e8e1594b7aba191a3d6f5`, `--repeat 3`) tested that rollback (promptVersion 3, self-prune removed) directly against promptVersion 2 (self-prune present) and found the opposite of the prediction: v2 beats v3 on letters, words, truth-in-candidates, conversion and both tiers' fill correctness (perfect-puzzle rate is tied at zero), by a margin that clears the within-config noise floor with a 95% CI excluding zero on both the american stratum and all 12 puzzles, so the earlier self-prune attribution does not hold and the default should revert to promptVersion 2 pending further isolation of the remaining gap to the pre-T62/T63 level. The historical mixed-12 result (bench run 2026-09-04, `sets/mixed-12.json`, pre T62/T63) is kept in the same document for comparison: it also tied at 0.0000 perfect-puzzle rate with `patient` marginally cheapest, by under 4%. A superseded first pass (run before the word list was loaded and before cache hits were priced counterfactually) is recorded in the same document as well.

## Batch-size bench

**Command:**
```
xw bench sets/mixed-30.json --profiles batch1,batch2,batch3,batch5,batch8
xw report --by batchIndex --compare batch1,batch2,batch3,batch5,batch8 --md
```

**Metrics (per clue):** Truth-in-top-k recall (k = candidatesPerAsk), top-1 accuracy, length-error rate, parse-failure rate, latency, USD per clue, and accuracy by `batchIndex` to detect positional drop-off. Also downstream letter, word and perfect-puzzle accuracy.

**Decision rule (american stratum only):** Pick the largest batch size whose top-k recall is within 2 percentage points of `batch1` and whose positional accuracy shows no monotonic decline across positions. If no batch size satisfies both, stay at 1.

**Results:**
(To be filled by a bench run)

## Seed-only candidate recall screen

A model screen, not a bench: it takes the solver out of the loop entirely and
measures only whether a model's seed pass even offers the right answer. For
every slot of every puzzle in the set it makes exactly one tier-1 ask with the
empty pattern - no AC-3, no search, no re-ask, no escalation, no repair, and
nothing is ever assigned to a grid - once per model. Each model runs as the
tier-1 slot of a synthetic profile derived from `baseline`, so the router
applies that model's own advertised capabilities (reasoning-off where the
catalogue advertises `reasoning`, `response_format` where it advertises
`structured_outputs`) and the B23 cache keys and inference-log `purpose` are
byte for byte the ones a real solve's seed pass would use. A screen run
therefore warms the cache a later bench run reads, and a re-run of the screen
costs nothing.

**Command** (`package.json` is frozen after T0, so the screen has no npm
alias and runs directly under `tsx` inside the container):
```
docker exec -it crossword-solver npx tsx scripts/eval-recall.ts \
  --set sets/modern-12.json --models a,b,c [--repeat 1] [--max-usd 10] [--out logs/recall]
```

It prints a pre-flight estimate (slots x models x repeats x an assumed
tokens-per-call, priced from `models.json`) and refuses to start above
`--max-usd` without `--yes`, exactly as `xw bench` does. Models run one after
another so the process-wide per-model rate limiter is never shared between
two models at once; puzzles inside a model run at concurrency 2, the same as
bench. Per-slot results land in `<out>/<model-slug>/<puzzle>--r<repeat>.json`
and the aggregate in `<out>/summary.md` and `<out>/summary.json`. `logs/` is
gitignored: only aggregate numbers are ever committed, in this file.

**Metrics (per model, and again split by stratum):** slots, truth-in-candidates
share (the truth was among the accepted candidates), top-1 share (it was the
top accepted candidate), mean candidates seen, length-error share of
rejections, parse-failure rate, zero-candidate share (slots the seed pass left
with an empty domain), mean latency over the calls that reached the provider,
and USD per puzzle on `usdCounterfactual` (B2). The definitions are the ones
the escalation-policy decomposition uses, so a screen row and the
"Generation" paragraph of `docs/benches/escalation-policy.md` are directly
comparable.

**Decision rule (american stratum only):** rank models by truth-in-candidates
share on the american stratum, then by USD per puzzle. Carry the top three,
plus the current tier-1 model, into the puzzle-level bench. Report the cryptic
stratum alongside but do not decide on it - it is the smaller half of every
set and the hardest for generation, so it moves the ranking on noise. A model
the set gave no american slots cannot be ranked by this rule and sorts after
every model that can be.

**Results:**
(To be filled by a screen run)
