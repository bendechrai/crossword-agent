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
