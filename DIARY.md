# Build Diary

This is a running log of how this project was built, so anyone can follow or reproduce the process. New entries are appended under dated headings.

## 2026-09-02

1. **Starting point.** I opened the folder ~/Projects/crossword-agent to find it contained a single `.env` file with one variable, NEBIUS_API_KEY, and nothing else - no git repo, no code, no docs. My intent is to build a crossword agent using models hosted on Nebius Token Factory, so this diary starts from that blank slate.

2. **Working method.** I set a rule for this Claude Code session: the top-level model (Claude Fable 5.1) acts as an orchestrator that only talks to me and plans, while all the grunt work is delegated to subagents running whichever model fits the task - Haiku for simple shell and lookup work, Sonnet for routine writing and coding, Opus for hard reasoning. I did this because there is no reason to spend the expensive model's time on work a cheaper model can do just as well. I saved this preference to my Meko memory store so future sessions pick it up automatically.

3. **Tried `/init` for a contributor guide.** I ran `/init` to generate an AGENTS.md file, and a Haiku subagent inspected the repo to prepare it. It found nothing to document besides the one env var, so I decided not to write AGENTS.md yet - the generator's own rule is never to fabricate content, and anything written before there is real code or structure would just be invented. I will revisit this once the project is scaffolded.

4. **Git and GitHub setup.** A Haiku subagent set up the plumbing. It created a `.gitignore`:
```
.env
.env.*
!.env.example
```
Then it ran `git init -b main`, confirmed the env file was ignored with `git check-ignore -v .env`, and created a private GitHub repository with:
```
gh repo create crossword-agent --private --source=. --remote=origin
```
This left origin pointing at https://github.com/bendechrai/crossword-agent. Nothing was committed or pushed yet - the goal at this point was just to get the repo plumbing in place before adding real content.

5. **Licence and visibility.** I added a `LICENSE` file with the MIT License text, copyright 2026 Ben Dechrai, and decided to make the repo public. When the subagent tried to run `gh repo edit --visibility public`, Claude Code's permission classifier blocked it as a sensitive action, so I ran it myself in the main session where I could approve it directly:
```
gh repo edit bendechrai/crossword-agent --visibility public --accept-visibility-change-consequences
```
I then verified the repo's visibility came back as PUBLIC.

6. **Fetched the Nebius model catalogue.** I had a Haiku subagent pull the list of models available on Nebius Token Factory, being careful never to expose the API key in any tool output or in the conversation itself. It sourced the key from `.env` straight into the shell environment and passed it to curl in the same command:
```
set -a && . ./.env && set +a && curl -sS -f -o models.json -H "Authorization: Bearer $NEBIUS_API_KEY" 'https://api.tokenfactory.nebius.com/v1/models?verbose=true'
```
This returned HTTP 200, and the subagent validated and pretty-printed the result with `python3 -m json.tool`. The file lists 28 models under the top-level keys `object` and `data`, including Llama 3.3 70B, Qwen3 and Qwen3.5 variants, GLM 5.1 and 5.3 Flash, DeepSeek V4 Pro and Flash, Kimi K2.6, K2.7 Code and K3, gpt-oss-120b, Gemma 3 27B, Hermes 4 70B and 405B, MiniMax M3, several NVIDIA Nemotron and Cosmos models, and one embedding model, Qwen3-Embedding-8B. The purpose of pulling this list is to decide which models the crossword agent will actually use.

7. **Started this diary.** I asked for a running log of the build so someone else can see exactly how I went about it, step by step, including the tooling and the reasoning behind each decision. The orchestrator will keep appending to this file after each significant step from here on.

8. **First commits and push.** I decided that the repo should be pushed regularly with descriptive commit messages, so anyone following along can see the history unfold rather than one big dump at the end. Commit messages carry no tool attribution trailers; that is a standing rule of mine. The first push went up as three logical commits: repository plumbing (.gitignore and LICENSE), the Nebius model catalogue, and this diary.

9. **Chose the stack and started model selection.** I decided the solver will be written in Node.js. I had docs/model-selection.md generated from models.json with a script rather than by hand, so the numbers are exact: a table of the text-capable models with context, quantisation, prices per 1M tokens, rate limits, and reasoning/structured-output flags. From that I shortlisted three cheap models for a first pass - nvidia/Nemotron-3_5-Lightning, nvidia/Nemotron-3-Nano-Omni, and deepseek-ai/DeepSeek-V4-Flash-0731 - and three stronger ones - deepseek-ai/DeepSeek-V4-Pro, Qwen/Qwen3.5-397B-A17B, and zai-org/GLM-5.1 - weighting requests-per-minute heavily because a crossword solver makes many short calls.

10. **Picked the two-tier model strategy.** I settled on a simple escalation: every clue goes to nvidia/Nemotron-3_5-Lightning first, and only clues it gets wrong are escalated to deepseek-ai/DeepSeek-V4-Pro. Most clues in a standard crossword are easy, so the cheap model should handle the bulk and the expensive one only pays for the hard tail. Recorded in docs/model-selection.md.

11. **Surveyed crossword puzzle sources.** I had a subagent with web access research where to get crossword puzzles in machine-readable formats, fetching every URL it cited so nothing in the doc is guessed. docs/crossword-sources.md covers the four common file formats (.puz, .ipuz, .jpz, .xd), the npm parsers for them, and thirteen puzzle and clue sources with their variety, volume, and licensing caveats. The top three by variety came out as Saul Pwanson's xd corpus for American puzzles, the Guardian's unofficial JSON endpoint for British cryptics, and the xword-dl scraper as a meta-source across publishers. The plan is to use the licence-clean public data (the pre-1965 xd slice and open clue datasets) for bulk benchmarking and the Guardian cryptics for spot-testing.

