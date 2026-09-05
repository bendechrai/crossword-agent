# Model selection

Snapshot from `models.json` (Nebius Token Factory, fetched 2026-09-02). Prices are USD per 1M tokens. TPM and RPM are the per-request-key limits reported by the API.

## Text-to-text models

| ID | Modality | Context | Quant | Input $/1M | Output $/1M | TPM | RPM | Reasoning in ID | Reasoning feature | Structured output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| nvidia/Nemotron-3_5-Lightning | text | 1M | bf16 | 0.06 | 0.24 | 400,000 | 600 | no | yes | no |
| nvidia/Nemotron-3-Nano-Omni | text | 262k | fp8 | 0.06 | 0.24 | 800,000 | 1,000 | no | yes | no |
| nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B | text | 262k | fp8 | 0.06 | 0.24 | 800,000 | 100 | no | yes | no |
| deepseek-ai/DeepSeek-V4-Flash-0731 | text | 1M | fp8 | 0.14 | 0.28 | 1,000,000 | 3,000 | no | yes | yes |
| google/gemma-3-27b-it | text | 110k | fp8 | 0.10 | 0.30 | 400,000 | 600 | no | no | no |
| nvidia/Cosmos3-Super-Reasoner | text+image | 262k | fp16 | 0.10 | 0.30 | 200,000 | 300 | yes | yes | yes |
| Qwen/Qwen3-30B-A3B-Instruct-2507 | text | 262k | fp8 | 0.10 | 0.30 | 400,000 | 600 | no | no | yes |
| Qwen/Qwen3-32B | text | 41k | fp8 | 0.10 | 0.30 | 400,000 | 600 | no | yes | yes |
| meta-llama/Llama-3.3-70B-Instruct | text | 131k | fp8 | 0.13 | 0.40 | 3,000,000 | 1,200 | no | no | no |
| NousResearch/Hermes-4-70B | text | 131k | fp8 | 0.13 | 0.40 | 200,000 | 120 | no | yes | yes |
| zai-org/GLM-5.3-Flash | text+image | 1M | fp8 | 0.15 | 0.50 | 400,000 | 600 | no | yes | no |
| openai/gpt-oss-120b | text | 131k | fp4 | 0.15 | 0.60 | 500,000 | 600 | no | yes | yes |
| Qwen/Qwen3-235B-A22B-Instruct-2507 | text | 262k | fp8 | 0.20 | 0.60 | 400,000 | 600 | no | no | yes |
| nvidia/nemotron-3-super-120b-a12b | text | 262k | fp4 | 0.30 | 0.90 | 200,000 | 300 | no | yes | no |
| Qwen/Qwen3-Next-80B-A3B-Thinking | text | 128k | fp8 | 0.15 | 1.20 | 400,000 | 600 | yes | yes | yes |
| MiniMaxAI/MiniMax-M3 | text | 1M | fp4 | 0.30 | 1.20 | 400,000 | 600 | no | yes | no |
| nvidia/Llama-3_1-Nemotron-Ultra-253B-v1 | text | 131k | fp8 | 0.60 | 1.80 | 400,000 | 600 | no | yes | no |
| NousResearch/Hermes-4-405B | text | 131k | fp8 | 1.00 | 3.00 | 200,000 | 120 | no | yes | yes |
| nvidia/Nemotron-3-Ultra-550b-a55b | text | 1M | fp4 | 1.00 | 3.00 | 200,000 | 300 | no | yes | no |
| deepseek-ai/DeepSeek-V4-Pro | text | 1M | fp8 | 1.75 | 3.50 | 1,000,000 | 3,000 | no | yes | yes |
| Qwen/Qwen3.5-397B-A17B | text | 262k | fp4 | 0.60 | 3.60 | 400,000 | 600 | no | yes | no |
| moonshotai/Kimi-K2.6 | text+image | 262k | int4 | 0.95 | 4.00 | 300,000 | 200 | no | yes | no |
| moonshotai/Kimi-K2.7-Code | text | 262k | fp4 | 0.95 | 4.00 | 300,000 | 200 | no | yes | no |
| zai-org/GLM-5.1 | text | 203k | fp8 | 1.40 | 4.40 | 500,000 | 1,000 | no | yes | yes |
| moonshotai/Kimi-K3 | text+image | 1M | fp4 | 3.00 | 15.00 | 2,000,000 | 1,000 | no | yes | no |

Excluded:
- `Qwen/Qwen3-Embedding-8B` - embedding model (modality text->embedding), not a text generator.
- `Qwen/Qwen2.5-VL-72B-Instruct` - vision-language specialist, not a general-purpose text model.
- `openbmb/MiniCPM-V-4_5` - vision/OCR specialist, not a general-purpose text model.

