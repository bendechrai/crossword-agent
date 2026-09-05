# M2 spike: tier-1 reliability (T49)

Run window: 2026-09-03T11:59:27.669Z to 2026-09-03T12:03:10.145Z. Model under test: `nvidia/Nemotron-3_5-Lightning` (tier 1). All numbers below come from a real run against the live Nebius Token Factory API, through the real `src/llm/client.ts` transport and the real inference log at `logs/inference/` (not committed, per B47); this document is a query over that log plus the parser (`src/llm/parser.ts`) run against each captured response.

Total spend: **USD 0.0199** (0.0192 from the run below, plus ~0.0007 for the one follow-up call described in section 2; budget cap was USD 0.50).

## 1. Reasoning-off parameter

Candidates were tried on the same clue ("Large striped Asian big cat", 5 letters) and compared by the `reasoningTokens` field the transport reads out of the usage blob (`completion_tokens_details.reasoning_tokens`).

| Candidate | Outcome | reasoningTokens | completionTokens | latencyMs |
| --- | --- | ---: | ---: | ---: |
| control (no extra param) | accepted | 512 | 1024 | 2336 |
| shipped placeholder reasoning_effort=true | rejected: Nebius transport: nvidia/Nemotron-3_5-Lightning returned HTTP 422: HTTP 422 | - | - | - |
| reasoning_effort="none" | accepted | 0 | 73 | 782 |
| reasoning_effort="low" | accepted | 512 | 1024 | 2243 |
| chat_template_kwargs.thinking=false | accepted | 512 | 1024 | 2902 |
| chat_template_kwargs.enable_thinking=false | accepted | 0 | 73 | 569 |
| enable_thinking=false (top level) | accepted | 512 | 1024 | 2407 |
| reasoning={"effort":"low"} | accepted | 512 | 1024 | 2367 |

**Finding: the parameter is `reasoning_effort`, and the value that turns reasoning off is the string `"none"`.** `{"reasoning_effort":"none"}` reduced `reasoningTokens` from 512 (control) to 0, and cut `completionTokens` from 1024 to 73 and latency from ~2.3s to ~0.8s in the same trial. This is confirmed twice over: empirically by the `reasoningTokens` comparison in the table above, and independently by Nebius's own request-validation error. The rejected placeholder call (`reasoning_effort: true`, a boolean) came back HTTP 422 with a body naming the accepted values verbatim:

```json
{"type":"literal_error","loc":["body","reasoning_effort","literal['none','minimal','low','medium','high','xhigh']"],
 "msg":"Input should be 'none', 'minimal', 'low', 'medium', 'high' or 'xhigh'","input":true}
```

(a second `literal['max']` error is also present - Nebius validates `reasoning_effort` against two literal unions and reports both misses). So the full accepted value set is `"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`, and `"none"` is the one that measurably disables reasoning. `src/llm/tierRouter.ts` is updated to emit `{ reasoning_effort: 'none' }` in place of the `reasoning_effort: true` placeholder, gated the same way (only `purpose: "seed"` on a `reasoning`-capable model) - see the diff in that file for the exact change.

## 2. Tier-2 `response_format.json_schema` wrapper shape

| Shape | Outcome | Parsed OK |
| --- | --- | --- |
| current: response_format.json_schema = raw schema doc | rejected: HTTP 422 (`response_format.json_schema.name`: "Field required", plus the same `reasoning_effort` error as above) | - |
| wrapped: response_format.json_schema = { name, schema, strict } | rejected: HTTP 422 (`reasoning_effort` error only - no `json_schema`/`response_format` error of any kind) | - |

