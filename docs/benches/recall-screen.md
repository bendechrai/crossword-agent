# Seed-only candidate recall screen

Date: 2026-09-05
Commit: 5b312a03e12b6da261df3f26dd478420223f3954 (main)
Set: sets/modern-12.json (modern-12: 8 american, 4 cryptic; 727 slots total, 612 american, 115 cryptic)

## Method

- Seed pass only: one tier-1 ask per slot with the empty pattern, through the
  real CandidateService, disk cache and inference log. No AC-3, no search, no
  re-ask, no escalation, no repair, and nothing assigned to a grid.
- promptVersion 2 templates (the current default; see docs/benches/README.md,
  escalation-policy bench, for the promptVersion 2 vs 3 comparison).
- Reasoning off: `reasoning_effort=none` applied by the router to every model
  that advertises `reasoning` in models.json, except where the provider
  rejects that value outright (see Failures below).
- Structured outputs used (`response_format.json_schema`) for every model
  advertising `structured_outputs`; an inline schema in the prompt otherwise.
- One repeat (`--repeat 1`, the default).
- Concurrency 2 within a model (puzzles run two at a time); models run
  strictly one after another so the per-model rate limiter is never shared
  between two models at once.
- openai/gpt-oss-120b's run used the T68 router fix (commit
  c9218916d78f062b4c6563ab42ff726c5e819963), run separately on 2026-09-05
  after the other eight models. The other eight models' numbers below are
  unchanged from the original run at commit 5b312a03e12b6da261df3f26dd478420223f3954.
  Both commits use the same promptVersion 2 templates; the only difference
  relevant to this screen is that the T68 router maps openai/gpt-oss-120b to
  `reasoning_effort=low` instead of the `reasoning_effort=none` every other
  reasoning-capable model gets, since gpt-oss-120b's Harmony response
  template rejects `none` (see Failures).

## Pre-flight estimate and spend

- Initial pre-flight estimate, the 10 requested models (the 8 that completed
  plus nvidia/Nemotron-3-Nano-Omni and openai/gpt-oss-120b): 727 slots x 10
  models x 1 repeat = 7270 calls, estimate ~$5.882157, under the $10
  `--max-usd` ceiling, so the script proceeded without `--yes`.
- Final successful run's own pre-flight estimate, 8 models after excluding
  the two failed models: 727 slots x 8 models x 1 repeat = 5816 calls,
  estimate ~$5.592084.
- Actual spend for the eight-model exercise (summed from the inference log's
  `recall--` run records across every attempt today, cache hits counted at
  $0 billed): $3.301222 billed, $4.038434 counterfactual (what a fully cold
  run would have cost with no cache reuse). Both are within the $10
  authorization and close to the ~$5.40 catalogue estimate given beforehand.
- openai/gpt-oss-120b was screened separately after T68 with
  `--max-usd 2 --out logs/recall-gptoss`: pre-flight estimate 727 slots x 1
  model x 1 repeat = 727 calls, ~$0.207195. Actual spend, all calls fresh
  (no cache hits): **$0.212628 billed, $0.212628 counterfactual**.
- Combined actual spend across all nine screened models: **$3.513850
  billed**, **$4.251062 counterfactual**. Both remain well within the $10
  authorization.
- Cache reuse: nvidia/Nemotron-3_5-Lightning, the current tier-1, was already
  fully warm from earlier bench runs before this screen started. All 2908 of
  its calls across today's attempts were cache hits at $0 billed; its numbers
  below are a re-read of an existing promptVersion-2 seed pass, not a fresh
  sample.

## Failures

