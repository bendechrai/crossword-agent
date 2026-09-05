# Tier-1 model comparison: puzzle-level bench on modern-12 (2026-09-05)

Date: 2026-09-05
Commit: 4f7298652bfcef4eebfadfe26a7f237454ad8f3f (main; HEAD advanced during the
run from unrelated concurrent work - see Caveats for the exact commit range)
Set: sets/modern-12.json (8 american, 4 cryptic; 727 slots total, 612
american, 115 cryptic)

## Design

The seed-only recall screen (docs/benches/recall-screen.md, run earlier the
same day) measured only whether a model's single tier-1 ask offers the right
answer, with no search, escalation or repair. On the american stratum its top
three by truth-in-candidates share were deepseek-ai/DeepSeek-V4-Pro,
zai-org/GLM-5.1 and deepseek-ai/DeepSeek-V4-Flash-0731; its cost-efficiency
view (truth-in-candidates per dollar) separately flagged
deepseek-ai/DeepSeek-V4-Flash-0731 as by far the most efficient model
screened (about 92 truth-share points per dollar per puzzle, 9x to 12x the
other top-three models) and meta-llama/Llama-3.3-70B-Instruct as the next
most efficient despite ranking 4th on raw recall (about 46 points per
dollar). This bench takes those two cost-efficient candidates out of the
seed-only setting and measures them as the tier-1 model inside the real
solver: full seed pass, re-asks, escalation to tier-2, search and repair, on
the same puzzle set, at promptVersion 2 (the current default).

**Arms:**

- **A, `flash-tier1`:** `baseline` profile with `tier1` overridden to
  `deepseek-ai/DeepSeek-V4-Flash-0731`. Three repeats.
- **B, `llama-tier1`:** `baseline` profile with `tier1` overridden to
  `meta-llama/Llama-3.3-70B-Instruct`. Three repeats.
- **C, `strong-only`** (built-in): `deepseek-ai/DeepSeek-V4-Pro` for both
  tiers. One repeat. Cost/accuracy ceiling.
- **D, `tier1-only`** (built-in): current tier-1 default
  (`nvidia/Nemotron-3_5-Lightning`), escalation disabled
  (`maxTier2CallsPerPuzzle: 0`). One repeat. Cost/accuracy floor.
- **E, `baseline-pv2`** (reused, not re-run): the current default profile at
  promptVersion 2, three repeats. These are the 36 records from the prior
  prompt-version-2-vs-3 paired measurement (docs/benches/escalation-policy.md),
  commit `e66bf2c4c9da7974126e8e1594b7aba191a3d6f5`, copied into this analysis
  rather than re-run. Its tier-1 is the same `nvidia/Nemotron-3_5-Lightning`
  as arm D, but with re-asks and escalation enabled, so E is the actual
  current-default comparison point and D is the no-escalation floor.

Arms A and B are the two model swaps under test; C and D bracket the range;
E is what a solve run today actually produces. deepseek-ai/DeepSeek-V4-Pro and
zai-org/GLM-5.1, the recall screen's other two top-three-by-recall models, are
not tested as tier-1 swaps here (Pro appears only as the uniform strong-only
ceiling); the task scope was these two cost-efficient candidates plus the two
built-in brackets.

## Profile-file mechanism

`src/profiles/loader.ts` (`resolveProfileSpec`) resolves each entry of
`bench --profiles a,b,c` as either a built-in name or a path to a JSON
profile file (`pathKind(absPath) === 'file'`); `xw bench` (`src/cli/bench.ts`)
calls `resolveProfile({ profile: name, config })` for every comma-separated
entry with no special-casing between the two forms, so a bench matrix can mix
built-in names and file paths freely. A profile file with `"extends":
"<builtin>"` overlays its own top-level fields onto that built-in's complete
literal (one level deep for the nested option groups); the file's `name`
field becomes the resolved profile's name and the run record's `profile.name`.

Two files were created under `logs/profiles/` (gitignored):

`logs/profiles/flash-tier1.json`:
```json
{
  "name": "flash-tier1",
  "extends": "baseline",
  "tier1": "deepseek-ai/DeepSeek-V4-Flash-0731"
}
```

