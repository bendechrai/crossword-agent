# Bench sets: no-distribution policy and fetch recipes

**No-distribution policy.** Every file under `sets/` names puzzles by `id` and
`stratum` only (`{ id, stratum }`, nothing else) - no clue text, no grid, no
solution, no puzzle file of any kind. A bench set is a shopping list, not a
puzzle archive: only `xw fetch` writes puzzles into `puzzles/<source>/`, which
is entirely gitignored, so the actual puzzle content for any real id in
`sets/mixed-12.json` or `sets/modern-12.json` never touches this repository,
whether as a puzzle file, a run record, a snapshot, or a cache entry. `xw
bench <set>` never fetches: it only reads whatever is already in the local
library, and reports `bench: could not load puzzle "<id>"` for any set entry
that has not been fetched yet - so the recipes below must be run, via `xw
fetch`, before benching either `sets/mixed-12.json` or `sets/modern-12.json`.
This applies even though the ids themselves are real and public
(`xd-lat2024-01-08`, `guardian-cryptic-30100`, and so on) - an id is not
puzzle content, and `test/contract/sets.test.ts` enforces the shape
(`id`/`stratum` keys only, per set) so a future edit cannot smuggle content in
under a new key.

Below is the exact, reproducible recipe for every committed set: what to run,
in order, to reconstruct the puzzles each set's ids refer to. Nothing below is
run by CI or by any test - it is a manual, local, personal-research step, and
its output never leaves the machine it runs on.

## `sets/mixed-30.json`

Every entry is still a placeholder (`TODO-american-NN` / `TODO-cryptic-NN`,
per T52/T56) - no real ids have been chosen for this set yet, so there is no
fetch recipe to give here. Once real ids are picked (a 20 american / 10
cryptic american+Guardian mix, per the "Strategy profiles" bench design in
docs/spec.md), the recipe follows the same two-step shape as `mixed-12.json`
and `modern-12.json` below: an `xw fetch xd` line per american date and one
`xw fetch guardian` line for the cryptic ids.

## `sets/mixed-12.json`

The first real bench set: 8 pre-1965 NYT dailies (one per year, 1951-1964)
plus 4 Guardian cryptics (30100-30103). This is the historical set kept for
comparison (see docs/benches/README.md); `modern-12` below is the standard
set going forward.

**1. Download the xd corpus** (once; the same archive serves every american
date in every set below):

```
mkdir -p corpora
curl -L -o corpora/xd-puzzles.zip https://xd.saul.pw/xd-puzzles.zip
```

`xd-puzzles.zip` is the whole corpus - about 175 MB, roughly 89,000 puzzles
across 32 publishers, 1942-2025 - not a pre-filtered slice; the `--from`/`--to`
window below is what selects a single day. `corpora/` is gitignored, so this
file never gets committed.

