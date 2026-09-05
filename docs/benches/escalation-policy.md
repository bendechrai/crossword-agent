# Canonical result on modern-12 with the Flash pair (2026-09-05, three repeats)

Date: 2026-09-05
Commit: 53417b192c3b3d7baea2301b224473e08259a4db (main)

## Environment

- Commit `53417b192c3b3d7baea2301b224473e08259a4db` (main), which includes
  T69 (swap the tier-1 default to `deepseek-ai/DeepSeek-V4-Flash-0731` per
  the puzzle-level model comparison, docs/benches/model-comparison.md) -
  confirmed in-container:
  `docker exec crossword-solver sh -c 'grep -n "DeepSeek-V4-Flash" src/profiles/schema.ts | head -2'`
  prints the `tier1: z.string().default('deepseek-ai/DeepSeek-V4-Flash-0731')`
  line.
- Model pair: tier 1 `deepseek-ai/DeepSeek-V4-Flash-0731`, tier 2
  `deepseek-ai/DeepSeek-V4-Pro` (the tier-2 model is unchanged from every
  earlier result in this document). Confirmed from every run record's
  `models` field, and from `profile.promptVersion`, all 108 of which read
  `"2"` - all three built-in profiles (`baseline`, `eager-escalation`,
  `patient`) carry `promptVersion: PAIRED_PROMPT_VERSION` explicitly
  (`src/profiles/builtins.ts`), independent of the module-level
  `PROMPT_VERSION` default (which is `"3"` after T65/T66; only the
  `baseline-pv3` built-in uses it).
- Word list loaded: `data/wordlist/collaborative.txt`, 567,657 lines,
  confirmed present in the container before the run
  (`docker exec crossword-solver sh -c 'wc -l /app/data/wordlist/collaborative.txt'`).
- Candidate cache: warm for tier 1 and mostly warm for tier 2 going into
  this run. The model comparison bench (docs/benches/model-comparison.md,
  same day, same set, same tier-1/tier-2 models, same promptVersion 2) had
  already primed the cache for the `flash-tier1` arm on all 12 puzzles.
  `baseline` (identical model pair, escalation policy `reask-first`, the
  same shape of ask as that arm) inherited nearly all of it: tier-1
  3492/3530 calls were cache hits (98.9%), tier-2 239/249 (96.0%).
  `eager-escalation` and `patient` diverge from `baseline`'s ask pattern
  (different escalation timing means different tier-2 prompts), so their
  cache hit rates are lower, especially on tier 2: `eager-escalation`
  tier-1 3244/3261 (99.5%), tier-2 240/385 (62.3%); `patient` tier-1
  3363/3506 (95.9%), tier-2 178/205 (86.8%).

## Command, pre-flight estimate and spend

```
docker exec crossword-solver sh -c 'nohup xw bench sets/modern-12.json --profiles baseline,eager-escalation,patient --repeat 3 --max-usd 10 --concurrency 2 > /app/logs/bench-escalation-flash.log 2>&1 &'
```

Pre-flight estimate:

```
estimate: 108 runs (12 puzzles x 3 profiles x 3 repeats) ~ $2.160000 (--max-usd 10.000000)
```

The run finished well under the $10 ceiling. Total spend across the 108
records: $0.421211 `usdBilled` / $3.004428 `usdCounterfactual` (about 30%
of the ceiling on the counterfactual basis, per B2's cost-accounting rule
of always deciding on `usdCounterfactual`). Per profile:

| profile | usd billed | usd counterfactual |
| --- | --- | --- |
| baseline | 0.030023 | 0.948303 |
| eager-escalation | 0.311167 | 1.201640 |
| patient | 0.080021 | 0.854485 |

Billed spend is far below counterfactual across the board because most
tier-1 calls, and most of `baseline`'s and `patient`'s tier-2 calls, were
cache hits (see Environment above); `eager-escalation` billed the most in
real dollars because its escalation timing produced the most tier-2 calls
that missed the cache.

**Wall clock:** 9 minutes 2 seconds (earliest run start, back-computed as
`timestamp - wallMs`, 2026-09-05T22:37:21.378Z; latest run's `timestamp`
2026-09-05T22:46:22.905Z). This is far shorter than every prior bench in
this document series (which ran 9 to 156 minutes) because the cache was
already warm going in.

**Status across the 108 records:** 39 `ok`, 69 `partial`, 0 `error`
(`baseline` 12 ok / 24 partial; `eager-escalation` 14 ok / 22 partial;
`patient` 13 ok / 23 partial). **Budget hits:** none on any of the three
profiles (`budgetHits` is empty for every record).

**Operational detail (mean per puzzle over all three repeats):**

| profile | escalations/puzzle | mean re-asks/slot |
| --- | --- | --- |
| baseline | 6.92 | 0.1233 |
| eager-escalation | 10.69 | 0.0000 |
| patient | 5.69 | 0.1123 |

`eager-escalation`'s zero mean re-asks/slot is exact, not rounded: its
policy escalates on the first low-confidence signal instead of re-asking
tier 1 first, so by construction it never re-asks - the expected sanity
check for that profile, matching the pattern `tier1-only`'s
`0.00 escalations/puzzle` served as in docs/benches/model-comparison.md.

## Results per stratum

`letters`/`words`/`perfect` are `aggregate()`'s means
(`src/eval/aggregate.ts`); `usd/puzzle` and `usd/correct word` both use
`usdCounterfactual`, per B2 and the spec's cost-accounting rule.

### American stratum (8 puzzles, n = 24 per profile)

| profile | letters (sd) | words | perfect | usd/puzzle (cf) | usd/correct word | tier-2 share | mean wall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.8001 (0.1386) | 0.6293 | 0.0000 | 0.026161 | 0.000543 | 0.0505 | 2477 ms |
| eager-escalation | 0.8127 (0.1276) | 0.6425 | 0.0417 | 0.035080 | 0.000713 | 0.0930 | 23758 ms |
| patient | 0.8017 (0.1459) | 0.6398 | 0.0417 | 0.023676 | 0.000484 | 0.0424 | 2893 ms |

Both perfect solves (1 of 24 for `eager-escalation`, 1 of 24 for
`patient`) land on the same puzzle, `xd-lat2024-01-08`, on different
repeats (`eager-escalation` repeat 1, `patient` repeat 2) - see Caveats.

**Per-repeat means (american stratum, n = 8 puzzles per repeat):**

| profile | repeat | letters | words | perfect |
| --- | --- | --- | --- | --- |
| baseline | 0 | 0.8177 | 0.6378 | 0.0000 |
| baseline | 1 | 0.8239 | 0.6511 | 0.0000 |
| baseline | 2 | 0.7586 | 0.5990 | 0.0000 |
| eager-escalation | 0 | 0.8333 | 0.6479 | 0.0000 |
| eager-escalation | 1 | 0.8381 | 0.6739 | 0.1250 |
| eager-escalation | 2 | 0.7666 | 0.6058 | 0.0000 |
| patient | 0 | 0.8245 | 0.6510 | 0.0000 |
| patient | 1 | 0.8192 | 0.6611 | 0.0000 |
| patient | 2 | 0.7613 | 0.6072 | 0.1250 |

### Cryptic stratum (4 puzzles, n = 12 per profile; reported, not decision-relevant)

| profile | letters (sd) | words | perfect | usd/puzzle (cf) | usd/correct word | tier-2 share | mean wall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.1752 (0.0925) | 0.0738 | 0.0000 | 0.026704 | 0.012325 | 0.1172 | 3326 ms |
| eager-escalation | 0.1893 (0.1099) | 0.0848 | 0.0000 | 0.029977 | 0.011991 | 0.1486 | 9462 ms |
| patient | 0.1509 (0.0830) | 0.0624 | 0.0000 | 0.023855 | 0.013012 | 0.0978 | 17685 ms |

### All 12 puzzles (n = 36 per profile)

| profile | letters (sd) | words | perfect | usd/puzzle (cf) | usd/correct word | tier-2 share | mean wall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.5918 (0.3234) | 0.4441 | 0.0000 | 0.026342 | 0.000802 | 0.0659 | 2760 ms |
| eager-escalation | 0.6049 (0.3214) | 0.4566 | 0.0278 | 0.033379 | 0.000993 | 0.1056 | 18992 ms |
| patient | 0.5847 (0.3361) | 0.4473 | 0.0278 | 0.023736 | 0.000714 | 0.0552 | 7823 ms |

These three rows match the `xw bench` printed summary table exactly
(profile / n / letters / words / perfect / usd per puzzle / usd per
correct word).

