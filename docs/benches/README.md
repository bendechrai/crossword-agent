# Benchmark results

This directory holds committed benchmark reports, produced by `xw report --md` after each bench run.

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
(To be filled by a bench run)

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