- **openai/gpt-oss-120b: screened after T68.** At the original run's commit
  (5b312a03e12b6da261df3f26dd478420223f3954), the router applied
  `reasoning_effort=none` to every model advertising `reasoning` (tier-1 seed
  pass), and gpt-oss-120b's Harmony response template only accepts `low`,
  `medium`, or `high` for that parameter, so its first call returned HTTP 400
  and the whole run aborted. T68 (commit
  c9218916d78f062b4c6563ab42ff726c5e819963) fixed the router to map
  openai/gpt-oss-120b to `reasoning_effort=low`, and a rerun with that fix
  completed cleanly: all 807 inference-log records for this model today
  (727 slots plus 80 retried attempts) show `httpStatus 200`, `error: null`,
  and `extra.reasoning_effort: "low"` - no 400s and no fallback retries at
  the provider level. Its results appear in every table and the ranking
  below.
- **nvidia/Nemotron-3-Nano-Omni: not screened.** Today's inference log
  (logs/inference/2026-09-05.jsonl, 19,340+ records) contains zero records
  for this model, so there is no httpStatus or error body to cite. The model
  produced no completed calls during this screen, the aborted attempt's log
  was not preserved, and the cause of the failure is unconfirmed.
- Because `scripts/eval-recall.ts` aborts the entire matrix on the first
  provider error rather than continuing to the next model, both original
  failures required removing the offending model from `--models` and
  rerunning, not a single run that skipped past them. nvidia/Nemotron-3-Nano-Omni
  remains absent from every table, the ranking, and the carry decision below.

## Results

### All puzzles (12)

| model | slots | truth-in-candidates | top-1 | mean cand seen | mean raw cand | length-error share | parse-fail rate | zero-cand share | mean latency ms | usd/puzzle (cf) | usd/puzzle (billed) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| deepseek-ai/DeepSeek-V4-Pro | 727 | 0.7978 | 0.7180 | 3.87 | 5.52 | 0.9050 | 0.0000 | 0.0303 | 4987 | 0.098231 | 0.098231 |
| zai-org/GLM-5.1 | 727 | 0.6864 | 0.6327 | 1.82 | 2.59 | 0.9498 | 0.0000 | 0.1087 | 3421 | 0.063165 | 0.063165 |
| deepseek-ai/DeepSeek-V4-Flash-0731 | 727 | 0.6726 | 0.6080 | 2.27 | 3.48 | 0.8773 | 0.0000 | 0.0688 | 0 | 0.006615 | 0.000000 |
| openai/gpt-oss-120b | 727 | 0.6369 | 0.5337 | 2.98 | 3.71 | 0.7245 | 0.0880 | 0.1004 | 1394 | 0.017719 | 0.017719 |
| meta-llama/Llama-3.3-70B-Instruct | 727 | 0.6080 | 0.5420 | 1.93 | 2.18 | 0.8610 | 0.0014 | 0.0509 | 27298 | 0.012278 | 0.000220 |
| Qwen/Qwen3.5-397B-A17B | 727 | 0.6107 | 0.5227 | 2.47 | 2.77 | 0.7523 | 0.0041 | 0.0674 | 2358 | 0.077882 | 0.077882 |
| Qwen/Qwen3-235B-A22B-Instruct-2507 | 727 | 0.4759 | 0.4030 | 1.97 | 3.08 | 0.9081 | 0.0000 | 0.1183 | 0 | 0.010108 | 0.000000 |
| nvidia/Nemotron-3_5-Lightning | 727 | 0.3232 | 0.2586 | 1.65 | 3.39 | 0.9036 | 0.0000 | 0.2338 | 0 | 0.006547 | 0.000000 |
| Qwen/Qwen3-30B-A3B-Instruct-2507 | 727 | 0.3136 | 0.2586 | 2.47 | 7.04 | 0.8306 | 0.0000 | 0.1843 | 0 | 0.006465 | 0.000000 |

### American stratum (8 puzzles, 612 slots)