## Noise floor

Mean, across a stratum's puzzles, of each puzzle's sample standard
deviation of letters accuracy across its three repeats (same puzzle, same
profile, sampling noise only) - same definition used throughout this
document and in docs/benches/model-comparison.md.

| profile | american | cryptic | all 12 |
| --- | --- | --- | --- |
| baseline | 0.0463 | 0.0370 | 0.0432 |
| eager-escalation | 0.0477 | 0.0419 | 0.0458 |
| patient | 0.0505 | 0.0225 | 0.0412 |

`baseline`'s american noise floor (0.0463) reproduces
docs/benches/model-comparison.md's `flash-tier1` figure exactly, as it
should: see the consistency check below.

## Paired comparison on the american stratum (letters accuracy)

Per puzzle, the difference of each profile's repeat-mean letters accuracy
(mean of 3 repeats) minus `baseline`'s repeat-mean on the same puzzle,
then the mean, sample standard deviation, standard error and paired
t-statistic of those 8 per-puzzle differences (df = 7), same method used
throughout this document.

**eager-escalation minus baseline (n = 8 puzzles):** mean diff = +0.0125,
paired sd = 0.0181, paired se = 0.0064, t(7) = 1.961, 95% CI (-0.0026,
0.0277). The CI includes zero. The magnitude (0.0125) is about 27% of
either profile's own noise floor (0.0463, 0.0477) - well inside sampling
noise, not a detectable effect.

Repeat-level win count (of the 24 paired repeats: 8 puzzles x 3 repeats,
matched by repeat index): eager-escalation won 13 of 24, baseline won 2,
tied 9.

**patient minus baseline (n = 8 puzzles):** mean diff = +0.0016, paired sd
= 0.0210, paired se = 0.0074, t(7) = 0.210, 95% CI (-0.0160, 0.0191). The
CI includes zero by a wide margin and the magnitude (0.0016) is about 3-4%
of either profile's noise floor (0.0463, 0.0505) - indistinguishable from
noise.

Repeat-level win count: patient won 5 of 24, baseline won 5, tied 14.

