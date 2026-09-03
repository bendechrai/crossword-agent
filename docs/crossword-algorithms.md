# Crossword solving algorithms

Purpose: ground this Node.js crossword solver in the published literature, and settle how LLM candidate generation (Nemotron-3_5-Lightning first, DeepSeek-V4-Pro on escalation) should be wired into a constraint search over the grid.

## Prior art

### Proverb (Keim, Shazeer, Littman et al., AAAI 1999)

The first broad-coverage computer solver. It splits the problem into candidate generation and grid filling: around 30 independent "expert modules" (IR over a clue database, dictionaries, movie and encyclopedia lookups, string-pattern rules, and an "implicit distribution" module that scores arbitrary letter sequences with a tetragram model) each return a weighted candidate list per clue. A merger reweights them into one distribution per slot, and the solver searches for the fill maximising *expected word overlap* with the truth rather than the single most likely grid, treating it as belief-net inference solved by turbo decoding.

Reported: 95.3% words and 98.1% letters correct in under 15 minutes per puzzle over 370 puzzles; roughly the median human at the 1998 ACPT.

What we can reuse: the generation/placement split (which Ben's sketch already has); merging noisy sources into one calibrated per-slot distribution; optimising expected letter overlap, which is what our scorer measures; and the fallback of scoring letter sequences with a character n-gram model when a slot has no surviving candidate.

### Dr.Fill (Ginsberg, JAIR 42, 2011)

Converts an American-style crossword into a *singly weighted* CSP - slots are variables, domains are scored word lists, and the objective minimises total weight. Its value heuristic scores a fill by the "damage" it does to the achievable score of every neighbour after propagation; its variable heuristic branches on the slot with the largest gap between best and second-best fill (`H(s) = min2 h(f,v) - min h(f,v)`, largest first). It uses a variant of limited discrepancy search (LDS) rather than branch and bound, which was dropped because cost accumulates at the bottom of the tree, plus postprocessing of complete solutions and partitioning into independent regions.

Reported: 11,210 points on the 2010 ACPT, a notional tie for 43rd place (38th after speed tuning), with 27/643 words wrong (95.8%) and 28/1817 letters wrong (98.5%). A later Dr.Fill hybridised with Berkeley's QA modules won the 2021 ACPT.

What we can reuse: the confidence-margin variable ordering is the best idea here for us. Naive MRV branches on the slot with fewest candidates, which with LLM domains usually means the slot where the model failed; branching on the widest best-to-runner-up margin commits first where we are genuinely confident. LDS also fits: our value ordering is a heuristic we half-trust, and LDS bounds how often we may disagree with it.

### Berkeley Crossword Solver (Wallace, Tomlin, Xu, Yang, Pathak, Ginsberg, Klein; ACL 2022)

Generates candidates with a neural bi-encoder QA model trained on 6M+ clue-answer pairs, keeping a large top-k list per clue. It then runs loopy belief propagation over a bipartite factor graph of clue and cell nodes (a 5-letter clue node has degree 5), producing word and character marginals and directly targeting maximum expected overlap. Finally a local search pass proposes fills within 2-letter edit distance of the BP output - flipping only letters whose alternatives have probability >= 0.01 under the BP character marginals, or that make the answer segment into dictionary words - and rescores each with a second-pass generative QA model until no improving edit exists.

Reported: 82% exact puzzle accuracy on NYT (from 71%), 99.9% letter and 89.5% puzzle accuracy on themeless puzzles; bi-encoder top-1000 recall 84.4% -> 94.6% with the second-pass model. The ablation matters most: QA + BP alone gives 44.3% perfect puzzles, QA + BP + local search gives 81.7%. At the 2021 ACPT a BCS/Dr.Fill hybrid scored 12,825 against the top human's 12,810, the first program to beat every human there.

What we can reuse: the repair pass is not optional - it nearly doubled perfect-puzzle accuracy, so a solver that stops at the first complete fill is discarding most of its headroom. And the proposal gate (only consider repairs whose changed letters are individually plausible, or that produce a real word) is a cheap deterministic rule we can implement with no probabilistic machinery.

### WebCrow (Ernandes, Angelini, Gori; AAAI 2005)

The first solver for non-English (Italian) crosswords and the first to use the open web as its knowledge base. Clue-answering modules issue up to three web queries per clue, parse the documents, extract terms of the right length and rank them statistically; dictionary and rule-based modules add more. A simple confidence-weighted merger combines module scores, and grid filling is a probabilistic CSP solved by a best-first search with a deliberately non-admissible depth term for speed. When a slot runs out of candidates, WebCrow scores the remaining letter pattern with a tetragram model instead of failing.

Reported: about 70% words and 80% letters correct on average; on puzzles humans rate "easy", 80.0% words and 90.1% letters within competition time - roughly a human beginner.

What we can reuse: the explicit empty-domain policy. Ours is the same shape: constrained re-ask, then escalation, then a word-list pattern fill as a last resort.

### LLM-era work (2024-2026)

**Saha, Chakraborty, Saha and Garain, "Language Models are Crossword Solvers" (NAACL 2025)** is the closest published system to ours. Out-of-the-box LLMs answer straight NYT clues at 41.2% (GPT-4-Turbo) and 37.7% (Claude 3 Sonnet) exact match with 5-shot prompting, and supplying partial character constraints improves accuracy in almost every configuration - GPT-4-Turbo reaches 76.3% on the hinted Init split, about 2.8x the accuracy of a fine-tuned Mistral 7B. Their SweepClip algorithm generates candidates for all clues, keeps the largest connected component of mutually consistent answers, greedily deletes the maximum-degree vertex of the *conflict* graph until no conflicts remain, then re-queries the LLM for the neighbours of surviving answers with the now-known characters unmasked, iterating to max_iter (30) or a budget cap (USD 0.50 per puzzle for GPT-4-Turbo; 600 calls for Llama 3 70B). Result: 93.1% (+/- 14.1) character accuracy on 100 Monday NYT puzzles, 48% perfect, 55% with at most one wrong character, and clue accuracy lifted from 43.5% to 89.6% - a 2.1x improvement purely from the constraint loop. They flag it as sub-optimal because it discards potentially correct answers and never branches at a conflict.

**CrossWordBench (2025)** generates controllable puzzles in text and image form with an adjustable prefill ratio and evaluates 20+ models. Key finding for us: reasoning LLMs improve as more crossing letters are supplied, while non-reasoning models show no such benefit - so the payoff from a constrained re-ask is model-dependent and must be measured on Nemotron directly. It also reports sharply diminishing returns from test-time scaling.

**Sadallah, Kotova and Kochmar (2024)** benchmark LLaMA2, Mistral and ChatGPT on cryptic clues and find performance far below human.

What we can reuse: SweepClip is essentially Ben's sketch, validated, plus one addition - the *sweep*. After any answers are fixed, re-ask the model for the neighbours with letters revealed rather than only filtering a static list. That loop alone is worth roughly 2x on clue accuracy, and its documented weakness (no branching at a conflict) is exactly where a real backtracking search should beat it.

## Problem model

A weighted CSP:

- **Variables**: slots - maximal runs of >= 3 white cells, keyed `(direction, startRow, startCol)`, carrying a clue and a length.
- **Domains**: LLM candidates, each an uppercase A-Z string of exactly the slot length with a score in [0,1]. Domains are small (5-20), noisy, and may be empty. That is the core difference from Proverb, Dr.Fill and BCS, which all draw on dictionary-scale scored lists.
- **Constraints**: for each shared white cell, `across[i] == down[j]`. Every white cell in a standard grid belongs to exactly one across and one down slot, so the constraint graph is bipartite and every constraint is binary on a single character.
- **Objective**: maximise expected correct letters (sum of log candidate scores), not the probability the whole grid is right.

A 5x5 fragment (`#` is a block):

```
      c0 c1 c2 c3 c4
 r0    P  L  A  T  E     1-Across  "Dinner dish" (5)
 r1    #  #  L  #  #
 r2    S  P  I  C  E     3-Across  "Add zest to" (5)
 r3    #  #  E  #  #
 r4    H  O  N  E  Y     4-Across  "Term of endearment" (5)

       2-Down (r0c2, 5)  "Extraterrestrial"
```

2-Down crosses all three across slots. With 1-Across = PLATE and 4-Across = HONEY, cells `(0,2)` and `(4,2)` pin to `A` and `N`, so 2-Down's pattern is `A???N` and its filter is `/^A[A-Z]{3}N$/`. Add 3-Across = SPICE and `(2,2)` pins to `I`: pattern `A?I?N`, regex `/^A[A-Z]I[A-Z]N$/`. ALIEN survives; ALARM, ACORN and AMEND do not. That pattern string is simultaneously the cache key suffix, the regex source, and the payload for a constrained re-ask.

## Candidate generation with the LLM

**Prompt shape.** A system prompt fixing the output contract, then per clue: clue text verbatim; enumeration (`5`, or `(3,4)` for multi-word answers where the format supplies it); puzzle style (American straight vs cryptic - they need completely different readings) and publication; the known letter pattern as `A?I?N` with `?` explicitly meaning unknown and every fixed letter certain; already-rejected answers for this slot; and, on escalation only, the crossing clues and their current fills. Ask for N distinct candidates ordered best first, and state that answers are run together, uppercase A-Z, no spaces or hyphens (`BUTTONYOURLIP`) - a known failure mode for models trained on natural text.

**Response schema.** One schema for both tiers, so the router is transparent to callers. DeepSeek gets it as a structured-output JSON schema; Nemotron gets it in-prompt with a one-shot example, parsed defensively (strip fences, take the first balanced JSON object, retry once at temperature 0, then escalate).

```json
{
  "clue_understood": 0.0,
  "candidates": [
    { "answer": "ALIEN", "confidence": 0.0 }
  ],
  "notes": "optional short free text, e.g. wordplay reading"
}
```

`clue_understood` is 0-1 and used as a routing signal, not a probability. `candidates` holds 8-12 entries on the first pass; past ~15 it is noise, and we buy recall back with the re-ask loop instead of a long list.

**Calibration.** Do not search on self-reported confidence. Three options, increasing in cost: (1) **rank position**, scoring candidate `i` as `1/(k+i)` - free and usually better ordered than self-reports; (2) **sampling agreement**, asking the same clue 3 times at temperature ~0.7 and counting votes, which is self-consistency and reported to help on cryptics, at 3x the calls; (3) **a blended score**, `w1*voteFraction + w2*reciprocalRank + w3*selfConfidence`, with weights fitted by logistic regression against the solution grids we already have in the puzzle files. Fit once over a few dozen puzzles and hard-code the weights.

**Constrained re-ask.** When pattern filtering empties a slot, or its crossing letters have changed since the last query, re-ask with the pattern. This is the highest-value mechanism in the LLM literature (43.5% -> 89.6% clue accuracy). Prefer it over a huge initial list. Guard it: only when the pattern has at least one fixed letter and differs from the last pattern queried for that slot, capped at 2-3 re-asks per slot.

**Caching.** Key on `sha1(model, promptVersion, clueText, length, pattern, style)`. Patterns recur heavily during backtracking, so an in-process LRU plus a disk cache makes reruns nearly free and evaluation reproducible. Cache negative results too, so backtracking never re-pays for a known dead end.

**Batching under rate limits.** A 15x15 puzzle has ~76-80 slots. At 600 RPM one clue per request costs about 8 seconds of quota for a whole puzzle if parallel, so batching is unnecessary for throughput - and one clue per request is strictly better for cache hits, for isolating parse failures, and for re-asks, where every slot has a different pattern. Batch only if per-request latency dominates: 5-10 clues per request, accepting that one malformed object costs the batch, and never batch re-asks. Rough token budget: ~250 prompt + ~150 completion tokens per clue, so ~32k tokens for a first pass over 80 clues, plus 30-50 re-asks and a handful of escalations - on the order of 60-80k cheap-tier and under 15k strong-tier tokens per puzzle.

## Filling the grid

| Approach | How it works | Strength | Weakness for noisy LLM candidates | Recommend? |
| --- | --- | --- | --- | --- |
| Chronological backtracking | Fill in numbering order, undo on conflict | Trivial | Thrashes; undoes the wrong decision, since the culprit is usually far back | No |
| Backtracking + forward checking + MRV | On assignment, filter neighbours; branch on most constrained slot | Detects dead ends early, cheap | Plain MRV picks the slot where the LLM failed, not the one we know most about | Yes, with margin ordering |
| AC-3 arc consistency | Worklist over arcs; drop values with no support at the crossing cell; requeue affected arcs. O(ed^3) time, O(e) space | Removes globally impossible candidates before search | With domains of 10 the saving is modest, and it can wipe a domain that only looks impossible because a neighbour's true answer is missing | Yes, as a guarded prepass |
| Weighted CSP + LDS (Dr.Fill) | Iteratively allow k deviations from the heuristic ordering | Bounds search where the heuristic is mostly right - our case | Needs a value ordering worth trusting, i.e. calibrated scores | Yes, as the backtrack budget policy |
| Loopy belief propagation (Proverb, BCS) | Message passing on the clue/cell factor graph; word and character marginals | Optimises expected overlap; marginals guide repair | Needs real probabilities over a large answer set; 10 unnormalised candidates give near-degenerate marginals | Not for v1 |
| Local search / iterative repair (BCS) | From a complete fill, propose small edits and rescore | Fixes near-misses the search locked in; nearly doubled BCS perfect puzzles | Needs a proposal scorer - ours is the LLM, so each proposal costs a call | Yes, bounded |
| Beam search | Keep top-B partial fills by cumulative score | Avoids single-path commitment; parallelises | Calls and memory scale with B, and beams tend to share the same early mistake | Optional, B=3-5 if search stalls |
| SweepClip-style iterative re-ask | Generate all, drop conflicts by max degree, re-ask neighbours with letters revealed, repeat | Proven 93.1% character accuracy; simple | Discards correct answers; never explores alternatives at a conflict | Yes, as the outer loop |

**Recommended algorithm.** A SweepClip-style outer loop with a real backtracking search inside it and a BCS-style repair pass at the end.

```
1. LOAD puzzle (.puz/.ipuz/.jpz/.xd) -> grid, slots, crossing index, and the solution grid
   held behind a separate accessor for scoring only.

2. SEED: for every slot, call tier 1 (Nemotron) with clue + length + style.
   Normalise, validate, dedupe, score (blended calibration). domain[s] := candidates.
   Slots left empty after validation go straight onto the escalation queue.

3. PREPASS: run AC-3 over the crossing arcs.
   For arc (s,t): drop any candidate of s with no candidate in t agreeing at the shared cell.
   Requeue every other arc of s whenever domain[s] shrinks.
   If a domain wipes out, restore it and mark the slot "suspect" - a wipeout here means one of
   the two domains is missing its true answer, not that the puzzle is unsatisfiable.

4. SEARCH: depth-first assignment with forward checking.
   a. If every slot is assigned, go to 7.
   b. Choose the unassigned slot s maximising the confidence margin
      (best surviving score) - (second-best score)   [Dr.Fill eq. 10].
      Break ties by fewest surviving candidates (MRV), then most unassigned crossings (degree).
   c. Order values by calibrated score, best first.
   d. Assign; forward-check each crossing slot by intersecting its domain with the new pattern
      regex. If a crossing domain empties, go to 5 for that slot before backtracking.
      Count a discrepancy whenever we take other than the first-ranked value; abandon the branch
      once discrepancies exceed the current LDS limit and restart step 4 at limit+1.
   e. Recurse.

5. RE-ASK (the sweep): for a slot whose domain emptied, build its pattern from fixed crossings
   and re-query tier 1 with that pattern plus the already-rejected list. Merge and continue.
   At most R re-asks per slot (R = 2).

6. ESCALATE: if the re-ask still yields nothing, or the slot has emptied more than twice, call
   tier 2 (DeepSeek-V4-Pro) with the context listed under "Escalation".
   If that also fails and the subtree's backtrack budget is spent, undo the LOWEST-MARGIN
   assignment among the slots crossing s - not the chronologically last one - and resume.
   When the global backtrack counter exceeds B (e.g. 200), keep the best partial fill, go to 7.

7. REPAIR: from the (possibly partial) fill, run bounded local search.
   Propose alternatives at 1-2 letter edit distance, only where the changed letters are
   plausible (the letter appears in some cached candidate for one of the two crossing slots,
   or the result is in the word list). Score proposals by re-asking tier 1 for the affected
   slots with the new pattern. Accept improving edits until none remain or the budget is spent.
   Fill any still-empty slot with the best word-list entry matching its pattern.

8. SCORE against the solution grid (letter, word, perfect-puzzle) and log tokens, calls per
   tier, cost, wall time, backtracks and escalations.
```

## Deterministic validation and filtering

All of this runs before a candidate enters a domain, and none of it costs a model call.

- **Normalise first.** Uppercase; strip spaces, hyphens, apostrophes and punctuation; decompose accents (NFD, drop combining marks). `Nano Banana` -> `NANOBANANA`. Reject anything still holding a non `A-Z` character.
- **Length check, after normalisation.** `answer.length === slot.length`. This is the commonest LLM failure - the NAACL paper devotes a section to models being unable to count characters.
- **Pattern match.** Build the regex from the pattern (`?` -> `[A-Z]`, anchored) and test every candidate. `A?I?N` accepts ALIEN, rejects ALARM.
- **Deduplicate** on the normalised string, keeping the highest score and summing votes, so `A-lister` and `ALISTER` do not both hold domain slots.
- **Clue echo rejection.** Drop a candidate whose normalised form equals or is contained in the normalised clue (`"Add zest to"` -> `ADDZEST` is the model parroting). Allow it back only if the slot would otherwise be empty.
- **Word list as a bonus, never a filter.** Real answers include proper nouns, brands and phrases no list has. Verified open lists: ENABLE (`enable1.txt`, ~172,800 words, mirrored at `github.com/dolph/dictionary`); the Crossword Nexus collaborative word list (>425,000 `word;score` entries, MIT); SCOWL / the English Speller Database at `wordlist.aspell.net`. Peter Broda's list and Spread the Wordlist are what constructors actually use (see Sources for the verification caveat).
- **Persistent rejection set** per slot, passed into every re-ask so the model is never asked to rediscover a ruled-out answer.

## Escalation to the stronger model

**Triggers**, in precedence order: (1) tier 1 returned unparseable JSON twice, or zero valid candidates after validation; (2) a domain is empty after pattern filtering *and* one constrained re-ask has already been tried; (3) `clue_understood` below threshold (start at 0.4) on the first pass, escalating proactively rather than waiting for the search to hit the wall; (4) the same slot has caused three or more wipeouts, suggesting a crossing answer is wrong rather than this slot being hard; (5) a slot is still empty when search terminates, or the repair pass cannot fix it.

**Extra context to send** (never on the cheap first pass): the letter pattern in `A?I?N` form; the rejected candidates with a one-line reason each ("wrong length", "conflicts with 3-Across at cell 3"); every crossing slot's clue, current fill and confidence, so the model can tell us a crossing looks wrong; the puzzle style and title (themed puzzles hinge on it); and permission to return `crossing_suspect: "<slot id>"` in `notes` if it thinks a fixed letter is wrong.

**Budget caps**, all configurable and logged: tier-2 calls per puzzle (start at 15, ~20% of slots); tokens per puzzle; USD per puzzle (SweepClip used USD 0.50 with GPT-4-Turbo - the right order of magnitude); re-asks per slot (2); escalations per slot (1); global backtracks (200); repair-pass calls (30); wall-clock deadline. Hitting a cap ends the phase gracefully and moves on - never abort, because a partial fill still yields a measurable accuracy number.

## Critique of the initial sketch

**1. "Send the model the clue text and answer length; receive an object with a confidence score that it understood the clue and produced good answers, plus an array of possible answers."**

Holds: the request and response shapes are right, and asking for an array rather than one answer is what every system from Proverb onward does. Change: do not treat the self-reported confidence as a probability. LLM self-reports are poorly calibrated, and the search will make bad commitment decisions if it orders values by them. Use it as a routing signal only (a low value triggers early escalation), and derive the score you actually search on from rank position, sampling agreement across 3 samples, and a logistic blend fitted against the solution grids we already have in the .puz files. Also add to the request: puzzle style (American vs cryptic changes everything), the enumeration for multi-word answers, and an explicit "answers are run together, uppercase A-Z only" instruction - and expect to reject a meaningful fraction on length, since character counting is a documented LLM weakness.

**2. "Build an in-memory representation of the grid and start filling blanks."**

Holds entirely, and it is the right level of ambition: the grid model should be plain data (cells, slots, a crossing index mapping each cell to its across and down slot with offsets) with no model calls in it. Change: make the objective explicit up front - optimise expected letter/word overlap, not the probability the whole grid is right. Proverb and BCS both argue this and it is what our scorer measures. Also decide now that the grid model exposes `patternFor(slot)` returning `A?I?N`, because that one string is the cache key, the regex source and the re-ask payload.

**3. "When looping through candidates for a slot, if none fits the letters already on the board, either revisit alternatives for the crossing answers already placed, or ask the stronger model for more candidates."**

The right instinct, and exactly what SweepClip does - but the ordering is wrong and one option is missing. Change: on an empty domain, try the *constrained re-ask to the cheap model first* - same tier, same clue, now with the letter pattern and the rejected list. It is the highest-value single mechanism in the LLM crossword literature (clue accuracy 43.5% -> 89.6%), costs one cheap call, and resolves most wipeouts without touching the search. Only if that fails should you escalate to DeepSeek, and only after that should you backtrack. Second change: "no fit" is evidence about the *crossing* answers, not only about this slot, and backtracking should exploit that. Do not undo the chronologically last assignment; undo the crossing assignment with the lowest confidence margin (Dr.Fill's `min2 - min`), because that is the placement we were least sure of. Third: bound it. Without a global backtrack budget and a per-slot escalation cap, one bad crossing burns the whole puzzle budget.

**4. "Deterministic processes validate responses (answer length, allowed characters) and filter candidate arrays by the pattern of letters already fixed by crossing answers."**

Holds, and this is the cheapest accuracy in the system - keep it strictly deterministic and out of the model's hands. Change: normalise *before* the length check (strip spaces, hyphens and accents first, or you will reject correct multi-word answers), add deduplication after normalisation, add clue-echo rejection, and treat the word list as a scoring bonus rather than a filter, since crossword answers routinely fall outside any dictionary. Also cache negative results, so a `(clue, length, pattern)` triple that produced nothing is never paid for twice during backtracking.

**One structural point running through all four.** Keep the LLM strictly as a candidate oracle and never as the search loop. The model proposes; deterministic code normalises, filters, orders, commits, backtracks and repairs. Every system that has beaten humans at this - Proverb, Dr.Fill, BCS - has that separation, and the LLM-era result that comes closest to state of the art (SweepClip) is the one that wraps the model in a search rather than asking it to solve the grid. The corollary: the solver must run against cached candidates with zero network calls, which is what makes evaluation and regression testing possible.

**One thing the sketch omits entirely.** There is no repair pass. The BCS ablation says QA + belief propagation alone gets 44.3% of puzzles perfect, and QA + BP + local search gets 81.7%. A solver that stops at the first complete fill discards roughly half its potential perfect-puzzle rate. Add a bounded final pass that proposes 1-2 letter edits at plausible positions and rescores.

## Recommended architecture for the Node.js solver

- **`puzzle/loader`** - parse .puz, .ipuz, .jpz and .xd into one internal shape; expose the solution grid behind a separate accessor so the solver cannot read it by accident.
- **`grid/model`** - cells, slots, crossing index, assignment/undo with an explicit trail, `patternFor(slot)`, `isComplete()`. Pure data, no I/O.
- **`llm/client`** - Nebius transport: retries, timeouts, token-bucket rate limiting at 600 and 3000 RPM, token accounting.
- **`llm/tierRouter`** - picks Nemotron vs DeepSeek per request; applies structured-output mode only where supported.
- **`llm/prompts`** - versioned templates for first pass, constrained re-ask and escalation; the version string is part of the cache key.
- **`llm/parser`** - ajv schema validation, fence stripping and balanced-JSON recovery for the tier-1 unstructured path.
- **`candidates/service`** - the only thing the solver talks to: `getCandidates(slot, pattern, options)`, wrapping cache, routing, validation and calibration.
- **`candidates/cache`** - LRU plus disk cache keyed on `(model, promptVersion, clue, length, pattern, style)`, including negatives.
- **`validate/normalise`** - uppercase, strip, deaccent, length, pattern regex, dedupe, clue-echo rejection.
- **`validate/wordlist`** - scored lookup over ENABLE / the collaborative word list, plus pattern-matched fallback fills.
- **`score/calibrate`** - blends rank, vote fraction and self-reported confidence into the search score; weights fitted offline.
- **`solver/ac3`** - arc-consistency prepass with wipeout protection.
- **`solver/search`** - backtracking with forward checking, confidence-margin variable ordering, LDS-bounded values, escalation hooks.
- **`solver/repair`** - bounded local search over 1-2 letter edits with plausibility gating.
- **`policy/escalation`** - triggers, per-slot and per-puzzle caps, budget accounting; the single place cost policy lives.
- **`eval/scorer`** - letter, word and perfect-puzzle accuracy against the solution grid.
- **`eval/runLogger`** - per-run JSON: calls and tokens per tier, USD, wall time, backtracks, escalations, per-slot trace.

## Open questions

- How well calibrated is Nemotron's `clue_understood` in practice? Measure against solution grids before wiring it into the router.
- Is 3-sample self-consistency on tier 1 a better use of budget than one escalation to tier 2? They cost about the same.
- One call per clue or batches of 5-10 on the first pass? Latency-bound vs quota-bound; decide after measuring latency at 600 RPM.
- Do themed puzzles need special handling? BCS attributes much of its residual error to themes, and titles are available to us but unused above.
- Is loopy belief propagation worth adding once a large cached candidate corpus makes domains dictionary-scale?
- What is the right repair-pass scorer? Re-asking per proposal is expensive; a character n-gram model trained on the xd corpus may be an adequate free substitute, as it was for Proverb and WebCrow.
- Do we scope cryptic puzzles into v1 at all? They need a different prompt and probably a different escalation threshold.

## Sources

All URLs fetched and verified on 2026-09-02 unless marked otherwise.

1. https://cdn.aaai.org/AAAI/1999/AAAI99-101.pdf - Keim et al., "PROVERB: The Probabilistic Cruciverbalist", AAAI-99; source of 95.3% words / 98.1% letters and the module/merger/solver architecture.
2. https://aclanthology.org/2022.acl-long.219.pdf - Wallace et al., "Automated Crossword Solving", ACL 2022; source of the loopy BP and local-search details and the BP 44.3% vs BP+LS 81.7% ablation.
3. https://arxiv.org/abs/2205.09665 - arXiv listing for the same paper; abstract with 82% exact puzzle and 99.9% letter accuracy.
4. https://arxiv.org/pdf/1401.4597 - Ginsberg, "Dr.Fill"; source of the margin heuristic (eq. 10), the LDS discussion, and the 2010 ACPT figures (11,210 points, tie for 43rd; 95.8% words, 98.5% letters).
5. https://www.jair.org/index.php/jair/article/view/10741 - JAIR record confirming Dr.Fill as JAIR vol. 42 (2011).
6. https://cdn.aaai.org/AAAI/2005/AAAI05-224.pdf - Ernandes et al., "WebCrow", AAAI 2005; source of ~70%/80% average, 80.0%/90.1% on easy puzzles, and the tetragram fallback.
7. https://aclanthology.org/2025.naacl-long.104/ - Saha et al., "Language Models are Crossword Solvers", NAACL 2025; abstract and metadata.
8. https://aclanthology.org/2025.naacl-long.104.pdf - full text; source of SweepClip's pseudocode, 93.1% (+/- 14.1) character accuracy, 48% perfect puzzles, 43.5% -> 89.6% clue accuracy, per-model clue accuracies, the 76.3% hinted result, and the max_iter 30 / USD 0.50 budget.
9. https://arxiv.org/html/2504.00043v1 - CrossWordBench (2025); reasoning models exploit crossing-letter constraints while non-reasoning models do not, plus diminishing returns on test-time scaling.
10. https://arxiv.org/abs/2403.12094 - Sadallah, Kotova and Kochmar, "Are LLMs Good Cryptic Crossword Solvers?" (2024); confirms title, authors and the below-human finding. The specific 9.5% and 7% baselines come from source 8 citing it, not from this page.
11. https://en.wikipedia.org/wiki/AC-3_algorithm - AC-3: worklist mechanism, O(ed^3) time, O(e) space, role as a search prepass.
12. https://github.com/dolph/dictionary - ENABLE mirror; enable1.txt, ~172,819 words. UNVERIFIED: the repo page states no licence, so ENABLE's public-domain status is not confirmed by this URL.
13. https://github.com/Crossword-Nexus/collaborative-word-list - scored crossword word list, >425,000 `word;score` entries, MIT licence.
14. http://wordlist.aspell.net/ - SCOWL, now the English Speller Database; premade Hunspell/Aspell/plain lists and a custom list builder. UNVERIFIED: no licence stated on the landing page.
15. https://www.georgeho.org/crosswords-datasets-dictionaries/ - aggregator confirming the URLs for Peter Broda's wordlist, Spread the Wordlist, the collaborative word list and the xd corpus.
16. https://xd.saul.pw/ - the xd corpus, 94,757 published grids 1990-2026, downloadable. UNVERIFIED: the format spec at https://xd.saul.pw/docs/xd-format returned 404 on 2026-09-02.
17. https://peterbroda.me/crosswords/wordlist/ - UNVERIFIED: fetch failed on 2026-09-02 with an expired TLS certificate. Its existence and rough size (~527,000 entries) come from source 15 and secondary reporting only.