`logs/profiles/llama-tier1.json`:
```json
{
  "name": "llama-tier1",
  "extends": "baseline",
  "tier1": "meta-llama/Llama-3.3-70B-Instruct"
}
```

No dry-parse subcommand exists (`xw solve --help` and `xw bench --help` show
no such flag), so each file was confirmed by the fallback the task
anticipated: `xw bench sets/modern-12.json --profiles <path> --max-usd 0`.
Profile resolution happens before any run starts and before the cost check,
so this prints the pre-flight estimate line naming the resolved profile and
then refuses (usage error, exit 2, no network call, no spend) rather than
running anything:

```
$ docker exec crossword-solver xw bench sets/modern-12.json \
    --profiles logs/profiles/flash-tier1.json,logs/profiles/llama-tier1.json \
    --repeat 3 --max-usd 0
estimate: 72 runs (12 puzzles x 2 profiles x 3 repeats) ~ $1.440000 (--max-usd 0.000000)
estimated cost $1.440000 exceeds --max-usd 0.000000
hint: pass --yes to run the matrix anyway
```

Both files resolved cleanly (no "unknown profile" / "invalid JSON" / "unknown
key" errors), confirming the file-path mechanism and the `extends: baseline`
schema shape before any money was at risk.

## Command, pre-flight estimate and spend

```
mkdir -p runs/prompt-v3-v2 && mv runs/*.json runs/prompt-v3-v2/   # archive the 72 v3-vs-v2 records first

docker exec crossword-solver xw bench sets/modern-12.json \
  --profiles logs/profiles/flash-tier1.json,logs/profiles/llama-tier1.json \
  --repeat 3 --max-usd 15 --concurrency 2

docker exec crossword-solver xw bench sets/modern-12.json \
  --profiles strong-only,tier1-only --max-usd 15 --concurrency 2
```

Run in the background inside the container via `nohup`, both invocations
appending to `/app/logs/bench-models.log` (gitignored; the second started
automatically on the first's success).

Pre-flight estimate lines (both printed, both well under the $15 ceiling, so
neither run needed `--yes`):

```
estimate: 72 runs (12 puzzles x 2 profiles x 3 repeats) ~ $1.440000 (--max-usd 15.000000)
estimate: 24 runs (12 puzzles x 2 profiles x 1 repeats) ~ $0.480000 (--max-usd 15.000000)
```

Combined pre-flight estimate: $1.92. Both estimates are the static
per-puzzle fallback (`estimateTotalUsd`), since none of these four
`(puzzle, profile)` cells had prior runs to price from.

**Actual spend**, summed over the 96 new run records (`usdBilled` /
`usdCounterfactual`):

| phase | records | usd billed | usd counterfactual |
| --- | --- | --- | --- |
| flash-tier1 + llama-tier1 (repeat 3) | 72 | 1.518797 | 2.206173 |
| strong-only + tier1-only (repeat 1) | 24 | 0.708887 | 2.050555 |
| **total** | **96** | **2.227684** | **4.256729** |

$4.256729 counterfactual is about 28% of the $15 authorization; $2.227684
billed is about 15%. The static estimate ($1.92) undershot the actual
counterfactual cost by about 2.2x, mostly because `strong-only` runs
deepseek-ai/DeepSeek-V4-Pro for both tiers with `budget.usd: 2.0` and a wider
rate-limit allowance, which the flat per-puzzle fallback estimate does not
model.

Status across the 96 records: 30 `ok`, 66 `partial`, 0 `error`. No
`budgetHits` on any of the four new arms (`strong-only`, `tier1-only`,
`flash-tier1`, `llama-tier1`); the reused arm E (`baseline-pv2`) carries the
2 `tier2Calls` budget hits already recorded in escalation-policy.md.

**Wall clock:** first record to last record, 2026-09-05T19:20:11.445Z to
2026-09-05T21:56:11.256Z, 2 hours 36 minutes. The first bench (flash-tier1 +
llama-tier1, 72 runs) ran 19:20:11 to 21:41:39 (about 2h 21m); the second
(strong-only + tier1-only, 24 runs) ran 21:46:47 to 21:56:11 (about 9m 24s).
llama-tier1 dominates the first bench's wall clock: its mean latency in the
recall screen was 27298 ms versus flash's near-instant cache-warm reads, and
that shows up directly in the mean `wallMs` per puzzle below.

Both `xw bench` invocations printed a final summary table
(profile / n / letters / words / perfect / usd per puzzle / usd per correct
word); both are reproduced, with the per-stratum breakdown the summary table
does not carry, below.

## Results per arm and stratum

`letters`/`words`/`perfect` are `aggregate()`'s means (`src/eval/aggregate.ts`);
`usd/puzzle` and `usd/correct word` both use `usdCounterfactual`, per B2 and
the spec's cost-accounting rule.

### American stratum (8 puzzles)

| arm | repeats | n | letters (sd) | words | perfect | usd/puzzle (cf) | usd/correct word | tier-2 share | mean wall ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| flash-tier1 | 3 | 24 | 0.8001 (0.1386) | 0.6293 | 0.0000 | 0.026131 | 0.000543 | 0.0509 | 131936 |
| llama-tier1 | 3 | 24 | 0.7513 (0.2012) | 0.6043 | 0.0000 | 0.037297 | 0.000804 | 0.0516 | 412581 |
| strong-only | 1 | 8 | 0.9285 (0.0664) | 0.8446 | 0.2500 | 0.183053 | 0.002860 | 0.0000 | 95294 |
| tier1-only | 1 | 8 | 0.4085 (0.1353) | 0.2394 | 0.0000 | 0.012683 | 0.000690 | 0.0000 | 5139 |
| baseline-pv2 (E) | 3 | 24 | 0.5786 (0.1644) | 0.3669 | 0.0000 | 0.053346 | 0.001894 | 0.1395 | 70390 |

### Cryptic stratum (4 puzzles)

| arm | repeats | n | letters (sd) | words | perfect | usd/puzzle (cf) | usd/correct word | tier-2 share | mean wall ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| flash-tier1 | 3 | 12 | 0.1642 (0.0895) | 0.0623 | 0.0000 | 0.027296 | 0.014889 | 0.1208 | 57290 |
| llama-tier1 | 3 | 12 | 0.1494 (0.0727) | 0.0344 | 0.0000 | 0.029696 | 0.029696 | 0.0976 | 307780 |
| strong-only | 1 | 4 | 0.2626 (0.1834) | 0.1283 | 0.0000 | 0.113829 | 0.030354 | 0.0000 | 87187 |
| tier1-only | 1 | 4 | 0.0781 (0.0157) | 0.0000 | 0.0000 | 0.007339 | 0.000000 | 0.0000 | 9070 |
| baseline-pv2 (E) | 3 | 12 | 0.1633 (0.0981) | 0.0515 | 0.0000 | 0.037875 | 0.025250 | 0.1763 | 53411 |

### All 12 puzzles

| arm | repeats | n | letters (sd) | words | perfect | usd/puzzle (cf) | usd/correct word | tier-2 share | mean wall ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| flash-tier1 | 3 | 36 | 0.5881 (0.3280) | 0.4403 | 0.0000 | 0.026519 | 0.000810 | 0.0669 | 107054 |
| llama-tier1 | 3 | 36 | 0.5507 (0.3333) | 0.4143 | 0.0000 | 0.034764 | 0.001111 | 0.0623 | 377648 |
| strong-only | 1 | 12 | 0.7066 (0.3456) | 0.6058 | 0.1667 | 0.159978 | 0.003643 | 0.0000 | 92591 |
| tier1-only | 1 | 12 | 0.2983 (0.1954) | 0.1596 | 0.0000 | 0.010901 | 0.000890 | 0.0000 | 6449 |
| baseline-pv2 (E) | 3 | 36 | 0.4402 (0.2453) | 0.2617 | 0.0000 | 0.048189 | 0.002500 | 0.1478 | 64730 |

Cryptic stratum is reported for completeness only, per the recall screen's
and the escalation-policy bench's convention: the decision rule below uses
the american stratum only.

## Noise floor (three-repeat arms only)

Mean, across a stratum's puzzles, of each puzzle's sample standard deviation
of letters accuracy across its three repeats - same puzzle, same profile,
sampling noise only (the same definition escalation-policy.md uses).

| arm | american | cryptic | all 12 |
| --- | --- | --- | --- |
| flash-tier1 | 0.0463 | 0.0280 | 0.0402 |
| llama-tier1 | 0.0315 | 0.0393 | 0.0341 |
| baseline-pv2 (E) | 0.0501 | 0.0735 | 0.0579 |

The baseline-pv2 figures reproduce escalation-policy.md's "baseline-pv2 (v2)
noise floor" row exactly (0.0501 / 0.0735 / 0.0579), confirming this
analysis's formulas against that document's independently-computed numbers.

## Paired comparison against the reused baseline arm (american stratum, letters)

Per puzzle, the difference of each arm's repeat-mean letters accuracy (mean
of 3 repeats) minus arm E's repeat-mean on the same puzzle; then the mean,
sample standard deviation, standard error and paired t-statistic of those 8
per-puzzle differences (df = 7), same method as escalation-policy.md's v3-vs-v2
comparison.

**flash-tier1 minus baseline-pv2 (n = 8 puzzles):** mean diff = +0.2215,
paired sd = 0.0773, paired se = 0.0273, t(7) = 8.111, 95% CI (0.1569, 0.2861).
The CI excludes zero by a wide margin and the magnitude (0.2215) is about
4.4x to 4.8x either arm's own noise floor (0.0463, 0.0501).

Repeat-level win count (of the 24 paired repeats: 8 puzzles x 3 repeats,
matched by repeat index): flash-tier1 won 24 of 24, baseline-pv2 won 0, no
ties.

**llama-tier1 minus baseline-pv2 (n = 8 puzzles):** mean diff = +0.1728,
paired sd = 0.0896, paired se = 0.0317, t(7) = 5.452, 95% CI (0.0978, 0.2477).
The CI excludes zero and the magnitude (0.1728) is about 3.4x to 5.5x either
arm's noise floor (0.0315, 0.0501).

Repeat-level win count: llama-tier1 won 23 of 24, baseline-pv2 won 1, no
ties.

Both differences are real, not sampling noise: their magnitudes clear the
relevant noise floors by a wide margin and both 95% CIs sit entirely above
zero. Both new tier-1 candidates beat the current default's promptVersion-2
letters accuracy on almost every paired repeat, not just on average.

## Generation metrics per arm

All 12 puzzles; slot counts are `727 x repeats` (2181 for the three-repeat
arms, 727 for strong-only and tier1-only).

| arm | n slots | truth-in-candidates | mean candidatesSeen | conversion (correct given truth present) | tier-1 fill correctness | escalations/puzzle | mean reasks/slot | cap hits |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| flash-tier1 | 2181 | 0.7134 | 2.95 | 0.7237 | 0.7799 | 7.00 | 0.12 | 0 |
| llama-tier1 | 2181 | 0.6447 | 2.34 | 0.7511 | 0.7537 | 6.56 | 0.13 | 0 |
| strong-only | 727 | 0.8102 | 4.21 | 0.8642 | 0.8956 | 4.08 | 0.08 | 0 |
| tier1-only | 727 | 0.3274 | 2.07 | 0.5882 | 0.4430 | 0.00 | 0.13 | 0 |
| baseline-pv2 (E) | 2181 | 0.4801 | 2.78 | 0.6074 | 0.5102 | 16.94 | 0.12 | 2 |

(`tier1-only`'s 0.00 escalations/puzzle is exact, not rounded: its profile
sets `maxTier2CallsPerPuzzle: 0`, so it never escalates by construction - the
expected sanity check for the floor arm.)

American stratum only (612 x repeats slots):

| arm | n slots | truth-in-candidates | mean candidatesSeen | conversion | tier-1 fill correctness | escalations/puzzle | mean reasks/slot | cap hits |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| flash-tier1 | 1836 | 0.8083 | 2.82 | 0.7439 | 0.8503 | 6.17 | 0.11 | 0 |
| llama-tier1 | 1836 | 0.7456 | 2.32 | 0.7626 | 0.8361 | 6.25 | 0.10 | 0 |
| strong-only | 612 | 0.9101 | 3.99 | 0.8905 | 0.9555 | 3.50 | 0.07 | 0 |
| tier1-only | 612 | 0.3856 | 2.08 | 0.5932 | 0.5072 | 0.00 | 0.12 | 0 |
| baseline-pv2 (E) | 1836 | 0.5452 | 2.69 | 0.6184 | 0.5769 | 18.54 | 0.10 | 2 |

Both new tier-1 candidates beat the current default (E) on truth-in-candidates
share, conversion and tier-1 fill correctness on the american stratum, while
escalating to tier-2 about a third as often per puzzle (6.17-6.25 versus
18.54): the swap improves tier-1's own answer quality enough that the search
needs tier-2 help less, not just that tier-2 is picking up more slack.
flash-tier1's american-stratum truth-in-candidates share here (0.8083) is
close to, and slightly higher than, the recall screen's single-ask figure for
the same model (0.7647): the full pipeline's re-asks add a second chance per
slot that the seed-only screen does not have.

## Cost versus accuracy, all five arms (american stratum)

| arm | letters | usd/puzzle (cf) | usd/correct word |
| --- | --- | --- | --- |
| flash-tier1 | 0.8001 | 0.026131 | 0.000543 |
| llama-tier1 | 0.7513 | 0.037297 | 0.000804 |
| strong-only | 0.9285 | 0.183053 | 0.002860 |
| tier1-only | 0.4085 | 0.012683 | 0.000690 |
| baseline-pv2 (E) | 0.5786 | 0.053346 | 0.001894 |

Ordering by letters accuracy: strong-only (ceiling) > flash-tier1 >
llama-tier1 > baseline-pv2 (current default) > tier1-only (floor). Ordering
by usd per correct word (cheapest first): flash-tier1 < tier1-only <
llama-tier1 < baseline-pv2 < strong-only. flash-tier1 is both more accurate
and cheaper per puzzle than the current default (E): 0.026131 versus
0.053346 usd/puzzle, about 49% of the current default's per-puzzle cost, for
+0.2215 letters accuracy.

## Decision

Rule (as specified for this bench): choose the tier-1 model with the best
letters on the american stratum whose counterfactual cost per correct word is
not more than 1.5x the cheapest arm's. The candidates for this choice are the
two tier-1 swaps under test (flash-tier1, llama-tier1) and the current
default, represented by arm E (baseline-pv2's tier-1 is the same
nvidia/Nemotron-3_5-Lightning model as tier1-only, but with escalation
enabled, so E rather than D is the live comparison point); strong-only and
tier1-only are the ceiling and floor references, not candidates for this
choice.

Cheapest of the three candidates by usd/correct word (american): flash-tier1
at $0.000543. 1.5x that threshold is $0.0008145.

| candidate | usd/correct word | <= 1.5x cheapest ($0.0008145) | letters |
| --- | --- | --- | --- |
| flash-tier1 | 0.000543 | yes | 0.8001 |
| llama-tier1 | 0.000804 | yes (98.7% of the threshold) | 0.7513 |
| baseline-pv2 (current default) | 0.001894 | no (3.49x the cheapest; 2.33x the threshold) | 0.5786 |

Both flash-tier1 and llama-tier1 clear the cost gate; the current default
does not. Applying the rule, the eligible arm with the best letters wins:

**Winner: deepseek-ai/DeepSeek-V4-Flash-0731 as tier1** (the `flash-tier1`
profile). It has both the best letters accuracy of the three candidates
(0.8001) and the lowest cost per correct word (0.000543), so the 1.5x
cost gate does not need to override the accuracy ranking here - flash-tier1
would win on either criterion alone.

**Distance from the strong-only ceiling:** flash-tier1's letters accuracy
(0.8001) is 0.1284 below strong-only's ceiling (0.9285), while spending about
14.3% of strong-only's usd/puzzle (0.026131 / 0.183053). Against the
tier1-only floor (0.4085) and the strong-only ceiling (0.9285), flash-tier1
captures (0.8001 - 0.4085) / (0.9285 - 0.4085) = 75.3% of that letters-accuracy
range.

**Recommendation:** swap the tier-1 default from nvidia/Nemotron-3_5-Lightning
to deepseek-ai/DeepSeek-V4-Flash-0731. On this measurement it is both more
accurate (+0.2215 letters, a paired, noise-floor-clearing difference,
95% CI 0.1569 to 0.2861) and cheaper per puzzle (about half the cost) than
the current default, on the american stratum.

## Caveats

- **Repeat counts differ across arms.** flash-tier1, llama-tier1 and the
  reused baseline-pv2 (E) are three-repeat measurements with noise floors and
  paired statistics; strong-only (ceiling) and tier1-only (floor) are single
  point estimates with no confidence interval, included as brackets rather
  than as paired-tested candidates.
- **Single-repeat ceiling and floor.** strong-only's 0.9285 and tier1-only's
  0.4085 american letters figures could each land anywhere within roughly one
  noise-floor-width of these numbers on a repeat; they are useful as an
  ordering check (are the two candidates plausibly between the floor and
  ceiling? yes) rather than as precise anchors.
- **Cache cold for the new models.** Neither deepseek-ai/DeepSeek-V4-Flash-0731
  nor meta-llama/Llama-3.3-70B-Instruct had prior tier-1 puzzle-level runs on
  this puzzle set before this bench (the recall screen's cache entries are
  seed-pass, empty-pattern asks, a different cache key shape from a real
  solve's populated-pattern re-asks), so both arms paid full price for every
  call; the pre-flight estimate's undershoot (see "Command, pre-flight
  estimate and spend") is consistent with this.
- **HEAD advanced during the run.** The container bind-mounts `main`, and an
  unrelated concurrent task merged work partway through this bench's 2h36m
  wall clock (a recall-screen addition and T68's router reasoning-effort
  fallback). Run-record `provenance.gitCommit` values span four commits:
  `5b312a03e12b6da261df3f26dd478420223f3954` (the commit this bench started
  at), `c9218916d78f062b4c6563ab42ff726c5e819963`,
  `9a6965e89614f6a29836ca460e3e2a5964a62033`, and
  `4f7298652bfcef4eebfadfe26a7f237454ad8f3f` (the great majority of records:
  32/36 flash-tier1, 33/36 llama-tier1, and all 24 of strong-only and
  tier1-only, which started later). T68's change is a router fallback for
  models whose Harmony template rejects `reasoning_effort=none`; neither
  flash-tier1 (which already accepts `none`, confirmed in the recall screen)
  nor llama-tier1 (which does not advertise `reasoning` at all) exercises
  that code path, so this is very unlikely to have affected either arm's
  numbers, but it means this bench was not run against one single fixed
  commit throughout.
- **llama-tier1's wall clock is high** (mean 412581 ms per puzzle on the
  american stratum, versus flash-tier1's 131936 ms), consistent with the
  recall screen's observation that meta-llama/Llama-3.3-70B-Instruct's mean
  latency there (27298 ms) was dominated by a handful of retried calls; this
  bench's wall-clock figures inherit the same effect at a puzzle level rather
  than a per-call one.
- **usd/correct word for zero-perfect, low-word-accuracy arms** (all arms
  here except strong-only have a 0.0000 perfect-puzzle rate on both strata)
  is comparing a cost basis with no arm at "solved," so this table is a
  relative efficiency ranking among partial fills, not a statement about
  finished puzzles.
- This bench measures the full pipeline's outcome, not the mechanism inside
  it; the generation-metrics table describes correlated changes (higher
  truth-in-candidates, higher conversion, fewer escalations) but, as with
  escalation-policy.md's equivalent section, does not establish which of
  those is causal.