Neither alternative profile shows a letters-accuracy difference from
baseline that clears the noise floor on the american stratum; both 95% CIs
include zero. This is a different outcome from every earlier tier-1-model
paired comparison in this document series (v3-vs-v2, and
docs/benches/model-comparison.md's model-swap arms), all of which had CIs
that excluded zero - here the three escalation policies genuinely perform
about the same on raw letter accuracy with the new tier-1 model.

## Decision rule, quoted verbatim (docs/benches/README.md)

> **Decision rule (american stratum only):** Pick the profile with the
> highest perfect-puzzle rate on the american stratum. If the winner's USD
> per correct word exceeds the best alternative by more than a factor of
> 1.5, pick the alternative instead. Report the cryptic stratum and
> letter-accuracy delta alongside, but do not make decisions on either.

## Applying the rule, step by step

**Step 1 - highest perfect-puzzle rate on the american stratum.**
american-stratum perfect-puzzle rate: baseline 0.0000 (0 of 24),
eager-escalation 0.0417 (1 of 24), patient 0.0417 (1 of 24). This is the
first result in this document series where the american-stratum
perfect-puzzle rate is not a three-way tie at zero: `eager-escalation` and
`patient` each solved one repeat of one puzzle
(`xd-lat2024-01-08`) perfectly. `baseline` is strictly lower and is
eliminated by step 1. `eager-escalation` and `patient` are tied at the
maximum, so step 1 does not produce a unique winner between them - the
same situation the two-way, and previously three-way, ties earlier in this
document faced.

**Step 2 - resolving the tie with the rule's own cost check.** Following
the same convention used for the earlier ties in this document (apply the
rule's cost criterion directly across the tied profiles): USD per correct
word on `usdCounterfactual`, american stratum: patient $0.000484,
eager-escalation $0.000713. patient is cheaper; eager-escalation costs
0.000713 / 0.000484 = 1.4754x patient's price per correct word - just
under the rule's 1.5x override threshold, so this reads as "patient is the
cheaper of the tied pair" rather than as an override of a more-accurate
winner. Applying cost directly to break the tie, as done previously,
**patient** wins.

**The tie-break is order-dependent, and that matters here.** If instead
letters accuracy is used to pick a provisional winner from the tied pair
(eager-escalation 0.8127 > patient 0.8017), then the rule's cost-override
sentence applies literally: does the provisional winner's (eager-escalation's)
cost exceed patient's ("the best alternative") by more than 1.5x? No -
1.4754x is under the threshold, so no override happens and
**eager-escalation** stays the winner under that reading. The rule's text
does not say which profile to treat as "the winner" when step 1 itself is
tied, and the two orderings give two different answers here, with the
deciding ratio (1.4754x) sitting close enough to the 1.5x threshold that a
few hundredths of a cent either way would flip which convention matters.

**Conclusion: not decisive.** `baseline` is excluded either way (its
perfect-puzzle rate is strictly below the tied pair). Between
`eager-escalation` and `patient`, the rule's text is ambiguous about which
tie-break convention to use, and the two conventions give different
winners on a cost ratio (1.4754x) close to the 1.5x threshold that would
resolve it. Read plainly: this run says "either `eager-escalation` or
`patient` is preferable to `baseline`," but does not cleanly decide
between the two. `patient` remains the cheaper of the two per correct word
and per puzzle, and is the pick if forced to choose one; `eager-escalation`
has the best raw accuracy (0.8127 letters, 0.6425 words, both highest of
the three) at nearly 1.5x patient's per-puzzle cost and a noticeably
higher tier-2 share (0.0930 vs 0.0424) and wall time (23758 ms vs 2893 ms).
Neither the perfect-puzzle rate difference (1 of 24 vs 0 of 24) nor the
letters-accuracy differences from baseline are large relative to the noise
floor (see the paired comparison above), so a repeat with more than 3
reps, or a larger puzzle set, would be needed to resolve this tie with any
confidence.

## Consistency check: baseline (this run) versus the flash-tier1 arm of the model comparison

`baseline` here and `flash-tier1` in docs/benches/model-comparison.md are
the same tier-1/tier-2 model pair, same promptVersion (2), same escalation
policy (`reask-first`, `baseline`'s default), and the same 12 puzzles at
3 repeats each - the only difference is that `flash-tier1` ran with a cold
cache (the first puzzle-level run against this model pair) and `baseline`
here ran with the cache that run warmed.

**American stratum: exact match.** All 24 paired (puzzle, repeat) records
have byte-identical `accuracy.letters` (and `words`, `perfect`) values
between the two runs - not merely "within noise," but literally the same
floating-point number in all 24 cases, because a cache hit replays the
same completion the cold run received. Both letters means are
0.8001077875379248, both standard deviations 0.13859241021475122, both
noise floors 0.0463. `usdCounterfactual` differs by a negligible
$0.000030/puzzle (0.026161 here vs 0.026131 there), consistent with
`usdCounterfactual` pricing every call as if cold, independent of whether
it was actually a cache hit.

**Cryptic stratum: small, noise-floor-sized differences.** 9 of 12 paired
records are byte-identical; 3 differ (guardian-cryptic-30100 repeat 0:
0.3765 vs 0.3272; guardian-cryptic-30102 repeat 0: 0.0694 vs 0.0625;
guardian-cryptic-30102 repeat 1: 0.1389 vs 0.0625), all cryptic-stratum
records, all on puzzles/repeats where cryptic's higher escalation rate
(tier-2 share around 0.12-0.15 versus american's 0.04-0.09) makes a
tier-2 re-ask's exact wording, and therefore its cache key, more sensitive
to timing than american's mostly-tier-1 asks. Mean difference across all
12 cryptic paired records is +0.0111 (baseline slightly higher), well
inside both runs' cryptic noise floors (0.0370 here, 0.0280 in the model
comparison). **Conclusion: they agree within noise**, with the american
stratum agreeing exactly and the cryptic stratum agreeing to well within
one noise-floor width.

## Caveats

- **The american-stratum decision is not clean.** As detailed above, the
  rule's step 1 no longer resolves to a flat zero-perfect tie for the
  first time in this series, but the resulting two-way tie between
  `eager-escalation` and `patient` is itself not resolved cleanly by the
  rule's text, and the cost ratio that would settle it (1.4754x) sits
  close to the 1.5x threshold.
- **A single perfect solve per profile is a thin signal.** Both perfect
  results are one repeat of one puzzle each (both on the same puzzle,
  `xd-lat2024-01-08`, which was also this bench's easiest american puzzle
  by letters accuracy in every repeat of every profile). A perfect-puzzle
  rate of 1/24 versus 0/24 easily could flip with a different repeat seed;
  treat "eager-escalation and patient beat baseline on perfect-puzzle
  rate" as suggestive, not established.
- **Warm-cache spend and wall clock are not representative of a genuinely
  cold run.** Both are far lower here than in any earlier bench in this
  series because the model comparison bench primed most of the cache the
  same day; a first-time run against this puzzle set and model pair (as
  `flash-tier1` was) would cost and take substantially more, as
  docs/benches/model-comparison.md's own cold-cache figures for the same
  model pair show ($0.026131/puzzle counterfactual either way, but a mean
  wall time of 131936 ms there versus 2477 ms here on the american
  stratum, since `usdCounterfactual` prices a cache hit as if cold but
  wall clock does not).
- **`eager-escalation` and `patient` were not fully cache-warm.** Their
  escalation timing differs from `baseline`'s and from `flash-tier1`'s, so
  a meaningful share of their tier-2 calls (37.7% of eager-escalation's,
  13.2% of patient's) were genuine cold calls at real cost and latency;
  this is part of why `eager-escalation`'s mean wall time (23758 ms,
  american stratum) is an order of magnitude above `baseline`'s (2477 ms).
- **This is a three-repeat measurement**, matching the prior
  prompt-version-3-vs-2 and model-comparison paired measurements in rigor,
  but still a small sample (8 american puzzles x 3 repeats = 24 paired
  observations per comparison); the confidence intervals above reflect
  that sample size.
- Cryptic stratum is reported for completeness only, per this document's
  and docs/benches/README.md's convention: the decision rule uses the
  american stratum only.

## How this differs from the Nemotron-pair result

Every earlier section of this document (now retitled to make this
explicit) measured `nvidia/Nemotron-3_5-Lightning` as tier 1; this section
measures `deepseek-ai/DeepSeek-V4-Flash-0731`, the T69 default swap. The
shape of the result changed along with the model: the Nemotron-pair
canonical run had american-stratum letters accuracy in the high 0.5s to
low 0.6s for all three profiles and a three-way tie at a 0.0000
perfect-puzzle rate, so the decision rule always fell through to its cost
tie-break, which it won by under 1.1% - a result this document's own text
called "essentially noise." The Flash pair lifts american-stratum letters
accuracy into the 0.80-0.81 range for all three profiles (consistent with
docs/benches/model-comparison.md's finding that the model swap, not the
escalation policy, drives most of the accuracy gain) and, for the first
time, produces a nonzero perfect-puzzle rate for two of the three
profiles - but the rate is a thin 1-of-24 signal for each, the two
profiles that achieve it are tied, and the resulting cost tie-break
(1.4754x) is, if anything, an even closer call than the Nemotron pair's
1.0072x-to-1.0101x margins were to their own 1.5x threshold in the
opposite sense (there, all three profiles were so close on cost that the
rule's tie-break barely mattered; here, the two leading profiles are so
close on cost that which one the tie-break convention favors is itself
ambiguous). In both cases the conclusion is the same shape: the
escalation-policy choice among `baseline`, `eager-escalation` and
`patient` remains undecided by this rule, on this set, regardless of which
tier-1 model sits underneath it; only the level of raw accuracy the
profiles operate at, not which profile wins among them, moved between the
two model pairs.

# Prompt version 3 versus 2 on the Nemotron pair: paired measurement on modern-12 (2026-09-05)

(Tier 1 `nvidia/Nemotron-3_5-Lightning`, tier 2 `deepseek-ai/DeepSeek-V4-Pro`
throughout this section and every section below it, except where a section
says otherwise - this is the pre-T69 default tier-1 model. See the "Canonical
result on modern-12 with the Flash pair" section above for the post-T69
`deepseek-ai/DeepSeek-V4-Flash-0731` tier-1 result.)

Date: 2026-09-05
Commit: e66bf2c4c9da7974126e8e1594b7aba191a3d6f5 (main)

## Design

**Why.** The "Canonical result" section below (2026-09-04, post T62/T63) includes a
"Decomposition of the drop" that attributes about three quarters of a real
slot-level regression (612 slots, 103 regressions vs 67 gains, McNemar p about
0.006) to T63's count-and-drop self-prune, and recorded a pending decision to
roll that half of T63 back as promptVersion 3, keeping the restated exact
length and the clue_understood scale. That decomposition was a single-repeat,
read-only, after-the-fact analysis, not a controlled experiment: it flagged
"before trusting any further prompt change, run a four-arm isolation
experiment ... measuring within-config variance first, since a single
8-puzzle repeat cannot resolve a 4-point effect (paired puzzle sd 0.131)."

**What.** promptVersion 3 (T65) was implemented exactly as recommended: T63's
prompt with the count-and-drop self-check removed and nothing else changed
(the restated exact length and the clue_understood scale stay). It is now the
default `PROMPT_VERSION`. A paired profile, `baseline-pv2`, was added that is
identical to `baseline` except it renders promptVersion 2 (the self-prune
still present) via `PAIRED_PROMPT_VERSION`. Both profiles were run three times
each (`--repeat 3`) against the same `sets/modern-12.json`, same commit
(`e66bf2c`), same word list (567,657 lines,
`data/wordlist/collaborative.txt`), giving 72 run records: 12 puzzles x 2
profiles x 3 repeats. Because only the prompt text differs between the two
profiles, the paired difference isolates the self-prune instruction's effect,
holding T62's re-ask/escalation code, the search, and everything else fixed.

## Command and pre-flight estimate

```
docker exec crossword-solver xw bench sets/modern-12.json --profiles baseline,baseline-pv2 --repeat 3 --max-usd 25 --concurrency 2
```

Pre-flight estimate:

```
estimate: 72 runs (12 puzzles x 2 profiles x 3 repeats) ~ $1.440000 (--max-usd 25.000000)
```

The run finished well under budget: total spend across the 72 records was
$2.972784 (`usdCounterfactual` summed) / $2.364383 (`usdBilled` summed),
against the $25 ceiling. Wall clock was 50 minutes 8 seconds (records span
2026-09-05T14:23:03.476Z to 2026-09-05T15:13:11.542Z, first record start to
last record end). Status across the 72 records: 15 `ok`, 57 `partial`, 0
`error`. `budgetHits`: 2 (`tier2Calls`, both on `baseline-pv2`); `baseline`
hit no budget cap. Every one of the 24 (puzzle, profile) cells carries three
records with distinct `repeatIndex` values `{0, 1, 2}`, confirmed by script
over all 72 records.

Raw bench log: `logs/bench-prompt-v3-v2.log` (top-level, gitignored). Full
report tables and the analysis script's output: `logs/bench-prompt-v3-v2/`
(gitignored). The 36 records from the prior single-repeat canonical run are
archived at `runs/modern-12-postfix-single/` (gitignored) for the sequence
comparison below.

## Noise floor

The within-config noise floor is the average, across a stratum's puzzles, of
each puzzle's sample standard deviation of letters accuracy across its three
repeats (same puzzle, same profile, only sampling noise differs):

| stratum | baseline (v3) noise floor | baseline-pv2 (v2) noise floor |
| --- | --- | --- |
| american (n=8) | 0.0490 | 0.0501 |
| cryptic (n=4) | 0.0200 | 0.0735 |
| all (n=12) | 0.0394 | 0.0579 |

## Results per stratum (three repeats each, letters/words/perfect)

### american (n = 8 puzzles)

| profile | letters (mean over repeats) | words | perfect | USD/puzzle (counterfactual) | USD/correct word | tier-2 share |
| --- | --- | --- | --- | --- | --- | --- |
| baseline (v3) | 0.5207 | 0.3075 | 0.0000 | 0.032229 | 0.001362 | 0.0768 |
| baseline-pv2 (v2) | 0.5786 | 0.3669 | 0.0000 | 0.053346 | 0.001894 | 0.1395 |

### cryptic (n = 4 puzzles)

| profile | letters (mean over repeats) | words | perfect | USD/puzzle (counterfactual) | USD/correct word | tier-2 share |
| --- | --- | --- | --- | --- | --- | --- |
| baseline (v3) | 0.0996 | 0.0170 | 0.0000 | 0.038706 | 0.077411 | 0.1492 |
| baseline-pv2 (v2) | 0.1633 | 0.0515 | 0.0000 | 0.037875 | 0.025250 | 0.1763 |

### all 12 puzzles

| profile | letters (mean over repeats) | words | perfect | USD/puzzle (counterfactual) | USD/correct word | tier-2 share |
| --- | --- | --- | --- | --- | --- | --- |
| baseline (v3) | 0.3803 | 0.2106 | 0.0000 | 0.034388 | 0.002157 | 0.0935 |
| baseline-pv2 (v2) | 0.4402 | 0.2617 | 0.0000 | 0.048189 | 0.002500 | 0.1478 |

## Paired comparison: v3 minus v2 on letters accuracy

Per puzzle, the difference of each profile's repeat-mean letters accuracy
(mean of 3 repeats), then the mean of those per-puzzle differences.

**American stratum (n = 8):** mean diff (v3 - v2) = -0.0579, paired sd =
0.0676, paired se = 0.0239, t(7) = -2.423, 95% CI (-0.1145, -0.0014). The
magnitude (0.0579) exceeds both profiles' noise floors on this stratum
(0.0490 and 0.0501) and the CI excludes zero.

**All 12 puzzles (n = 12):** mean diff (v3 - v2) = -0.0599, paired sd =
0.0646, paired se = 0.0187, t(11) = -3.209, 95% CI (-0.1009, -0.0188). Again
the magnitude exceeds both noise floors (0.0394 and 0.0579) and the CI
excludes zero.

Both results say the same thing: v3 (self-prune removed) scores lower than
v2 (self-prune present), by an amount larger than run-to-run sampling noise.
This is the opposite direction from what the single-repeat decomposition
predicted.

**Per-puzzle repeat-level win count** (of the 3 paired repeats, how often v2
beat v3 on letters): v2 won 29 of 36 paired repeats across all 12 puzzles, v3
won 7, no ties. On the american stratum specifically, v2 won 19 of 24; the
lone puzzle where v3 won all three repeats was xd-lat2024-07-17 (the only
american puzzle where v3 beat v2 on the repeat-mean too).

## Sequence: v1 single, v2 single, v2 x3, v3 x3 (american stratum, n = 8)

| stage | source | letters mean |
| --- | --- | --- |
| v1 single | era-test.md, pre-T62/T63, commit 5b42a96 | 0.6308 |
| v2 single | this repo's archived post-fix run, commit f9d3b0b1, `--repeat 1` | 0.5886 |
| v2 x3 | this run, `baseline-pv2`, commit e66bf2c, `--repeat 3` | 0.5786 |
| v3 x3 | this run, `baseline`, commit e66bf2c, `--repeat 3` | 0.5207 |

v2 single (0.5886) and v2 x3 (0.5786) agree within the v2 noise floor
(0.0501), confirming the two v2 measurements are consistent with each other.
v3 x3 (0.5207) is below both v2 measurements, and further from v1 single
(0.6308) than either of them: removing the self-prune moved accuracy away
from the pre-T63 level, not toward it.

## Generation metrics that explain the difference

All 12 puzzles, 3 repeats, 2181 slots per profile:

| metric | baseline (v3) | baseline-pv2 (v2) |
| --- | --- | --- |
| truth-in-candidates share | 0.4516 | 0.4801 |
| mean candidatesSeen | 4.442 | 2.781 |
| zero-candidate share | 0.0156 | 0.0234 |
| length share of rejections | 0.5795 | 0.6242 |
| conversion rate (correct given truth present) | 0.5431 | 0.6074 |
| tier-1 fill correctness | 0.4501 | 0.5102 |
| re-asks (share of slots with >=1 reask) | 0.0940 | 0.1110 |
| escalations per puzzle (mean per run) | 8.583 | 16.944 |
| tier-2 fill correctness | 0.6071 | 0.6929 |
| escalated-slot correctness | 0.2298 | 0.3098 |
| completion tokens per tier-1 call | 210.91 | 119.49 |
| cap hits | 0 | 2 |

v3 does see more raw candidates per slot (4.442 vs 2.781), consistent with
removing a filter that used to drop candidates. But truth-in-candidates share
is slightly lower under v3 (0.4516 vs 0.4801), conversion given the truth is
present is lower (0.5431 vs 0.6074), and tier-1 fill correctness is lower
(0.4501 vs 0.5102): the extra candidates are not simply low-quality noise
diluting a fixed pool of otherwise-unchanged rankings, since ranking and
selection quality among that larger pool is also worse under v3.

The clearest mechanical difference is escalation. v2 escalates to tier-2
roughly twice as often per puzzle as v3 (16.944 vs 8.583 escalations/puzzle),
and v2 also has a higher zero-candidate share (0.0234 vs 0.0156) despite
seeing fewer raw candidates per call. Tier-2 is the most accurate source
under both profiles (0.693 correct for v2's tier-2 fills, 0.607 for v3's),
and escalated slots convert better under v2 too (0.310 vs 0.230). This is
consistent with the self-prune (present in v2, absent in v3) causing more
tier-1 attempts to come back thin or unconfident, which fires escalation to
tier-2 more often, and tier-2's accuracy advantage then applies to a larger
share of v2's slots than v3's.

## Cost per puzzle

`usdCounterfactual` per puzzle, all 12 puzzles: baseline (v3) $0.034388,
baseline-pv2 (v2) $0.048189 - v2 costs about 40% more per puzzle, driven by
its higher escalation rate. But `usdCounterfactual` per correct word is
close and actually favors v3 slightly ($0.002157 vs $0.002500), purely
because v3 both escalates less and gets fewer words right; judged on cost per
correct word alone without accuracy alongside it, that number would
misleadingly favor the worse-performing arm.

## Verdict

**v3 does not recover the pre-T63 level.** On the american stratum, letters
accuracy runs v1 single 0.6308, v2 single 0.5886, v2 x3 0.5786, v3 x3 0.5207
- v3 is farther from v1 than either v2 measurement, not closer. The paired
v3-minus-v2 difference clears the noise floor on both the american stratum
(-0.0579, 95% CI -0.1145 to -0.0014, noise floor about 0.049-0.050) and all
12 puzzles (-0.0599, 95% CI -0.1009 to -0.0188, noise floor about
0.039-0.058): this is a real, measured difference, not sampling noise, and it
runs opposite to what the single-repeat decomposition predicted.

The earlier attribution - that the self-prune was the primary cause of the
T63 regression, and that removing it (v3) would recover accuracy - is not
supported by this paired measurement, and should be treated as wrong, or at
best incomplete. v2 (self-prune present) beats v3 (self-prune removed) on
every accuracy metric measured here: letters, words, truth-in-candidates
share, conversion rate, tier-1 fill correctness, and tier-2 fill correctness,
at a cost increase (about 40% more per puzzle) that is more than offset by
the accuracy gain. The data point instead to escalation frequency as the
mechanism: v2's self-prune appears to make tier-1 look less confident on more
slots, so those slots escalate to tier-2 more often, and tier-2 is the most
accurate source available under either prompt. Removing the self-prune (v3)
leaves tier-1 with more raw candidates but does not make tier-1 itself more
accurate, and it escalates less, forfeiting tier-2's accuracy advantage on a
larger share of slots. This mechanism is inferred from the correlation
between self-prune presence, escalation rate, and accuracy above; it is not
directly instrumented, and this measurement does not explain why a
token-matching self-check would change escalation frequency and tier-1
ranking quality, only that it correlates with both here.

Neither v2 nor v3 recovers the v1 single-repeat level (0.6308): the gap
between v2 x3 (0.5786) and v1 (0.6308), about -0.052, remains unexplained by
the self-prune question this measurement was designed to answer, and is
still open. The most likely remaining candidates are the restated-exact-length
and clue_understood-scale wording that both v2 and v3 carry and v1 does not,
or an interaction with T62's re-ask/escalation changes; this measurement does
not isolate either.

**Recommendation.** Revert the default `PROMPT_VERSION` to '2' (restore the
self-prune) until a further run explains the escalation-frequency link: on
this paired, noise-floor-cleared measurement, v2 outperforms v3 on every
accuracy metric at a cost increase smaller than its accuracy gain justifies.
Before trusting a further prompt change, run a third arm using the v1 prompt
text together with T62's re-ask/escalation code, `--repeat 3` on the same 12
puzzles, to separate the prompt-wording effect from T62's contribution to the
remaining v1-vs-v2 gap.

## Caveats

- **Only the prompt text differs between the two arms.** `profiles/schema.ts`
  fields, policy code, and the search are identical between `baseline` and
  `baseline-pv2`; only `promptVersion` (and therefore the rendered prompt
  bytes and the cache key) differs. This isolates the self-prune instruction
  specifically, not the full T62/T63 change set.
- **v1 single has no retained per-puzzle records.** The v1 (pre-T62/T63)
  measurement used in the sequence comparison above is era-test.md's reported
  aggregate (0.6308 on the american stratum, `--repeat 1`); that run's raw
  records are not available in this repository, so no per-puzzle table or
  paired statistic against v1 could be computed here, only the v2 and v3 x3
  measurements are paired at the puzzle level.
- **`baseline-pv2` hit the tier2Calls budget cap twice**; `baseline` hit no
  cap in this run. Both profiles share the same cap value, so the cap
  difference is a consequence of v2 escalating more, not a differently
  configured cap.
- Full per-profile, per-stratum, per-tier and per-puzzle report tables, the
  analysis script's markdown output, and the raw bench log are archived under
  `logs/bench-prompt-v3-v2/` and `logs/bench-prompt-v3-v2.log`
  (gitignored).

# Canonical result on modern-12 (2026-09-04, post T62/T63)

Date: 2026-09-04
Commit: f9d3b0b1d9b0cb07bacc5053cee0c9550f10cbfd (main)

## Set

`sets/modern-12.json` - 12 puzzles: 8 american-style (2024 Los Angeles
Times weekday dailies from the xd corpus) and 4 Guardian cryptics
(30100-30103, the same four cryptic ids used in `sets/mixed-12.json`).
Puzzles are fetched locally on demand with `xw fetch` and are not committed
to this repository (no-distribution policy); only their ids are, in
`sets/modern-12.json`. This is the standard bench set going forward
(docs/benches/README.md), superseding `sets/mixed-12.json`.

## Environment

- Commit `f9d3b0b1d9b0cb07bacc5053cee0c9550f10cbfd` (main), which includes
  T62 (fire the constrained re-ask before escalation) and T63 (seed prompt
  length discipline, promptVersion 2) - confirmed in-container:
  `docker exec crossword-solver sh -c 'grep -n "PROMPT_VERSION =" src/llm/prompts.ts'`
  prints `export const PROMPT_VERSION = '2';`.
- Word list loaded: `data/wordlist/collaborative.txt`, 567,657 lines,
  confirmed present in the container before the run
  (`docker exec crossword-solver sh -c 'wc -l /app/data/wordlist/collaborative.txt'`).
  No "word list not found" warning appeared anywhere in the bench log, and
  `xw report --by tier` shows a `wordlist` producing tier with 452 slots
  across the 36 runs.
- Candidate cache: cold for these puzzle ids under promptVersion 2 going
  into this run - this is the first bench run against `sets/modern-12.json`
  since T63 landed, so every (puzzle, slot) pair was asked cold the first
  time any profile requested it. Because all three profiles ran against the
  same 12 puzzles within the same invocation, whichever profile's cell
  happened to run first on a given puzzle paid the cold price, and the other
  profiles on that same puzzle sometimes hit the cache seeded within the
  run (the same within-run sharing effect documented for mixed-12, just
  starting from a cold cache instead of a warm one): total spend across the
  36 records was `usdBilled` $1.106281 against `usdCounterfactual`
  $1.808925 - billed is meaningfully below counterfactual, but nowhere near
  as far below as the warm-cache mixed-12 run (there, billed was 91% below
  counterfactual; here it is about 39% below). As with mixed-12, `usdBilled`
  reflects run order rather than policy cost, so all results below use
  `usdCounterfactual` per decision B2.

## Command and pre-flight estimate

```
docker exec crossword-solver xw bench sets/modern-12.json --profiles baseline,eager-escalation,patient --max-usd 25 --concurrency 2
```

Pre-flight estimate:

```
estimate: 36 runs (12 puzzles x 3 profiles x 1 repeats) ~ $0.720000 (--max-usd 25.000000)
```

The run finished well under budget: total spend across the 36 records was
$1.808925 (`usdCounterfactual` summed) / $1.106281 (`usdBilled` summed),
against the $25 ceiling - about a dollar, as expected for a cold-cache run
under promptVersion 2. Wall clock was about 14 minutes 37 seconds (the runs
spanned 2026-09-04T22:35:09.263Z to 2026-09-04T22:49:46.227Z, first record
start to last record end). No run in the matrix carried `status: 'error'`,
so the `BENCH_PARTIAL` exit path (exit 6) was never triggered by budget -
but see caveats: every run's own `status` is either `'ok'` (7 of 36) or
`'partial'` (29 of 36); none reached `accuracy.perfect: true`.

## Results: american stratum (decision-relevant)

n = 8 puzzles per profile.

| profile | letters | words | perfect | USD/puzzle (counterfactual) | USD/correct word | tier-2 share of calls | mean wall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.5886 | 0.3680 | 0.0000 | 0.054779 | 0.001939 | 0.1394 | 79245 ms |
| eager-escalation | 0.6101 | 0.4156 | 0.0000 | 0.061633 | 0.001934 | 0.1760 | 61424 ms |
| patient | 0.5654 | 0.3489 | 0.0000 | 0.051353 | 0.001920 | 0.1293 | 20918 ms |

## Results: cryptic stratum (reported, not decision-relevant)

n = 4 puzzles per profile.

| profile | letters | words | perfect | USD/puzzle (counterfactual) | USD/correct word | tier-2 share of calls | mean wall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.1538 | 0.0256 | 0.0000 | 0.038562 | 0.051416 | 0.1827 | 58088 ms |
| eager-escalation | 0.1370 | 0.0345 | 0.0000 | 0.040786 | 0.040786 | 0.2088 | 49556 ms |
| patient | 0.1493 | 0.0524 | 0.0000 | 0.037352 | 0.024901 | 0.1768 | 11113 ms |

## Results: all 12 puzzles (both strata combined)

n = 12 puzzles per profile.

| profile | letters | words | perfect | USD/puzzle (counterfactual) | USD/correct word | tier-2 share of calls | mean wall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.4437 | 0.2539 | 0.0000 | 0.049373 | 0.002587 | 0.1491 | 72193 ms |
| eager-escalation | 0.4524 | 0.2886 | 0.0000 | 0.054684 | 0.002534 | 0.1833 | 57468 ms |
| patient | 0.4267 | 0.2501 | 0.0000 | 0.046686 | 0.002547 | 0.1401 | 17649 ms |

Letter-accuracy delta on the american stratum, reported but not decided on:
eager-escalation is +0.0215 letters over baseline (0.6101 vs 0.5886);
patient is -0.0232 letters versus baseline (0.5654 vs 0.5886) - unlike
mixed-12, where both alternative profiles beat baseline on letters, here
patient falls slightly behind baseline on raw accuracy while still costing
less per correct word.

## Decision rule, quoted verbatim (docs/benches/README.md)

> **Decision rule (american stratum only):** Pick the profile with the
> highest perfect-puzzle rate on the american stratum. If the winner's USD
> per correct word exceeds the best alternative by more than a factor of
> 1.5, pick the alternative instead. Report the cryptic stratum and
> letter-accuracy delta alongside, but do not make decisions on either.

## Applying the rule, step by step

**Step 1 - highest perfect-puzzle rate on the american stratum.**
american-stratum perfect-puzzle rate: baseline 0.0000, eager-escalation
0.0000, patient 0.0000. All three profiles solved zero of their 8 american
puzzles perfectly, despite materially higher raw letter and word accuracy
than the mixed-12 (pre-1965) stratum - an era effect examined in
docs/benches/era-test.md, not a T62/T63 effect; see "Effect of T62/T63 on
the eight LA Times puzzles (paired comparison with the era test)" below for
a paired before/after decomposition of this run's own baseline against the
era-test baseline on these same eight puzzles. This is a three-way tie at
the maximum (0), not a unique winner, so
as with mixed-12 the rule's premise (step 1 picks one profile to test
against "the best alternative" in step 2) does not hold here.

**Step 2 - resolving the tie with the rule's own cost check.** With no
unique perfect-rate winner, applying the rule's cost criterion directly
across the tied profiles (USD per correct word, on `usdCounterfactual`):
patient $0.001920, eager-escalation $0.001934, baseline $0.001939. patient
is again the cheapest, but by an even smaller margin than on mixed-12:
eager-escalation costs 0.001934 / 0.001920 = 1.0072x patient's price per
correct word, and baseline costs 0.001939 / 0.001920 = 1.0101x. Both ratios
are far short of the rule's 1.5x threshold, and both are tighter than the
already-marginal ~1.036x-1.038x gaps seen on mixed-12.

**Conclusion: patient, but the margin is essentially noise.** Given the
three-way tie at a 0.0000 perfect-puzzle rate on the american stratum, the
rule's only tie-break lever is cost, and patient wins it by the numbers -
but by under 1.1%, tighter even than mixed-12's under-4% gap and nowhere
near the rule's 1.5x threshold for overturning a winner. This result should
again be read as "no profile is clearly preferred by the documented rule on
this data": all three sit within about 1% of each other on cost, and
eager-escalation has the best raw accuracy on the american stratum (0.4156
words, 0.6101 letters, both highest of the three) while being the most
expensive per puzzle in absolute terms (0.061633 USD/puzzle) yet
essentially tied on USD per correct word. patient does keep a real,
non-marginal advantage in one respect not covered by the rule's own metric:
mean wall time (20918 ms vs 61424-79245 ms), consistent with its low tier-2
share on this run. Because the rule's tie-break is cost and not speed or
raw accuracy, and cost does not separate the profiles here, this run does
not produce a strong recommendation either way; a repeat with `--repeat > 1`
is needed before treating "patient" as more than a marginal, rule-literal
pick - the same qualification carried over from the mixed-12 result.

## Effect of T62/T63 on the eight LA Times puzzles (paired comparison with the era test)

The most direct before/after comparison available is baseline's own numbers
on the identical 8 `xd-lat2024` puzzles, run twice: once by
docs/benches/era-test.md (pre-T62/T63, commit
`5b42a96e1933edfb762bc8060ac134ee7ac36857`) and once here (post-T62/T63,
commit `f9d3b0b1d9b0cb07bacc5053cee0c9550f10cbfd`), both `--repeat 1`,
baseline profile only, same 612 slots:

| metric | era-test baseline (pre T62/T63) | this run's baseline (post T62/T63) | delta |
| --- | --- | --- | --- |
| letters | 0.6308 | 0.5886 | -0.0422 |
| words | 0.4256 | 0.3680 | -0.0576 |
| reasks (share of slots) | 3.1% | 11.44% (70/612) | +8.34 pp |

Two things move, in opposite directions from what might be expected. The
reask share jumps sharply, consistent with T62's fix: era-test.md's own
"Next" section flagged that the pre-T62 re-ask decision path was firing far
less than intended (3.0%-3.1% of slots, identical across both the 1950s and
2024 groups, which era-test.md called out as "a solver-code property, not a
puzzle property" left over for T62 to fix); a higher reask share after T62
firing correctly is the expected direction. But letter and word accuracy
both go down, not up - on this single-repeat comparison, the two fixes
(T62's re-ask path and T63's promptVersion 2 prompt) did not produce a
visible net accuracy gain on this exact 8-puzzle slice, and in fact moved
the opposite way from what "fixing bugs" would suggest. This should be read
cautiously rather than as evidence that T62/T63 regressed the solver: both
runs are `--repeat 1` on only 8 puzzles, and this document's own caveats
elsewhere note how easily a single-repeat sample can flip a close result.
It does mean the era-test's forward-looking comment ("a fresh run against
modern-12.json is future work") should not be read as implying T62/T63
would obviously raise the american-stratum numbers - on this data, at
`--repeat 1`, they did not. Isolating T62/T63's true effect (holding
puzzles and profile fixed, differing only by commit, with `--repeat > 1` to
average out sampling noise) is flagged as follow-up work, not concluded
here.

### Decomposition of the drop

A read-only paired analysis of the same 612 slots (before: era-test
baseline run, promptVersion 1, commit `5b42a96e1933edfb762bc8060ac134ee7ac36857`;
after: this run's baseline, promptVersion 2, commit
`f9d3b0b1d9b0cb07bacc5053cee0c9550f10cbfd`) breaks the letters/words drop
down by pipeline stage, to separate a real effect from single-sample noise.

**Headline.** Letters fell 0.6308 to 0.5886, words 0.4256 to 0.3680,
correct slots 262 to 226 (of 612). A paired McNemar test on the 612 slots
found 103 regressions against 67 gains (chi-square 7.62, p about 0.006):
the slot-level loss is real. The puzzle-level mean drop is not itself
significant (paired t = -0.91 across the 8 puzzles, 95% CI -0.151 to
+0.067; 5 puzzles worse, 2 better, 1 tie); excluding the two most-affected
puzzles, xd-lat2024-03-21 and xd-lat2024-07-17, the mean delta across the
remaining six is +0.015. The two results do not conflict - eight puzzles is
too few to resolve a slot-level effect of this size at the puzzle-mean
level.

| metric | before (era-test, v1) | after (this run, v2) |
| --- | --- | --- |
| letters | 0.6308 | 0.5886 |
| words | 0.4256 | 0.3680 |
| correct slots (of 612) | 262 | 226 |
| McNemar regressions / gains | - | 103 / 67 (chi-sq 7.62, p ~ 0.006) |
| paired puzzle-mean t (8 puzzles) | - | -0.91 (95% CI -0.151 to +0.067) |

**Generation.** Truth-in-candidates held roughly level, 0.544 to 0.534, but
that hides a 24.5% reshuffle of which slots ever saw the truth (78 slots
lost it, 72 gained it), and the reshuffle's payoff was asymmetric: slots
that lost the truth went from 44/71 correct to 6/71, while slots that
gained it went from 0/20 to 11/20. Length rejections fell from 85.5% to
65.4% of all rejections and candidate survival rose from 25.7% to 41.9%,
but raw candidates offered per call fell 35% and completion tokens per call
fell 41%; net candidatesSeen per slot moved from 2.57 to 2.72. By answer
length, truth-in-candidates fell 11 points at length 3 and 9 points at
length 4 (56% of all slots) and rose at lengths 6 and up.

**Placement.** Conversion (correct given the truth was present in
candidates) fell 0.721 to 0.633, and the rank-1 share of present truths
fell 0.868 to 0.823. Wipeouts rose 138 to 176 and pattern rejections rose
306 to 662, while search configuration and backtrack counts were identical
(33 each) - placement got harder without the search itself changing,
because what generation handed it changed.

**Policy.** Re-asks rose 19 to 74 (3.1% to 12.1% of slots); re-asked slots
retrieve the truth more often after the change (0.211 to 0.571), but the
re-ask-only population's own correctness fell, 7/27 to 0/27. Escalations
rose 68 to 151 (the tier-2 cap was also raised, 15 to 25, between runs);
the escalation path is net positive - 111 newly escalated slots went 31 to
43 correct - and tier-2 fills remain the most accurate source overall
(0.792 correct). The cap bound on only two puzzles, xd-lat2024-09-11 and
xd-lat2024-11-14, both of which were near-flat before/after.

**Attribution of the net -36 slots.** Slots escalated after the change:
+11. Slots re-asked but not escalated: -7. Slots untouched by either
policy: -40 (of which -38 lost the truth, +11 gained it, and -13 had it
present both before and after).

**Ranked causes.**
1. T63's count-and-drop self-prune reducing candidate volume and churning
   which slots retain recall - about three quarters of the loss.
2. Lower ranking of present truths, downstream of the same prompt change.
3. Re-asks not converting to correct fills - a small contribution.
4. Single-sample noise, which can explain the puzzle-level mean but not the
   slot-level regression.
5. T62's seed-time escalation consuming the cap - not supported by the
   data (the cap only bound on two near-flat puzzles).

**Recommendation recorded (decision pending).** Keep T62 as is. Roll back
the length self-prune half of T63 while keeping the clue_understood scale,
as promptVersion 3. Consider raising candidatesPerAsk. Before trusting any
further prompt change, run a four-arm isolation experiment - this run's
config with 3 repeats; v2 minus the self-prune; the v1 prompt with T62; the
v2 prompt with pre-T62 escalation - at roughly $4.55 total, measuring
within-config variance first, since a single 8-puzzle repeat cannot resolve
a 4-point effect (paired puzzle sd 0.131).

## Caveats

- **`--repeat 1`**: every (puzzle, profile) cell was run exactly once, so
  the `_stdev` columns in the raw report tables are sample standard
  deviation across puzzles within a stratum, not within-puzzle run-to-run
  variance. The three profiles are closer together on cost per correct word
  here than on mixed-12 (within about 1% on the american stratum, versus
  about 4% there), so this run is an even weaker basis for a decision than
  mixed-12 was; a single unlucky or lucky sample could easily flip the
  ranking.
- **Cache cold going in, mixed within the run**: `usdBilled` ($1.106281)
  is below `usdCounterfactual` ($1.808925) but by far less than on the
  warm-cache mixed-12 run, because this was the first bench pass against
  these ids under promptVersion 2 - see Environment above for the
  within-run sharing mechanism. The counterfactual basis is what makes the
  three profiles comparable here, same as for mixed-12.
- **Budget-cap hits**: 4 of the 36 runs hit the `tier2Calls` budget cap
  (limit 25 in this run, versus 15 on mixed-12), all on the american
  stratum: eager-escalation twice (xd-lat2024-03-21, xd-lat2024-09-11),
  baseline twice (xd-lat2024-09-11, xd-lat2024-11-14). Unlike mixed-12's
  warm-cache run, where several hits landed within about 30 ms of the run
  starting (an artifact of cache hits resolving near-instantly), every hit
  here landed after 48-82 seconds of real elapsed time
  (`atMs` 48812-82279), consistent with a cold cache where tier-2 calls
  carry real latency. The other 32 `partial`/`ok` records carry no
  `budgetHits` at all.
- **Reasks per slot per profile** (all 12 puzzles, 727 slots per profile):
  baseline 12.10% (88/727), eager-escalation 0.00% (0/727), patient 13.48%
  (98/727). eager-escalation fired zero constrained re-asks anywhere in
  this run - reported here as a raw observation, not further diagnosed.
- **Nobody reached a perfect puzzle**: despite materially higher raw
  accuracy than the mixed-12 stratum (american-stratum letters run
  0.57-0.61 here versus 0.35-0.39 on mixed-12), `accuracy.perfect` is
  `false` on all 36 records at `--repeat 1`.
- No provider errors and no run-level `status: 'error'` occurred anywhere
  in the matrix.
- **No events trace captured**: this run did not produce a `.events.jsonl`
  stream, so the escalation and re-ask timing used in the "Decomposition of
  the drop" section above (which slots were escalated versus re-asked, and
  in what order) was inferred from the run records and slot-level report
  tables rather than read directly off an event log. A repeat run with the
  events trace captured would let that timing be checked directly instead
  of inferred.