| model | slots | truth-in-candidates | top-1 | mean cand seen | mean raw cand | length-error share | parse-fail rate | zero-cand share | mean latency ms | usd/puzzle (cf) | usd/puzzle (billed) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| deepseek-ai/DeepSeek-V4-Pro | 612 | 0.8971 | 0.8072 | 3.75 | 5.39 | 0.9284 | 0.0000 | 0.0098 | 4965 | 0.122258 | 0.122258 |
| zai-org/GLM-5.1 | 612 | 0.7974 | 0.7337 | 2.03 | 2.88 | 0.9464 | 0.0000 | 0.0686 | 3207 | 0.080683 | 0.080683 |
| deepseek-ai/DeepSeek-V4-Flash-0731 | 612 | 0.7647 | 0.6928 | 2.31 | 3.51 | 0.8837 | 0.0000 | 0.0490 | 0 | 0.008305 | 0.000000 |
| openai/gpt-oss-120b | 612 | 0.7320 | 0.6176 | 3.19 | 3.84 | 0.7357 | 0.0114 | 0.0196 | 1074 | 0.018064 | 0.018064 |
| meta-llama/Llama-3.3-70B-Instruct | 612 | 0.7092 | 0.6340 | 2.02 | 2.24 | 0.8603 | 0.0016 | 0.0343 | 27298 | 0.015500 | 0.000330 |
| Qwen/Qwen3.5-397B-A17B | 612 | 0.7092 | 0.6046 | 2.73 | 3.04 | 0.7382 | 0.0049 | 0.0425 | 2463 | 0.100282 | 0.100282 |
| Qwen/Qwen3-235B-A22B-Instruct-2507 | 612 | 0.5523 | 0.4706 | 2.07 | 3.13 | 0.9219 | 0.0000 | 0.0915 | 0 | 0.012733 | 0.000000 |
| nvidia/Nemotron-3_5-Lightning | 612 | 0.3807 | 0.3056 | 1.77 | 3.41 | 0.8956 | 0.0000 | 0.1961 | 0 | 0.008251 | 0.000000 |
| Qwen/Qwen3-30B-A3B-Instruct-2507 | 612 | 0.3627 | 0.3023 | 2.59 | 7.08 | 0.8444 | 0.0000 | 0.1536 | 0 | 0.008142 | 0.000000 |

### Cryptic stratum (4 puzzles, 115 slots)

Reported for completeness only; per the README's decision rule the cryptic
stratum does not enter the ranking or the carry decision.

| model | slots | truth-in-candidates | top-1 | mean cand seen | mean raw cand | length-error share | parse-fail rate | zero-cand share | mean latency ms | usd/puzzle (cf) | usd/puzzle (billed) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| deepseek-ai/DeepSeek-V4-Pro | 115 | 0.2696 | 0.2435 | 4.53 | 6.22 | 0.7835 | 0.0000 | 0.1391 | 5104 | 0.050178 | 0.050178 |
| zai-org/GLM-5.1 | 115 | 0.0957 | 0.0957 | 0.74 | 1.05 | 1.0000 | 0.0000 | 0.3217 | 4559 | 0.028130 | 0.028130 |
| deepseek-ai/DeepSeek-V4-Flash-0731 | 115 | 0.1826 | 0.1565 | 2.02 | 3.31 | 0.8456 | 0.0000 | 0.1739 | 0 | 0.003234 | 0.000000 |
| openai/gpt-oss-120b | 115 | 0.1304 | 0.0870 | 1.90 | 3.02 | 0.6899 | 0.4957 | 0.5304 | 3101 | 0.017029 | 0.017029 |
| meta-llama/Llama-3.3-70B-Instruct | 115 | 0.0696 | 0.0522 | 1.43 | 1.88 | 0.8627 | 0.0000 | 0.1391 | 0 | 0.005834 | 0.000000 |
| Qwen/Qwen3.5-397B-A17B | 115 | 0.0870 | 0.0870 | 1.10 | 1.33 | 0.8519 | 0.0000 | 0.2000 | 1799 | 0.033081 | 0.033081 |
| Qwen/Qwen3-235B-A22B-Instruct-2507 | 115 | 0.0696 | 0.0435 | 1.46 | 2.78 | 0.8487 | 0.0000 | 0.2609 | 0 | 0.004857 | 0.000000 |
| nvidia/Nemotron-3_5-Lightning | 115 | 0.0174 | 0.0087 | 1.03 | 3.30 | 0.9346 | 0.0000 | 0.4348 | 0 | 0.003140 | 0.000000 |
| Qwen/Qwen3-30B-A3B-Instruct-2507 | 115 | 0.0522 | 0.0261 | 1.88 | 6.81 | 0.7637 | 0.0000 | 0.3478 | 0 | 0.003111 | 0.000000 |