Both of these two trials also carried the broken `reasoning_effort: true` placeholder (tier 2's `deepseek-ai/DeepSeek-V4-Pro` advertises `reasoning` too, so `route()` sets it there as well), which confounded the result at the time: neither trial could reach a real completion. But the two 422 bodies are conclusive on their own, because Nebius's request validator reports **every** field error it finds in one pass, not just the first:

- The current (unwrapped) shape's error list names `response_format.json_schema.name` as a missing required field, in addition to the `reasoning_effort` error. **Finding: Nebius requires `response_format.json_schema` to carry a `name`, i.e. it does not accept the raw schema document directly.**
- The wrapped shape's error list contains only the `reasoning_effort` error - no complaint anywhere under `response_format` or `json_schema`. **Finding: `{ type: "json_schema", json_schema: { name, schema, strict } }` passes Nebius's request validation.**

A follow-up call (same run, budget USD 0.0192 -> 0.0197) with both fixes applied together - `reasoning_effort: "none"` and the wrapped schema - confirmed this is not just request-validation-clean but produces a real, correctly-parsed completion:

```
HTTP 200. latencyMs=1272 usage={"promptTokens":292,"completionTokens":52,"totalTokens":344}
text: {
  "clue_understood": 1.0,
  "candidates": [ { "answer": "ICE", "confidence": 1.0 } ],
  "notes": "Direct definition."
}
parsed ok: true, failures: []
```

`src/llm/tierRouter.ts` is updated accordingly: `response_format.json_schema` is now `{ name: "candidate_response", schema: <the schema document>, strict: true }` instead of the raw schema document.

## 3. Rate limit headers

Every distinct response header name observed across all phases of this run (discovery, schema probe, burst probe, and the 200-clue measurement). Header names are as returned by `fetch`, lower-cased. Per the task note, only `x-ratelimit-*` and `retry-after` carry an example value here; every other header is confirmed present but its value is not reproduced.

| Header | Rate-limit header? | Example value |
| --- | --- | --- |
| `access-control-allow-credentials` | no | (not recorded) |
| `access-control-allow-origin` | no | (not recorded) |
| `connection` | no | (not recorded) |
| `content-encoding` | no | (not recorded) |
| `content-type` | no | (not recorded) |
| `date` | no | (not recorded) |
| `strict-transport-security` | no | (not recorded) |
| `transfer-encoding` | no | (not recorded) |
| `vary` | no | (not recorded) |
| `x-inference-id` | no | (not recorded) |
| `x-ratelimit-dynamic-period-remaining` | yes | 900s / 881s / 880s |
| `x-ratelimit-dynamic-period-usage-requests` | yes | 0% / 1% / 2% |
| `x-ratelimit-dynamic-period-usage-tokens` | yes | 0% / 1% / 2% |
| `x-ratelimit-dynamic-scale-requests` | yes | 1.00 |
| `x-ratelimit-dynamic-scale-tokens` | yes | 1.00 |
| `x-ratelimit-limit-requests` | yes | 600 |
| `x-ratelimit-limit-tokens` | yes | 400000 |
| `x-ratelimit-remaining-requests` | yes | 599 / 594 / 595 |
| `x-ratelimit-remaining-tokens` | yes | 398834 / 399984 / 399957 |
| `x-ratelimit-reset-requests` | yes | 1s / 2s |
| `x-ratelimit-reset-tokens` | yes | 1s |
| `x-request-id` | no | (not recorded) |

**Finding: Nebius sends `x-ratelimit-dynamic-period-remaining`, `x-ratelimit-dynamic-period-usage-requests`, `x-ratelimit-dynamic-period-usage-tokens`, `x-ratelimit-dynamic-scale-requests`, `x-ratelimit-dynamic-scale-tokens`, `x-ratelimit-limit-requests`, `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-requests`, `x-ratelimit-reset-tokens`.**

## 4. Per-second bucket or per-minute window?

A raw HTTP burst of 20 concurrent requests (bypassing the client-side rate limiter entirely, i.e. no `acquire()` gating) was fired at tier 1 to see how the server reacts to an instantaneous burst rather than a sustained rate.

| # | t (ms from burst start) | HTTP status |
| ---: | ---: | ---: |
| 0 | 898 | 200 |
| 1 | 898 | 200 |
| 2 | 898 | 200 |
| 3 | 898 | 200 |
| 4 | 898 | 200 |
| 5 | 899 | 200 |
| 6 | 899 | 200 |
| 7 | 899 | 200 |
| 8 | 899 | 200 |
| 9 | 899 | 200 |
| 10 | 899 | 200 |
| 11 | 899 | 200 |
| 12 | 899 | 200 |
| 13 | 899 | 200 |
| 14 | 899 | 200 |
| 15 | 899 | 200 |
| 16 | 899 | 200 |
| 17 | 899 | 200 |
| 18 | 899 | 200 |
| 19 | 899 | 200 |

**Finding: all 20 concurrent requests returned 200, none 429.** A 20-request instantaneous burst did not trip the limit, which is consistent with either a bucket sized well above 20 requests, or a window wide enough (per-minute, not per-second) that a single short burst does not exhaust it. This run cannot distinguish those two cases on its own. The 200-clue phase (section 5) does **not** add sustained-rate evidence here: its loop awaits each call before starting the next, so it never approached the client limiter's configured cap - at the phase's mean latency of 947 ms it ran at roughly 1.1 rps (the whole run, all phases included, spanned about 222 s for ~200 main-phase calls), never close to a rate that would stress a per-second bucket. The better evidence for bucket-vs-window comes from the header values already captured in section 3: `x-ratelimit-remaining-requests` recovers toward its ceiling between sequential calls only seconds apart (e.g. 599 / 594 / 595), and `x-ratelimit-reset-requests` reports resets of 1s / 2s rather than anything near 60 s - both are consistent with a continuously refilling per-second-scale bucket, not a fixed 60-second window (which would show the remaining count falling monotonically for up to a minute before a hard reset). Separately, the 20-request burst clearing instantly with zero 429s rules out a strict 10-requests-per-second bucket, since that many requests landing within well under a second would have exceeded a 10/s cap by roughly 2x if the bucket were that tight.

## 5. Tier-1 seed-pass reliability (n = 200)

- Clue pool: 17 real clues from the committed xd fixtures (american stratum) plus 258 hand-authored clues (this task), mixed lengths (3-12 letters), deterministically shuffled and truncated to 200.
- Calls attempted: 200. Transport-level failures (all retries exhausted, or a non-retryable HTTP status): 0 (0.0%).
- **Parse-failure rate** (single-attempt, no retry - the parser could not produce a `CandidateResponse` for the slot at all): 0 / 200 = 0.0%.
- **Length-error rate after normalisation, all candidates** (of every candidate answer returned across all successfully parsed responses, the fraction whose `normaliseAnswer()`'d length does not equal the requested slot length): 852 / 1276 = 66.8%.
- **Length-error rate, top candidate only** (of the 200 responses, the fraction whose rank-0 candidate has the wrong length): 27 / 200 = 13.5%. This is a second query over the same captured raw text (`content`, i.e. `LlmResult.text`), not a re-measurement, and it is the more operationally relevant number: `validate/normalise.ts` drops wrong-length candidates one at a time rather than failing the whole response, so a batch of 10 that mostly misses only costs the search a smaller domain, not a dead slot, as long as the top one or two are usable.
- **Latency** (successful calls, ms): mean 947, p50 1071, p95 1634.

`clue_understood` histogram (over parsed responses):

| Bucket | Count | Share |
| --- | ---: | ---: |
| [0.0, 0.2) | 0 | 0.0% |
| [0.2, 0.4) | 0 | 0.0% |
| [0.4, 0.6) | 0 | 0.0% |
| [0.6, 0.8) | 0 | 0.0% |
| [0.8, 1.0] | 200 | 100.0% |

Two qualitative failure patterns showed up repeatedly while inspecting the raw candidate lists behind the numbers above (see section 6 for the actual saved responses):

- **Tail candidates drift off-length.** Asked for "up to 10 candidates, best first" with only a length instruction (the seed prompt carries no pattern for a first ask - `?` for every cell), the model reliably gets candidate #1 right but candidates #3 onward are often synonyms or related words of whatever length occurs to it (`test/fixtures/responses/real-06-*`: clue "Gilled swimmer", asked for 4 letters, got `FISH` (correct) then `TROUT, SALMO, CARP, BREAM, PIKE, EEL, SHAD, STUR, GAR` - five of those nine are the wrong length, and `SALMO`/`STUR` look like truncation artifacts rather than real words). This is exactly what the all-candidates rate above is measuring, and it is consistent with `validate/normalise.ts` doing a per-candidate length check rather than trusting the count.
- **Occasional degenerate duplicate lists.** A handful of responses repeated the same top answer ten times instead of offering nine different ones (`test/fixtures/responses/real-08-*`: clue "Sweet tropical stone fruit", ten `MANGO` entries at confidence 0.98). Every entry is individually well-formed (right length, valid confidence), so this costs nothing in the failure/length numbers above, but it means `candidatesPerAsk: 10` sometimes buys the search only one distinct answer instead of ten. `validate/normalise.ts`'s dedupe-by-answer step (spec: "Validation" step 4) already collapses these to one candidate with summed votes, so it is silently absorbed rather than surfaced - noted here since it was not otherwise visible in the pipeline's own metrics.

HTTP status counts across every attempt in this run (from the inference log, i.e. including retried attempts):

| Status | Attempts |
| --- | ---: |
| 200 | 207 |
| 422 | 3 |

## 6. Raw response samples

9 real raw responses were harvested into `test/fixtures/responses/real-*.txt` (API key redacted, though the model never echoes it): `real-00` through `real-05` are the reasoning-off discovery trials (section 1) - six versions of the same clue, most showing the model's chain-of-thought text since reasoning was on for most of those trials; `real-06` through `real-08` are from the 200-clue main phase, chosen to show a clean single-answer reply, a reply with several wrong-length tail candidates, and the degenerate duplicate-candidate pattern, all described above. None of the 200 main-phase calls produced a genuinely malformed (unparseable) response in this run, so there is no `real-*` sample of that kind; if a later, larger run finds one, it belongs alongside these. These are evidence for this report, not parser test fixtures - T11 owns `test/fixtures/responses/*.txt` proper; the `real-` prefix keeps this run's samples from colliding with T11's hand-authored ones.

## Recommendation

**Tier-1 JSON reliability is acceptable for v1, conditional on the reasoning-off fix landing.** With `reasoning_effort: "none"` applied (as it now is in `src/llm/tierRouter.ts`, replacing the placeholder), parse-failure rate was 0.0% (0/200) and the top-candidate length-error rate was 13.5% (27/200) - both well inside what a single retry-at-temperature-0 (T34) and the existing per-candidate length/pattern validation (`validate/normalise.ts`) already absorb. `clue_understood` was pinned near 1.0 on every response in this run (see the histogram above), which is a separate, standing open question about calibration (see "Method notes" below) rather than a reliability problem.

Two things are **not** acceptable as shipped and are addressed by this task's pre-authorised code changes:

1. Without the fix, the router's placeholder (`reasoning_effort: true`) is not merely a no-op - Nebius rejects it outright with HTTP 422, and the natural default (no parameter at all) leaves reasoning *on*, which spent the model's entire `sampling.maxTokens: 512` completion budget on chain-of-thought in every trial that had it on (`completionTokens: 1024` = 512 raw completion + 512 reasoning, i.e. the raw completion also hit its own ceiling) with **no JSON answer left to emit** (see `real-00` through `real-05` for `reasoning_effort=true`/`low`/unset, none of which reach a `{`). At the shipped default, tier 1 would fail to parse on essentially every seed call. This is the headline finding of this spike.
2. The all-candidates length-error rate (66.8%) means a profile or a future prompt change that trusts every one of the "up to `candidatesPerAsk`" candidates equally (rather than relying on `validate/normalise.ts`'s per-candidate filtering) would be measuring the wrong thing; a batch-size or candidatesPerAsk bench should watch the top-candidate rate, not the raw candidate count, as its quality signal.

If a later, larger run (more than the 200 clues here) shows the top-candidate rate drifting materially above ~15%, that is the threshold at which tightening the seed prompt's length instruction or lowering `escalation.clueUnderstoodThreshold` (currently 0.4, and not exercised by this run - see below) would be the next thing to try.

## Method notes and honesty caveats

- Parse-failure and length-error rates are measured on a single attempt with no retry, so they are not directly the "tier-1 failure" rate the spec defines (which is after one retry at temperature 0); they are the raw first-attempt numbers a retry rate would be computed from.
- The reasoning-off finding (section 1) and the schema-wrapper finding (section 2) are each based on very few calls (single-digit) because they are cheap to test and do not need statistical power - they are pass/fail checks against what the API accepts, not a rate measurement.
- `n` in section 5 may be less than 200 if the USD budget was reached first; the report always states the actual `n` used.
- `clue_understood` landed in `[0.8, 1.0]` for all 200 responses (section 5's histogram), which is not informative about calibration on its own: the clue pool (committed fixtures plus hand-authored one-line definitions, see section 5) is deliberately easy and unambiguous, with no crossing letters yet (a fresh seed pass), so a model reporting near-certainty on all of it is plausible rather than miscalibrated. The open question "how well calibrated is Nemotron's `clue_understood`?" needs a clue set with genuinely hard/ambiguous entries (cryptic-style wordplay, or clues with partially-filled patterns) to be answerable, which is out of scope for this spike's budget and clue pool.

## 2026-09-04 follow-up (T58): reasoning-off on every tier-1 call

T49 (above) shipped the reasoning-off parameter behind B41's "purpose is seed" clause, so only the seed pass sent it. T50's fixture run then showed what that costs on the other tier-1 purposes, and T58 removed the clause for tier 1 and re-ran the fixture refresh. Numbers below are from this worktree's own live inference log for the T58 refresh run (`logs/inference/2026-09-04.jsonl`, not committed, per B47), and from the two committed synthetic fixtures.

### Before (T50's run, reasoning-off on seed only)

Recorded in docs/build-notes/wave-4.md ("T50 determinism fix"), measured from T50's live inference log (3988 records):

- Tier-1 `repair` calls that parsed: **5 of 2039** (2034 failed with `reasoningTokens: 512`, `completionTokens: 1024` and parse error "no JSON object found" - the model spent its whole `sampling.maxTokens` budget on chain-of-thought and never emitted the JSON).
- Tier-1 `reask` calls that parsed: **0 of 74**, same signature.
- `src/candidates/service.ts` never writes a parse failure to the cache, so none of those keys could ever enter the committed cache, and both synthetic fixtures had to be captured with `--offline-lenient`. Strict `--offline` replay: **does not converge** for either fixture.

### After (T58, reasoning-off on every tier-1 call)

Gate is now `supportsReasoning && (tier === 1 || purpose === 'seed')` in `src/llm/tierRouter.ts`; tier 2 keeps B41's original gate, since nothing has been measured there (T58's deliverable is scoped to tier 1).

- Live calls in the refresh run: 57, all tier 1, all non-seed (1 `reask`, 56 `repair`). The 34 seed asks were served from the committed cache, which is unchanged by this fix: the reasoning parameter is not a cache-key field, so T50's seed entries still key-match.
- Every one of those 57 requests carried `{"reasoning_effort":"none"}`, every response came back HTTP 200 with `reasoningTokens: 0`, and **57 of 57 parsed** (0 parse failures). Mean `completionTokens` 155 (max 319), i.e. nowhere near the 512-token ceiling that the reasoning-on calls hit every time.
- Total spend for the refresh: **USD 0.0049**.
- Strict `--offline` replay: **converges for both fixtures.** `test/fixtures/runs/bounds.json` now records `offlineMode: "strict"` for `synthetic-5x5` and `synthetic-7x7`, and the integration suite was run three times in fresh `--network none` containers with those bounds, passing each time.

### What the re-asks did to accuracy

Honest accounting, since the plan expected a gain and one fixture moved the other way:

| Fixture | Before (lenient replay) | After (strict replay) |
| --- | --- | --- |
| `synthetic-5x5` | letters 1.0000, words 1.0000, perfect | letters 0.9545, words 0.8182, not perfect |
| `synthetic-7x7` | letters 1.0000, words 1.0000, perfect | letters 1.0000, words 1.0000, perfect |

On `synthetic-5x5` the repair pass now gets real candidates where it previously got nothing, and the run settles on a mutually consistent but wrong crossing: `1A` "Cry of surprise" fills `OM` instead of `OH` and `2D` "Chaos and destruction" fills `MAVOC` instead of `HAVOC`, sharing the wrong letter at their crossing. The truth is still in the candidate list for both slots (`truthInCandidates: true`, `truthRank` 2 and 0), and both slots saw more candidates than before (3 -> 11 and 3 -> 6), so this is a scoring/selection outcome, not a missing-candidate one: with reasoning on, those calls returned nothing at all and the search kept the seed-pass fill, which happened to be right. The bound the integration test asserts is the measured value minus 0.05 (0.9045), as `scripts/fixtures-refresh.ts` computes it, so the number in the repository is what was measured rather than what was hoped for.

This is a two-puzzle sample of a synthetic grid, so it is not evidence that re-asks hurt in general; it is evidence that the repair pass on tier 1 is now actually running, and that whether its candidates beat the seed fill is a scoring question (`score/calibrate.ts`, M6's calibration fitting) rather than a transport one.

### Spec conflict

docs/spec.md "Candidate service" step 2 still says the router sends the reasoning-off parameter "when the model advertises `reasoning` and the purpose is `seed`". That sentence is now true of tier 2 only. T58 does not own docs/spec.md, so the wording is left for the task that does.

## 2026-09-05 follow-up (T68): per-model reasoning-off value with a fallback

T49/T58 shipped one reasoning-off value (`"none"`) for every reasoning-capable model. The recall screen (T67, docs/plan.md wave 6) hit the limit of that assumption: running `openai/gpt-oss-120b` as tier 1 failed every call with `HTTP 400: Harmony does not support reasoning_effort='none'`. `gpt-oss-120b` is an OpenAI Harmony-format model (`models.json`: `supported_features` includes `reasoning` and `structured_outputs`, same as every other reasoning model in the catalogue - nothing in the catalogue itself distinguishes Harmony's narrower value set), and Harmony's `reasoning_effort` only accepts `low` | `medium` | `high` - there is no `none`. Sending `"none"` (the value T49 measured to actually zero out `reasoningTokens` on `nvidia/Nemotron-3_5-Lightning`) is therefore not a universal choice; it is that model's value.

Two-layer fix, both in this diff:

1. **`src/llm/tierRouter.ts`**: a per-model override table, `REASONING_OFF_VALUE_OVERRIDES`, keyed by model id (never by a name-pattern match, consistent with B9's capability-driven routing elsewhere in this file). `openai/gpt-oss-120b -> "low"`; every other model keeps the existing default `"none"`. `reasoningOffValueFor(model)` is exported and unit-tested directly, plus through `route()`.
2. **`src/llm/client.ts`** (the 400 retry path only): a runtime safety net for a model that is not yet in that table but turns out to reject `"none"` (or whatever value was sent) anyway. When a response carries HTTP 400 and the body's error message names `reasoning_effort`, the transport retries the same request exactly once with `"low"` substituted for the `reasoning_effort` value, logs a `log.warn` line naming the model and both values, and records the retry as its own `InferenceLogRecord` (the substituted request, `httpStatus`, and the next `attempt` index) - it does not loop past that one retry. If the retry also fails, the provider error surfaces exactly as it would have without this fallback. A 400 whose body does not mention `reasoning_effort`, or a request that never carried the parameter in the first place, is untouched: still a single non-retryable throw, as before this task.

No cache-key change: `reasoning_effort`'s value was never a cache-key field (spec: "Candidate service" step 1 lists exactly the prompt-visible fields, and this parameter is not one of them), so neither layer of this fix touches caching. Unit tests (stub HTTP server, no network): the override table maps `gpt-oss-120b` to `"low"` and a model with no override gets `"none"`; the client's 400-with-`reasoning_effort` path retries exactly once with `"low"` and succeeds; the same path surfaces the provider error when the retry also fails; a 400 without that text, or without the parameter having been sent, does not retry.

Running `openai/gpt-oss-120b` through the recall screen against the live API to confirm the fix end to end is the orchestrator's follow-up after merge (out of scope for this task, per its "Out of scope" note); this addendum documents the router-and-client-side fix only.