- Full per-profile, per-stratum and per-tier report tables, the slot
  difficulty view, and the raw bench log are archived under
  `logs/bench-modern-12/` (gitignored).

# Historical result on mixed-12 (2026-09-04, pre T62/T63)

Date: 2026-09-04
Commit: e249802f688ad3ffb8676641f111e2b10312e1f0 (main)

## Set

`sets/mixed-12.json` - 12 puzzles: 8 american-style (pre-1965 NYT dailies:
1951, 1953, 1955, 1957, 1959, 1961, 1963, 1964, one per year, from the xd
corpus) and 4 Guardian cryptics (30100-30103). Puzzles are fetched locally
on demand with `xw fetch` and are not committed to this repository
(no-distribution policy); only their ids are, in `sets/mixed-12.json`.

## Environment

- Word list loaded: `data/wordlist/collaborative.txt`, 567,657 lines,
  confirmed present in the container before and after the run
  (`docker exec crossword-solver sh -c 'wc -l /app/data/wordlist/collaborative.txt'`).
  No "word list not found" warning appeared anywhere in the bench log, and
  `xw report --by tier` shows a `wordlist` producing tier with 466 slots
  across the 36 runs.
- Candidate cache: warm, seeded by two earlier local passes against this
  same puzzle set and profile matrix (an archived first pass with no word
  list, and an aborted warm-cache re-run). Total spend across the 36 records
  summed to $0.087362 `usdBilled` against $0.983444 `usdCounterfactual` -
  about 93% of candidate calls were served from the cache (3,413 of 3,658;
  1,087 to 1,186 per profile), which is why billed spend was 91% below the
  counterfactual figure. Because the cache was warm
  and unevenly shared across profiles (whichever profile's cell happened to
  run first against a given puzzle/slot paid the cold price; the other two
  profiles on that cell often hit the cache), `usdBilled` is not a fair
  basis for comparing the three profiles - it reflects run order, not policy
  cost. All results below use `usdCounterfactual` (every call priced as if
  cold) per decision B2, which is the documented basis for this bench.