## Ranking and decision

Decision rule, quoted verbatim from the recall-screen subsection of
docs/benches/README.md:

> **Decision rule (american stratum only):** rank models by truth-in-candidates
> share on the american stratum, then by USD per puzzle. Carry the top three,
> plus the current tier-1 model, into the puzzle-level bench. Report the cryptic
> stratum alongside but do not decide on it - it is the smaller half of every
> set and the hardest for generation, so it moves the ranking on noise. A model
> the set gave no american slots cannot be ranked by this rule and sorts after
> every model that can be.

| rank | model | american truth-in-candidates | overall truth-in-candidates | usd/puzzle (cf) | carry |
| --- | --- | --- | --- | --- | --- |
| 1 | deepseek-ai/DeepSeek-V4-Pro | 0.8971 | 0.7978 | 0.098231 | yes |
| 2 | zai-org/GLM-5.1 | 0.7974 | 0.6864 | 0.063165 | yes |
| 3 | deepseek-ai/DeepSeek-V4-Flash-0731 | 0.7647 | 0.6726 | 0.006615 | yes |
| 4 | openai/gpt-oss-120b | 0.7320 | 0.6369 | 0.018064 | no |
| 5 | meta-llama/Llama-3.3-70B-Instruct | 0.7092 | 0.6080 | 0.012278 | no |
| 6 | Qwen/Qwen3.5-397B-A17B | 0.7092 | 0.6107 | 0.077882 | no |
| 7 | Qwen/Qwen3-235B-A22B-Instruct-2507 | 0.5523 | 0.4759 | 0.010108 | no |
| 8 | nvidia/Nemotron-3_5-Lightning | 0.3807 | 0.3232 | 0.006547 | no |
| 9 | Qwen/Qwen3-30B-A3B-Instruct-2507 | 0.3627 | 0.3136 | 0.006465 | no |

Top three by the decision rule: deepseek-ai/DeepSeek-V4-Pro,
zai-org/GLM-5.1, deepseek-ai/DeepSeek-V4-Flash-0731. openai/gpt-oss-120b
ranks 4th of 9, just behind the top three and just ahead of
meta-llama/Llama-3.3-70B-Instruct and Qwen/Qwen3.5-397B-A17B; it does not
displace any of the top three.

The current tier-1, nvidia/Nemotron-3_5-Lightning, ranks 8th of 9 on the
american stratum and is **not** among the top three on this screen's numbers.
Per the README's rule it still carries into the puzzle-level bench alongside
the top three, since the rule names it explicitly regardless of rank.

**Carry forward:** deepseek-ai/DeepSeek-V4-Pro, zai-org/GLM-5.1,
deepseek-ai/DeepSeek-V4-Flash-0731, nvidia/Nemotron-3_5-Lightning.

## Cost-efficiency view (truth-in-candidates share per usd per puzzle)

Not part of the README's decision rule; provided as an additional lens on
the same numbers.

