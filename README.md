# crossword-agent

A Node.js crossword solver that treats an LLM as a candidate oracle wrapped in a
deterministic constraint search, instrumented well enough to answer strategy
questions with measurements rather than opinions.

- [docs/spec.md](docs/spec.md) - the system specification, and the contract the
  code implements.
- [docs/plan.md](docs/plan.md) - the task queue the implementation is built
  from.
- [docs/crossword-algorithms.md](docs/crossword-algorithms.md) - prior art and
  the algorithm the solver implements.

Development is Docker-only. Nothing is installed on the host but Docker: no
Node, no npm.

## Quick start

```
git clone <repo> && cd crossword-agent
cp .env.example .env            # then add NEBIUS_API_KEY
docker compose up -d
./xw fetch guardian --series quick --limit 5
./xw solve guardian-quick-17342 -v
```

`docker compose up -d` builds a `node:22-slim` image, installs dependencies
with `npm ci`, links the package so that `xw` (and its `crossword` alias) is on
`PATH` inside a long-running container named `crossword-solver`, and leaves it
up on `sleep infinity`. You then exec into it:

```
docker exec -it crossword-solver xw solve guardian-cryptic-30085 -vv
docker exec -it crossword-solver npm test
```

`./xw <args>` is one line of sugar over `docker exec -it crossword-solver xw
<args>`; the two forms are always equivalent. `-it` matters: the `--watch`
renderer needs a TTY, and falls back to plain console output without one.

The source tree, `puzzles/`, `runs/`, `logs/`, `data/` and `cache/candidates/`
are bind-mounted, so edits apply immediately and data survives a rebuild. Only
`node_modules` lives in a named volume, so a Linux-built install is never
overwritten by a macOS one.

### After a dependency change

The container entrypoint records the sha256 of `package-lock.json` in the
`node_modules` volume and re-runs `npm ci` whenever the hash differs, so a
dependency change is picked up on the next `docker compose restart solver` with
no manual step. If the volume is ever wedged beyond that, the sledgehammer is:

```
docker compose down -v && docker compose up -d
```

## Puzzle data and sources

**Fetched puzzles are never committed.** `puzzles/<source>/` is gitignored;
only the hand-picked fixtures under `puzzles/fixtures/` are in the repository,
each with its provenance recorded in `puzzles/fixtures/FIXTURES.md`. Run
records, inference logs and the candidate cache are not committed either.

The Guardian adapter reads an unofficial JSON endpoint and is deliberately
constrained to personal-research volumes: it sends a descriptive `User-Agent`
of `crossword-agent/<version> (+https://github.com/bendechrai/crossword-agent;
personal research)`, holds itself to a hard ceiling of one request per second,
defaults `--limit` to 1 with a hard maximum of 20, and has no archive-backfill
command. It is for personal research, and puzzles fetched with it are not
redistributed.

## For contributors and coding agents

Verify your work with:

```
./scripts/preflight-docker.sh
```

It builds an image from the current directory and runs `npm run preflight`
(which is exactly `npm run lint && npm run typecheck && npm test`) inside a
**throwaway** container, then exits with that container's exit code. The image
tag and container name are derived from the directory name plus the current
branch, so many git worktrees can verify concurrently without colliding and
without touching the long-running `crossword-solver` container, whose fixed
name belongs to the main checkout. The repository is bind-mounted at `/app` and
an anonymous volume keeps the image's `node_modules` visible underneath it.
`NEBIUS_API_KEY` is passed through from `.env` only when that file exists,
which in a worktree it usually will not.

Day to day, the long-running container plus `./xw` is the faster loop:
`docker compose up -d` once, then `./xw ...` and `docker exec -it
crossword-solver npm run preflight` for as long as you are working. Use
`scripts/preflight-docker.sh` when you are working in a worktree, or when you
want the checks to run against a clean image build.

Working rules that matter to a coding agent:

- Work only inside your task's **Owns** list in `docs/plan.md`. A file you do
  not own is read-only, even for a one-line type widening; that is a
  contract-fix task instead.
- `package.json` is frozen after task T0. Every script and dependency any later
  task needs is already declared.
- ASCII only in source, tests and docs: no em dashes, no curly quotes.
- No network in tests.

## Licence

MIT. See [LICENSE](LICENSE).
