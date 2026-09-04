# Era test: does puzzle age explain the low solve rate

**Date:** 2026-09-04

## Purpose

The escalation-policy bench (docs/benches/escalation-policy.md) showed a low
letter-accuracy rate on pre-1965 NYT dailies and left open whether that is an
era-mismatch problem - the model knows modern crosswords and their
conventions far better than 1950s ones - or a defect in the solver itself.
This note tests the era-mismatch hypothesis directly: run the same baseline
profile against a group of 2024 puzzles and compare against the same group of
1950s puzzles, holding everything else (profile, solver code) as close to
fixed as the two runs allow.

## Groups

**1950s group (xd-nyt, 8 puzzles):** xd-nyt1951-01-02, xd-nyt1953-01-01,
xd-nyt1955-01-03, xd-nyt1957-01-01, xd-nyt1959-01-01, xd-nyt1961-01-02,
xd-nyt1963-01-01, xd-nyt1964-01-01. These are the 8 american-stratum entries
of `sets/mixed-12.json`, fetched per the `sets/mixed-12.json` recipe in
docs/benches/SETS.md.

**2024 group (xd-lat, 8 puzzles):** xd-lat2024-01-08, xd-lat2024-02-14,
xd-lat2024-03-21, xd-lat2024-04-26, xd-lat2024-06-10, xd-lat2024-07-17,
xd-lat2024-09-11, xd-lat2024-11-14. These are the 8 american-stratum entries
of `sets/modern-12.json`, fetched per the `sets/modern-12.json` recipe in
docs/benches/SETS.md.

Both groups were run on the `baseline` profile only. As with every set under
`sets/`, nothing about puzzle content (grid, clues, solutions) is committed;
this note reports aggregate metrics and puzzle ids only.

## Code state

Both runs' `provenance.gitCommit` predate T62 and T63:

- 1950s baseline run: commit `e249802f688ad3ffb8676641f111e2b10312e1f0`
  ("Status: T61 done").
- 2024 baseline run: commit `5b42a96e1933edfb762bc8060ac134ee7ac36857`
  ("Bench: escalation-policy result on mixed-12"), a docs-only commit on top
  of the same T61 code.

Neither commit includes T62's constrained-re-ask fix or T63's promptVersion 2
seed prompt - both landed afterward, on 2026-09-04 later the same day. So
this comparison isolates puzzle era from the solver code: the code is
identical (pre-T62/T63) across both groups.

## Results

| Metric | 1950s (xd-nyt) | 2024 (xd-lat) |
|---|---|---|
| Puzzles | 8 | 8 |
| Slots | 600 | 612 |
| Mean letter accuracy | 34.8% | 63.1% |
| Mean word accuracy | 16.7% | 42.6% |
| Perfect-puzzle rate | 0% | 0% |
| Truth-in-candidates share | 39.2% | 54.4% |
| truthRank = 1 | 30.0% (180/600) | 47.2% (289/612) |
| truthRank 2-3 | 8.2% (49/600) | 6.9% (42/612) |
| truthRank 4-10 | 1.0% (6/600) | 0.3% (2/612) |
| truthRank >10 | 0% (0/600) | 0% (0/612) |
| Not in candidates | 60.8% (365/600) | 45.6% (279/612) |
| Mean candidatesSeen | 2.95 | 2.57 |
| Zero-candidate share | 3.0% | 0.5% |
| Conversion rate (correct \| truth in candidates) | 41.3% | 72.1% |
| Fill source: tier1 (n, correct%) | 242, 29.8% | 299, 68.9% |
| Fill source: tier2 (n, correct%) | 34, 73.5% | 40, 85.0% |
| Fill source: wordlist (n, correct%) | 112, 3.6% | 122, 18.0% |
| Fill source: unfilled (n) | 212 | 151 |
| Empty (unfilled) share | 35.3% | 24.7% |
| Escalations per puzzle (mean) | 10.75 | 8.5 |
| Puzzles hitting the tier-2 cap | 1 / 8 | 0 / 8 |
| Reasks per slot (share of slots reasked) | 3.0% | 3.1% |
| Length share of candidate rejections | 85.1% (4586/5389) | 85.5% (3887/4544) |
| Correctness by length 3-4 | 19.5% (57/292) | 49.9% (172/345) |
| Correctness by length 5-6 | 15.7% (32/204) | 36.6% (67/183) |
| Correctness by length 7-9 | 14.3% (12/84) | 29.8% (17/57) |
| Correctness by length 10+ | 0% (0/20) | 22.2% (6/27) |
| Billed spend | $0.0070 | $0.1894 |

## Verdict

Era explains most of the gap. Every accuracy-facing metric moves the same
direction and by a large margin: letter accuracy roughly doubles (34.8% to
63.1%), the true answer shows up in the candidate list far more often (39.2%
to 54.4%) and with a much higher share landing at rank 1 (30.0% to 47.2%),
and conversion from "truth was offered" to "truth was placed" nearly doubles
(41.3% to 72.1%). Correctness-by-length climbs in lockstep across every
bucket for the 2024 group. This is consistent with the model knowing modern
American crossword conventions, fill vocabulary and clue style far better
than 1950s ones, rather than with a solver defect that would show up
unevenly.

Two metrics do not move with era and were not explained by it: the
pattern-constrained re-ask rate (3.0% vs 3.1% of slots) and the length share
of candidate rejections (85.1% vs 85.5%) are essentially identical between
the two groups. Both are solver-code properties, not puzzle properties, and
both were fixed after this comparison ran: T62 (fire the constrained re-ask
before escalation) fixed the re-ask decision path, and T63 (seed prompt
length discipline, promptVersion 2) fixed the length-rejection rate at its
source in the prompt.

## Next

The escalation bench (docs/benches/escalation-policy.md, currently run on
`sets/mixed-12.json` at pre-T62/T63 code) should be re-run on
`sets/modern-12.json` with the current T62/T63 code, now that both the era
confound and the two known solver defects are accounted for.