| model | american truth-in-candidates | american usd/puzzle | american efficiency (truth/usd) | overall efficiency (truth/usd) |
| --- | --- | --- | --- | --- |
| deepseek-ai/DeepSeek-V4-Pro | 0.8971 | 0.122258 | 7.34 | 8.12 |
| zai-org/GLM-5.1 | 0.7974 | 0.080683 | 9.88 | 10.87 |
| deepseek-ai/DeepSeek-V4-Flash-0731 | 0.7647 | 0.008305 | 92.08 | 101.69 |
| openai/gpt-oss-120b | 0.7320 | 0.018064 | 40.52 | 35.94 |
| meta-llama/Llama-3.3-70B-Instruct | 0.7092 | 0.015500 | 45.75 | 49.52 |
| Qwen/Qwen3.5-397B-A17B | 0.7092 | 0.100282 | 7.07 | 7.84 |
| Qwen/Qwen3-235B-A22B-Instruct-2507 | 0.5523 | 0.012733 | 43.37 | 47.09 |
| nvidia/Nemotron-3_5-Lightning | 0.3807 | 0.008251 | 46.14 | 49.37 |
| Qwen/Qwen3-30B-A3B-Instruct-2507 | 0.3627 | 0.008142 | 44.55 | 48.51 |

deepseek-ai/DeepSeek-V4-Flash-0731 is both in the top three by
truth-in-candidates and by far the most cost-efficient of every model
screened, roughly 9x to 12x as efficient as the other two top-three models,
since it is priced far below deepseek-ai/DeepSeek-V4-Pro and zai-org/GLM-5.1
while still recalling the truth on over three-quarters of american slots.

## Structured-output support and rate limits

From models.json, for every model in the ranking above.

| model | structured outputs | reasoning-capable | rpm |
| --- | --- | --- | --- |
| deepseek-ai/DeepSeek-V4-Pro | yes | yes | 3000 |
| zai-org/GLM-5.1 | yes | yes | 1000 |
| deepseek-ai/DeepSeek-V4-Flash-0731 | yes | yes | 3000 |
| meta-llama/Llama-3.3-70B-Instruct | no (inline schema) | no | 1200 |
| Qwen/Qwen3.5-397B-A17B | no (inline schema) | yes | 600 |
| Qwen/Qwen3-235B-A22B-Instruct-2507 | yes | no | 600 |
| nvidia/Nemotron-3_5-Lightning | no (inline schema) | yes | 600 |
| Qwen/Qwen3-30B-A3B-Instruct-2507 | yes | no | 600 |

All three carried models beyond the current tier-1 advertise
`structured_outputs`, so their answers are constrained server-side rather
than relying on the model to honor an inline schema in the prompt; the
current tier-1 does not have this and gets an inline schema instead.

## Caveats

- One repeat only (`--repeat 1`); every number above is a single point
  estimate with no confidence interval.
- This measures recall, not accuracy: a slot with the truth "in candidates"
  can still fail downstream, at search, calibration, or repair.
- nvidia/Nemotron-3_5-Lightning's numbers come almost entirely from cache
  (0 of 727 calls this session reached the provider); today's measurement is
  a re-read of an earlier warm promptVersion-2 seed pass, not a fresh sample,
  though the cache keys are the same ones a fresh run would produce.
- nvidia/Nemotron-3-Nano-Omni was not screened (see Failures) and is absent
  from every table, the ranking, and the carry decision.
- openai/gpt-oss-120b's row uses the T68 router fix (`reasoning_effort=low`,
  commit c9218916d78f062b4c6563ab42ff726c5e819963) and was run separately
  from the other eight, which used commit
  5b312a03e12b6da261df3f26dd478420223f3954. The two runs are not from the
  identical commit, though only the reasoning-effort value differs for this
  one model; see Method.
- meta-llama/Llama-3.3-70B-Instruct shows a much higher mean latency (27298
  ms) than every other model; this is dominated by a handful of retried
  calls rather than being representative of its typical response time.

## Next

Carry deepseek-ai/DeepSeek-V4-Pro, zai-org/GLM-5.1,
deepseek-ai/DeepSeek-V4-Flash-0731, and the current tier-1
nvidia/Nemotron-3_5-Lightning into the puzzle-level bench
(docs/benches/README.md, escalation-policy and batch-size benches), run with
`--repeat 3` so the comparison has a confidence interval rather than a single
point estimate.