**2. Fetch one line per NYT date.** The xd source has no publisher filter, so
a single-day window returns every publisher's puzzle for that day; `--limit
400` is generous enough to cover all of them, and only the `xd-nyt...` id from
each day's results is the one this set actually uses (the other publishers
fetched the same day are harmless, unused local files):

```
docker exec crossword-solver xw fetch xd --path corpora/xd-puzzles.zip --from 1951-01-02 --to 1951-01-02 --limit 400
docker exec crossword-solver xw fetch xd --path corpora/xd-puzzles.zip --from 1953-01-01 --to 1953-01-01 --limit 400
docker exec crossword-solver xw fetch xd --path corpora/xd-puzzles.zip --from 1955-01-03 --to 1955-01-03 --limit 400
docker exec crossword-solver xw fetch xd --path corpora/xd-puzzles.zip --from 1957-01-01 --to 1957-01-01 --limit 400
docker exec crossword-solver xw fetch xd --path corpora/xd-puzzles.zip --from 1959-01-01 --to 1959-01-01 --limit 400
docker exec crossword-solver xw fetch xd --path corpora/xd-puzzles.zip --from 1961-01-02 --to 1961-01-02 --limit 400
docker exec crossword-solver xw fetch xd --path corpora/xd-puzzles.zip --from 1963-01-01 --to 1963-01-01 --limit 400
docker exec crossword-solver xw fetch xd --path corpora/xd-puzzles.zip --from 1964-01-01 --to 1964-01-01 --limit 400
```

**3. Fetch the 4 Guardian cryptics:**

```
docker exec crossword-solver xw fetch guardian --series cryptic --limit 4
```

The Guardian source's `list()` walks ids backward from whatever the latest
cryptic id is at fetch time, so `--limit 4` returns the 4 *most recent*
cryptics, not a fixed set. At the time this set was built (2026-09-04) those
were `guardian-cryptic-30100` through `guardian-cryptic-30103`, which is what
`sets/mixed-12.json` names. A later re-fetch, once newer cryptics have been
published, will need a larger `--limit` to reach back to these same four ids
(the adapter caps `--limit` at 20 per docs/spec.md's "Puzzle library and
sources", and refuses anything above that as a usage error) - past that point,
these four specific puzzles are no longer reachable through `--series cryptic
--limit N` alone and would need to be fetched by their own ids if the source
adapter grows an id-list mode later.

**4. Verify:**

```
docker exec crossword-solver xw list --json
```

confirms all 12 ids from `sets/mixed-12.json` are present locally (`source`,
`style` and `date` fields let you spot-check the 8 american entries landed
with `style: "american"` and the right `date`, and the 4 cryptic entries with
`style: "cryptic"`).

## `sets/modern-12.json`

The standard bench set going forward: 8 2024 Los Angeles Times weekday
dailies plus the same 4 Guardian cryptics as `mixed-12`.

**1. Download the xd corpus**, same as above (skip if already downloaded).

**2. Fetch one line per LA Times date.** Same shape as `mixed-12`: a
single-day window over every publisher, filtered afterward to the `xd-lat...`
id:

```
docker exec crossword-solver xw fetch xd --path corpora/xd-puzzles.zip --from 2024-01-08 --to 2024-01-08 --limit 400
docker exec crossword-solver xw fetch xd --path corpora/xd-puzzles.zip --from 2024-02-14 --to 2024-02-14 --limit 400
docker exec crossword-solver xw fetch xd --path corpora/xd-puzzles.zip --from 2024-03-21 --to 2024-03-21 --limit 400
docker exec crossword-solver xw fetch xd --path corpora/xd-puzzles.zip --from 2024-04-26 --to 2024-04-26 --limit 400
docker exec crossword-solver xw fetch xd --path corpora/xd-puzzles.zip --from 2024-06-10 --to 2024-06-10 --limit 400
docker exec crossword-solver xw fetch xd --path corpora/xd-puzzles.zip --from 2024-07-17 --to 2024-07-17 --limit 400
docker exec crossword-solver xw fetch xd --path corpora/xd-puzzles.zip --from 2024-09-11 --to 2024-09-11 --limit 400
docker exec crossword-solver xw fetch xd --path corpora/xd-puzzles.zip --from 2024-11-14 --to 2024-11-14 --limit 400
```

**3. Fetch the 4 Guardian cryptics** (identical to `mixed-12`'s step 3 above,
and the identical ids if run before the latest cryptic moves past
`guardian-cryptic-30103`):

```
docker exec crossword-solver xw fetch guardian --series cryptic --limit 4
```

**4. Verify:**

```
docker exec crossword-solver xw list --json
```

confirms all 12 `modern-12` ids are present locally, 8 with `style:
"american"` and dates in 2024, 4 with `style: "cryptic"`.

## What stays local

Every step above writes only into gitignored paths: the corpus archive under
`corpora/`, fetched puzzles under `puzzles/<source>/`, the candidate cache
under `cache/candidates/`, inference logs under `logs/inference/`, and run
records under `runs/`. `git status` after running any of these recipes should
show nothing new to commit; if it does, something has gone wrong with the
no-distribution policy above, not with these instructions.