## Command and pre-flight estimate

```
docker exec crossword-solver xw bench sets/mixed-12.json --profiles baseline,eager-escalation,patient --max-usd 25 --concurrency 2
```

Pre-flight estimate:

```
estimate: 36 runs (12 puzzles x 3 profiles x 1 repeats) ~ $0.720000 (--max-usd 25.000000)
```

The run finished well under budget: total spend across the 36 records was
$0.983444 (`usdCounterfactual` summed) / $0.087362 (`usdBilled` summed),
against the $25 ceiling. Wall clock was about 3 minutes (the runs spanned
2026-09-04T19:48:13Z to 2026-09-04T19:51:10Z, first record start to last
record end), much faster than the first pass's ~17.5 minutes because of the
warm cache. Exit code 0. No
run in the matrix carried `status: 'error'`, so the `BENCH_PARTIAL` exit
path (exit 6) was never triggered - but see caveats: every run's own
`status` is either `'ok'` (grid fully filled, 7 of 36) or `'partial'` (29 of
36); none reached `accuracy.perfect: true`.

## Results: american stratum (decision-relevant)

n = 8 puzzles per profile.

| profile | letters | words | perfect | USD/puzzle (counterfactual) | USD/correct word | tier-2 share of calls | mean wall time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.3484 | 0.1672 | 0.0000 | 0.028740 | 0.002276 | 0.0911 | 9954 ms |
| eager-escalation | 0.3853 | 0.1916 | 0.0000 | 0.032908 | 0.002270 | 0.1130 | 7385 ms |
| patient | 0.3568 | 0.1755 | 0.0000 | 0.029040 | 0.002192 | 0.0908 | 2871 ms |