12. **Researched crossword solving algorithms.** While the sources research was running I kicked off a second research piece on solving algorithms, this time on a stronger model because it had to synthesise the literature with my own sketch of the flow. docs/crossword-algorithms.md covers Proverb, Dr.Fill, the Berkeley Crossword Solver, WebCrow and the recent LLM-era work, with the numbers read from the papers themselves rather than search snippets. The recommended design keeps the LLM strictly as a candidate oracle: deterministic code models the grid as a constraint satisfaction problem, prunes candidate lists with arc consistency, searches with backtracking ordered by confidence margin, and finishes with a bounded local-repair pass. The critique of my sketch changed three things: self-reported confidence is a routing signal, not a probability; on a dead end, re-ask the cheap model with the letter pattern before escalating or backtracking; and when backtracking, undo the least confident crossing rather than the most recent one. It also flagged that my sketch had no repair pass, which the Berkeley ablation suggests is worth roughly half the perfect-puzzle rate. A few word-list licences could not be verified and are marked as such in the doc.

## 2026-09-03

13. **Wrote the system spec.** With the algorithm research in hand I asked for the specs to be solidified: a way to pull crosswords in, list what is held locally, solve one and show the result, verbosity flags from -v to -vvv, a live grid view while the solver works, metrics on every run, and a way to bench different models and strategies against each other. The orchestrator's design answer was to make the solver a pure state machine that emits typed events, with the LLM behind a cached candidate service; console output, the live view, run records and replay are all just subscribers to that stream. docs/spec.md turns that into module signatures, a CLI reference, an event taxonomy mapped to verbosity levels, a run-record schema, and named strategy profiles, so the question of whether to escalate early or exhaust backtracking first becomes a bench run over the same cached candidates. Two things I added mid-way: every inference request and response is logged raw to a local JSONL file, always on, so we can debug and report after the fact; and the project runs as a long-lived Docker container that you exec into, so anyone can clone it and run the solver with nothing but Docker on their machine. Assumptions I accepted: TypeScript in strict mode, npm, one model call per clue. Six milestones are laid out, starting with the grid model and puzzle loader.

14. **Talked through rate limiting and batching.** I raised two concerns: the cheap model's 600 requests per minute limit will bite a headless CLI that fires a whole puzzle's clues at once, and batching several clues per request might help or might poison the answers. We agreed the limit is a burst problem confined to the seed pass, so the design is a process-wide token bucket per model as the primary control, with every response header captured in the inference log so we can learn which rate-limit signals Nebius actually sends, and additive-increase multiplicative-decrease backoff on 429s. Batching moves from a non-goal to a supported option that defaults to 1, with three hard constraints: realign responses by clue id never by position, keep the cache per clue with the batch size in the key, and let a malformed element cost only its own clue. The crossover will be measured by benching batch sizes 1, 2, 3, 5 and 8 on the same puzzles and watching for positional drop-off, not just the average. The spec now carries both.

15. **Reviewed the spec, answered the open questions, and got an implementation plan.** Before breaking the spec into tasks I had a principal-engineer style review run over it. It found three problems that would have quietly invalidated the benches: repeats replayed identical cached responses so variance was zero by construction, cost was not comparable across profiles because whichever ran first paid for shared queries, and the cache key left out inputs that change the prompt such as the rejection list and temperature. It also caught that cryptic grids have unchecked cells, which broke four places written against "every cell has two crossings", and that the .xd format embeds the answer in the clue line. I answered the four questions that were genuinely mine: cryptics are loaded and solved but the model-strategy decisions are made on the American stratum; the Guardian endpoint is used with a one-request-per-second ceiling and a hard limit of twenty; fixtures are four hand-picked pre-1965 puzzles with a provenance file plus two synthetic grids; and the CLI is called xw with crossword as an alias. The orchestrator set defaults for the rest and recorded all of it in docs/decisions/2026-09-03-spec-review.md, then had the spec revised to version 2 and an implementation plan written against the same decisions. The plan has 55 tasks in five waves, each small enough for one coding agent to finish first time, with explicit file ownership so builders can run in parallel. I set a session goal so the orchestrator keeps going until every wave is merged and passing.

## Current state

Main is pushed to the public remote at https://github.com/bendechrai/crossword-agent. The repo contains:
- `.env` - holds NEBIUS_API_KEY, ignored by git
- `.env.example` - template with NEBIUS_API_KEY placeholder for new users
- `.gitignore` - excludes `.env` and `.env.*`, keeps `.env.example`
- `LICENSE` - MIT License, copyright 2026 Ben Dechrai
- `models.json` - the fetched Nebius Token Factory model catalogue
- `docs/model-selection.md` - model shortlist and reasoning for the Nebius catalogue
- `docs/crossword-sources.md` - sources of machine-readable crossword puzzles, file formats, and npm parsers; top three by variety
- `docs/crossword-algorithms.md` - survey of prior art in automated crossword solving and the recommended algorithm for the Node.js solver
- `docs/spec.md` - system specification, version 2, architecture, CLI reference, event taxonomy, run-record schema, strategy profiles, milestones
- `docs/plan.md` - implementation plan: 55 tasks in five waves with explicit file ownership for parallel builders
- `docs/decisions/2026-09-03-spec-review.md` - record of spec review findings and resolutions applied to v2
- `DIARY.md` - this file