## Workload notes

A crossword solver issues many short requests - one or a few per clue, plus re-tries when crossing letters constrain an answer - so requests-per-minute matters as much as output price. Prompts are short (a clue, a grid fragment, maybe a definition lookup), so input price matters far less than output price. Structured JSON output support makes parsing candidate answers reliable instead of scraping free text. Reasoning variants may help on cryptic clues, where the wordplay needs working through, but they burn output tokens on thinking even for easy clues, so they are a cost risk for the cheap first pass.

## Candidates for a first cheap pass

| ID | Output $/1M | TPM | RPM | Why |
| --- | --- | --- | --- | --- |
| nvidia/Nemotron-3_5-Lightning | 0.24 | 400,000 | 600 | Joint-lowest output price in the catalogue, and meets the 400k TPM / 600 RPM baseline tier. |
| nvidia/Nemotron-3-Nano-Omni | 0.24 | 800,000 | 1,000 | Same joint-lowest output price, with headroom above the baseline tier on both TPM and RPM. |
| deepseek-ai/DeepSeek-V4-Flash-0731 | 0.28 | 1,000,000 | 3,000 | Next-cheapest output price, well above the baseline tier on rate limits, and the only one of the three with structured output support. |

`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` also matches the lowest output price (0.24) but is not picked: its 100 RPM limit is well under the 600 RPM baseline, which is too low for the one-request-per-clue pattern this solver needs.

## Stronger candidates

| ID | Output $/1M | TPM | RPM | Why |
| --- | --- | --- | --- | --- |
| deepseek-ai/DeepSeek-V4-Pro | 3.50 | 1,000,000 | 3,000 | Flagship-tier reasoning model with structured output support and the highest RPM of the upper tier. |
| Qwen/Qwen3.5-397B-A17B | 3.60 | 400,000 | 600 | Large hybrid MoE flagship (397B parameters) with solid RPM, though it lacks structured output support. |
| zai-org/GLM-5.1 | 4.40 | 500,000 | 1,000 | Z.ai's flagship model, structured output support, and comfortably above the baseline RPM tier. |

`moonshotai/Kimi-K3` is a premium option held in reserve: its output price (15.00) is roughly 3x to 4x that of the three picks above, so it is worth benchmarking but not a default choice. `NousResearch/Hermes-4-405B` (120 RPM) and `nvidia/Nemotron-3-Ultra-550b-a55b` (300 RPM) were passed over for low RPM relative to the picks above.

## Decision

Every clue is routed first to `nvidia/Nemotron-3_5-Lightning` (output $0.24 per 1M tokens) with its high rate limits (400,000 TPM, 600 RPM). If that model fails - defined as returning no answer, an answer of the wrong length, or an answer conflicting with letters fixed by crossing entries - the clue escalates to `deepseek-ai/DeepSeek-V4-Pro` (output $3.50 per 1M tokens, structured output support, 1,000,000 TPM, 3,000 RPM). This two-tier approach leverages the cheap model's high throughput to solve the bulk of clues, while paying for the expensive model only on the hard tail. The other four shortlisted models remain documented as fallbacks and benchmark comparators.

### Decision revised (2026-09-05)

The benchmark this document's "Next step" called for has now been run, in two stages, against the actual solver rather than against price and rate-limit numbers alone. The seed-only candidate recall screen (docs/benches/recall-screen.md) measured every shortlisted and several additional models' raw candidate-generation quality with the solver's search, escalation and repair passes switched off, and flagged `deepseek-ai/DeepSeek-V4-Flash-0731` as by far the most cost-efficient model screened. The puzzle-level bench that followed (docs/benches/model-comparison.md) ran it as tier 1 inside the real solver end to end and confirmed the result: 0.80 letters accuracy on the american stratum against the prior default's 0.58, winning 24 of 24 paired repeats, at about half the per-puzzle cost.

**New pair:** tier 1 is now `deepseek-ai/DeepSeek-V4-Flash-0731` (output $0.28 per 1M tokens, structured output support, 1,000,000 TPM, 3,000 RPM); tier 2 is unchanged, `deepseek-ai/DeepSeek-V4-Pro`. `nvidia/Nemotron-3_5-Lightning` remains available by naming it explicitly as `tier1` in a profile file, but no longer routes any clue by default. See docs/benches/recall-screen.md and docs/benches/model-comparison.md for the measurements, and docs/spec.md's Decisions log for the corresponding entry.

## Next step

The recall screen (docs/benches/recall-screen.md) and puzzle-level bench (docs/benches/model-comparison.md) were run on 2026-09-05, confirming that deepseek-ai/DeepSeek-V4-Flash-0731 was the correct tier-1 choice. The model pair has been revised accordingly.