## Results: cryptic stratum (reported, not decision-relevant)

n = 4 puzzles per profile.

| profile | letters | words | perfect | USD/puzzle (counterfactual) | USD/correct word | tier-2 share of calls | mean wall time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.1197 | 0.0268 | 0.0000 | 0.019991 | 0.026655 | 0.0945 | 22720 ms |
| eager-escalation | 0.1352 | 0.0345 | 0.0000 | 0.026684 | 0.026684 | 0.1486 | 19392 ms |
| patient | 0.1132 | 0.0262 | 0.0000 | 0.017810 | 0.023747 | 0.0929 | 4808 ms |

## Results: all 12 puzzles (both strata combined)

n = 12 puzzles per profile.

| profile | letters | words | perfect | USD/puzzle (counterfactual) | USD/correct word | tier-2 share of calls | mean wall time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.2722 | 0.1204 | 0.0000 | 0.025824 | 0.002980 | 0.0919 | 14209 ms |
| eager-escalation | 0.3019 | 0.1392 | 0.0000 | 0.030834 | 0.003083 | 0.1210 | 11388 ms |
| patient | 0.2756 | 0.1257 | 0.0000 | 0.025297 | 0.002785 | 0.0913 | 3516 ms |

Letter-accuracy delta on the american stratum, reported but not decided on:
eager-escalation is +0.0369 letters over baseline (0.3853 vs 0.3484);
patient is +0.0085 letters over baseline (0.3568 vs 0.3484).

