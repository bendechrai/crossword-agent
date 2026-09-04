# Escalation-policy bench: results (mixed-12)

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
