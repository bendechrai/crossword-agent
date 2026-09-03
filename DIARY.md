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

## Current state

Main is pushed to the public remote at https://github.com/bendechrai/crossword-agent. The repo contains:
- `.env` - holds NEBIUS_API_KEY, ignored by git
- `.gitignore` - excludes `.env` and `.env.*`, keeps `.env.example`
- `LICENSE` - MIT License, copyright 2026 Ben Dechrai
- `models.json` - the fetched Nebius Token Factory model catalogue
- `docs/model-selection.md` - model shortlist and reasoning for the Nebius catalogue
- `docs/crossword-sources.md` - sources of machine-readable crossword puzzles, file formats, and npm parsers; top three by variety
- `DIARY.md` - this file