## Decision rule, quoted verbatim (docs/benches/README.md)

> **Decision rule (american stratum only):** Pick the profile with the
> highest perfect-puzzle rate on the american stratum. If the winner's USD
> per correct word exceeds the best alternative by more than a factor of
> 1.5, pick the alternative instead. Report the cryptic stratum and
> letter-accuracy delta alongside, but do not make decisions on either.

## Applying the rule, step by step

**Step 1 - highest perfect-puzzle rate on the american stratum.**
american-stratum perfect-puzzle rate: baseline 0.0000, eager-escalation
0.0000, patient 0.0000. All three profiles solved zero of their 8 american
puzzles perfectly (word-list availability raised letter accuracy for all
three profiles over the first pass, and raised word accuracy for baseline
and patient, while eager-escalation's word accuracy dipped slightly - see
the superseded section below - but not enough to close out a full grid on
any single-repeat run in this set). This is a
three-way tie at the maximum (0), not a unique winner - as in the first
pass, the rule as written presumes step 1 picks one profile to test against
"the best alternative" in step 2, and that premise does not hold here.

**Step 2 - resolving the tie with the rule's own cost check.** With no
unique perfect-rate winner, applying the rule's cost criterion directly
across the tied profiles (USD per correct word, on `usdCounterfactual`):
patient $0.002192, eager-escalation $0.002270, baseline $0.002276. patient
is the cheapest, but only marginally: eager-escalation costs
0.002270 / 0.002192 = 1.036x patient's price per correct word, and baseline
costs 0.002276 / 0.002192 = 1.038x. Both ratios are far short of the rule's
1.5x threshold - unlike the first pass, where the cheapest profile beat the
other two by roughly 20x, this cost tie-break does not meaningfully separate
the three profiles.

**Conclusion: patient, but the margin is not decisive.** Given the
three-way tie at a 0.0000 perfect-puzzle rate on the american stratum, the
rule's only tie-break lever is cost, and patient wins it by the numbers -
but by under 4%, not the order-of-magnitude gap seen in the first pass. This
result should be read as "no profile is clearly preferred by the documented
rule on this data": all three sit within a few percent of each other on
cost, and eager-escalation actually has the best raw accuracy on the
american stratum (0.1916 words, 0.3853 letters, both highest of the three)
while being the most expensive per puzzle in absolute terms (0.032908
USD/puzzle) yet essentially tied on USD per correct word. patient does keep
a real, non-marginal advantage in one respect not covered by the rule's
own metric: mean wall time (2871 ms vs 7385-9954 ms), consistent with its
low tier-2 share and cheap escalations. Because the rule's tie-break is cost
and not speed or raw accuracy, and cost does not separate the profiles here,
this run does not produce a strong recommendation either way; a repeat with
`--repeat > 1` (see caveats) is needed before treating "patient" as more
than a marginal, rule-literal pick.

## Caveats

- **`--repeat 1`**: every (puzzle, profile) cell was run exactly once, so
  the `_stdev` columns in the raw report tables are sample standard
  deviation across puzzles within a stratum, not within-puzzle run-to-run
  variance. Given how close the three profiles are on cost per correct word
  (all within about 4% of each other on the american stratum), a single
  unlucky or lucky sample could plausibly flip the ranking; this is a
  meaningfully weaker basis for a decision than a wide margin would be.
- **Pre-1965 clues**: the american puzzles are NYT dailies from 1951-1964.
  Vocabulary, abbreviation conventions and clue style from that era differ
  from modern NYT/USA Today puzzles the solver may eventually be scored
  against; these results characterize policy behavior on this specific
  vintage slice, not on modern american puzzles.
- **Cost basis**: all USD figures are `usdCounterfactual` (priced as if
  every call were cold), per the bench's documented metric (decision B2).
  In this run `usdBilled` ($0.087362 total) was far below
  `usdCounterfactual` ($0.983444 total) because the candidate cache was warm
  from two earlier local passes and shared unevenly across profiles and run
  order - see Environment above. The counterfactual basis is what makes the
  three profiles comparable here; billed cost alone would favor whichever
  profile happened to run after the others on a given puzzle.
- **Budget-cap hits**: 6 of the 36 runs hit the `tier2Calls` budget cap
  (limit 15), all on the american stratum: eager-escalation 4 times
  (xd-nyt1953-01-01, xd-nyt1955-01-03, xd-nyt1957-01-01, xd-nyt1963-01-01),
  baseline once (xd-nyt1955-01-03), patient once (xd-nyt1955-01-03). Four of
  these six hits landed within about 30 ms of the run starting (18-27 ms) -
  a direct consequence of the warm cache: with most tier-2 candidate calls
  served from cache, a cluster of slots can escalate and resolve
  near-instantly, hitting the 15-call cap before any real latency
  accumulates. This is a more pronounced version of an oddity seen once in
  the first pass (there, one patient hit landed at 25 ms out of only 7 total
  hits; here it is 4 of 6). The other 30 `partial`/`ok` records carry no
  `budgetHits` at all.
- **Nobody reached a perfect puzzle**: despite the word list now being
  loaded and active (`wordlist` tier producing 466 of 1,459 slot fills
  across the run), `accuracy.perfect` is `false` on all 36 records. Letter
  and word accuracy improved substantially over the first pass (see below)
  but a single-repeat run on this vintage/cryptic mix did not fully solve
  any puzzle for any profile.
- No provider errors and no run-level `status: 'error'` occurred anywhere
  in the matrix.

## First pass (2026-09-04, superseded)

An earlier bench run against the same command and puzzle set was performed
before the word list was loaded into the container. Its full write-up is
archived at `logs/bench-mixed-12-first-pass/escalation-policy-first-pass-draft.md`
and its 36 run records at `runs/first-pass-no-wordlist/`. Its numbers are
reproduced below for reference; they are superseded by the results above
and must not be used for the escalation-policy decision.

### First-pass results: american stratum

n = 8 puzzles per profile.

| profile | letters | words | perfect | USD/puzzle (counterfactual) | USD/correct word | tier-2 share of calls | mean wall time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.3333 | 0.1595 | 0.0000 | 0.025129 | 0.002116 | 0.0798 | 92080 ms |
| eager-escalation | 0.3789 | 0.1936 | 0.0000 | 0.028455 | 0.001997 | 0.1648 | 84970 ms |
| patient | 0.3385 | 0.1641 | 0.0000 | 0.001197 | 0.000098 | 0.0698 | 16667 ms |

### First-pass results: all 12 puzzles (both strata combined)

n = 12 puzzles per profile.

| profile | letters | words | perfect | USD/puzzle (counterfactual) | USD/correct word | tier-2 share of calls | mean wall time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.2578 | 0.1181 | 0.0000 | 0.023013 | 0.002789 | 0.0861 | 83085 ms |
| eager-escalation | 0.2903 | 0.1407 | 0.0000 | 0.025179 | 0.002561 | 0.1883 | 73209 ms |
| patient | 0.2564 | 0.1153 | 0.0000 | 0.002506 | 0.000301 | 0.1587 | 17449 ms |

### First pass's stated conclusion

"Given the three-way tie at a 0.0000 perfect-puzzle rate on the american
stratum, the rule's cost tie-break decides, and patient wins it decisively
(roughly 1/20th to 1/22nd the USD per correct word of the other two
profiles). eager-escalation has the best raw word and letter accuracy on
the american stratum (0.1936 words, 0.3789 letters) and would be the pick
under a rule that used accuracy as its own tie-break instead of cost, but
that is not what the documented rule says: its only tie-break lever is
cost, and cost points squarely at patient." (quoted from
`escalation-policy-first-pass-draft.md`)

### Why the first pass is superseded

Two reasons, both environmental rather than a difference in the profiles
themselves:

1. **The word-list gate was disabled for all profiles, so every run ended
   partial.** The container was missing `data/wordlist/collaborative.txt`
   (never fetched in that environment), which disabled the word-list arm of
   the repair pass's plausibility gate identically for all three profiles.
   Across the 715 (puzzle, slot) pairs in the set, 563 (78.7%) were wrong
   under all three profiles and only 63 (8.8%) were solved by all three; the
   perfect-puzzle rate tying at 0.0000 across the board was mostly an
   artifact of this missing gate rather than a real ceiling on any policy.
   This canonical run has the word list loaded (567,657 entries, confirmed
   present) and shows materially higher letter/word accuracy on every
   profile and stratum as a result, though still no perfect puzzles at
   `--repeat 1`.
2. **Cache hits were not priced counterfactually, so the last profile to
   run on each puzzle looked nearly free.** At the time of the first pass,
   a cache hit contributed to neither `usdBilled` nor `usdCounterfactual` in
   the run recorder - only cold transport calls were priced at all. Because
   the matrix ran with no prior cache and profiles landed on the same
   puzzle/slot pairs, whichever profile happened to be scheduled later on a
   puzzle often found some of its candidates already cached from an earlier
   profile's cold calls in the same run, and that saved cost vanished from
   both USD figures rather than being counted as if cold. This
   systematically favored whichever profile ran later within a
   (puzzle, cell) group - in that run's data, this is a large part of why
   patient's `usdCounterfactual` looked roughly 20x cheaper than the other
   two profiles, since `patient` was scheduled last on most cells. T61
   ("Price cache hits counterfactually in run records and the cost block")
   fixed this: every cache hit now contributes its cached usage to
   `usdCounterfactual` (priced as if cold) while only genuinely cold calls
   contribute to `usdBilled`. This canonical run was executed after that
   fix, against a cache that was already warm from two earlier local
   passes, and its `usdCounterfactual` figures above are the ones decision
   B2 designates as the basis for the escalation-policy decision.
