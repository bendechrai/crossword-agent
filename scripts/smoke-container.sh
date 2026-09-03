#!/bin/sh
# T51: human-facing container smoke check. Not run by `npm test` or CI (B48
# keeps the `image` job to a build, and this needs `docker exec` against a
# real container) - run it by hand, against the long-running `crossword-solver`
# container (`docker compose up -d` first), as a pre-release check.
#
# Override the container name with $CROSSWORD_SMOKE_CONTAINER.
#
# Two independent steps against the real `xw` binary inside the container
# (the same entry point `npm link` in the Docker image points `xw` at),
# deliberately not chained - see "Cache alignment" below for why:
#   1. `xw fetch file --path test/fixtures/puzzles/synthetic-5x5.ipuz
#      --out <fetch dir>` - proof that the `file` source and the loader
#      dispatch work end to end, all the way to a normalised puzzle file on
#      disk.
#   2. `xw --cache-dir test/fixtures/cache solve synthetic-5x5 --offline
#      --profile no-repair` against the committed cache (T50), over a puzzle
#      seeded directly into a second, separate library dir (see below), not
#      over step 1's fetch output.
#
# Separate directories, per run (fixed in review): both steps use their own
# subdirectory of a per-invocation scratch dir under the container's /tmp,
# and neither writes under the repository's own `puzzles/` at all. This is
# not just tidiness. Step 1 normalises to id `synthetic-5x5` under source
# `file` (`src/puzzle/loader.ts` derives the id from the fixture's basename)
# and step 2 seeds the same id under source `synthetic`, so pointing both at
# one puzzles dir puts two different files at the same id -
# `findNormalisedPath` (src/puzzle/library.ts) returns the FIRST
# `<source>/<id>.json` it finds in `readdirSync` order, which is not sorted,
# not stable across filesystems, and in practice returned the `file` copy -
# and step 3 then solves the wrong, cache-misaligned puzzle and fails.
# Keeping the two dirs apart makes the outcome independent of directory
# order. The scratch dir is named with this (host) shell's pid, expanded
# once here and passed to every `docker exec`, so two concurrent runs
# against the same container cannot collide either. Cleanup is therefore a
# single `rm -rf` of that one directory, with no backup-and-restore of any
# repository file (the acceptance criterion "leaves no file under puzzles/"
# holds trivially: nothing is ever written there).
#
# Fixture choice (step 1): not one of the four `puzzles/fixtures/*.xd`
# puzzles the task text names. `src/puzzle/adapters/xd.ts` always sets
# `parsedBy: 'xd-hand'`, a value `schemas/puzzle.schema.json` and
# `schemas/puzzle-index.schema.json` were never updated to allow (found and
# documented already by T29's reviewer in docs/build-notes/wave-2.md,
# "Blocking bug for real `xw fetch xd`", still unfixed) - so `xw fetch file`
# on any real `.xd` puzzle always fails schema validation. Both schema files
# are frozen for T51, so this is worked around, not fixed, by using
# `test/fixtures/puzzles/synthetic-5x5.ipuz` instead: it parses through
# `src/puzzle/adapters/xwordly.ts`, whose `parsedBy` value is schema-valid.
#
# Cache alignment (step 2): `xw fetch file` on the `.ipuz` fixture above
# normalises through `xwordly.ts` to `style: 'unknown'` and
# `title: 'synthetic-5x5.ipuz'` (T51's own PuzzleAdapterContext extension
# defaults style to 'unknown' because the frozen loader.ts never supplies
# one). Every one of T50's 386 committed cache entries, though, was
# populated against `test/fixtures/puzzles/synthetic-5x5.json` -
# `style: 'american'`, `title: 'Synthetic five'` - and
# `src/util/hash.ts`'s `cacheKeyFields` hashes both `style` and `title` into
# the cache key (B23). Solving step 1's fetch output was therefore a cache
# miss on the very first seed lookup, silently accepted as an empty domain
# by `--offline-lenient` - the check passed just the same against an empty
# or deleted cache directory (found in review). Step 2 instead copies the
# already-normalised `test/fixtures/puzzles/synthetic-5x5.json` fixture -
# the exact content the cache was populated against - straight into the
# library form (`<library dir>/<source>/<id>.json`), bypassing `xw fetch`
# entirely, so every cache key lines up.
#
# --offline, not --offline-lenient (step 2): now that the keys line up,
# a genuine miss should be a hard failure, not a silently-accepted empty
# grid - which is exactly the scenario an empty or deleted cache directory
# produced in review, undetected. `--profile no-repair`, not the default
# `baseline`: reproduced in a throwaway container, `baseline` (repair
# enabled) still fails strict --offline on this puzzle - not on a seed miss,
# but partway through the repair phase, which scores an edit-distance
# proposal via a `purpose: 'repair'` call whose cache key was never
# populated for that specific proposal, even though every seed-phase
# candidate is a cache hit and the grid is already the correct, complete
# solution. That is a real, narrow gap independent of the cache-alignment
# fix above (src/solver/repair.ts and src/candidates/service.ts are neither
# owned nor edited here). `no-repair` is one of T50's own three cached
# profiles (its seed-phase entries are the same ones `baseline` and
# `tier1-only` share, by B23's cache-key design) and skips the repair phase
# entirely, so this step converges with strict --offline. Either way,
# --offline never touches the network - it only changes what a miss does,
# not whether the transport is ever called - so this stays a fully offline
# check.
#
# NEBIUS_API_KEY: passed as a placeholder on the `docker exec` invocations
# themselves, so this passes with no real key configured (an absent or
# key-less .env): the transport needs *a* value to construct, and
# --offline guarantees it is never actually used over the network.
set -eu

CONTAINER=${CROSSWORD_SMOKE_CONTAINER:-crossword-solver}
FETCH_FIXTURE_ID=synthetic-5x5
FETCH_FIXTURE_PATH=test/fixtures/puzzles/synthetic-5x5.ipuz
FETCH_SOURCE=file
LIBRARY_FIXTURE_PATH=test/fixtures/puzzles/synthetic-5x5.json
LIBRARY_SOURCE=synthetic
LIBRARY_ID=synthetic-5x5
CACHE_DIR=test/fixtures/cache
PROFILE=no-repair
SEED=42
BUDGET_USD=0.4
# Anything below this is not a real solve of this fixture against T50's cache.
MIN_ACCURACY=0.99
PLACEHOLDER_KEY=offline-smoke-placeholder-key

WORK_DIR=/tmp/xw-smoke-$$
FETCH_DIR=$WORK_DIR/fetch
LIBRARY_DIR=$WORK_DIR/library
RUN_OUT=$WORK_DIR/run.json

fail() {
  echo "smoke-container: $1" >&2
  exit 1
}

cleanup() {
  docker exec "$CONTAINER" rm -rf "$WORK_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "smoke-container: container=$CONTAINER scratch=$WORK_DIR"

echo "smoke-container: xw fetch file --path $FETCH_FIXTURE_PATH --out $FETCH_DIR"
docker exec -e NEBIUS_API_KEY="$PLACEHOLDER_KEY" "$CONTAINER" \
  xw fetch file --path "$FETCH_FIXTURE_PATH" --out "$FETCH_DIR"

docker exec "$CONTAINER" test -f "$FETCH_DIR/$FETCH_SOURCE/$FETCH_FIXTURE_ID.json" \
  || fail "xw fetch file exited 0 but wrote no $FETCH_DIR/$FETCH_SOURCE/$FETCH_FIXTURE_ID.json"

echo "smoke-container: seeding $LIBRARY_DIR/$LIBRARY_SOURCE/$LIBRARY_ID.json"
docker exec "$CONTAINER" sh -c '
  set -eu
  library_dir=$1
  fixture=$2
  source_name=$3
  id=$4
  mkdir -p "$library_dir/$source_name"
  cp "$fixture" "$library_dir/$source_name/$id.json"
' sh "$LIBRARY_DIR" "$LIBRARY_FIXTURE_PATH" "$LIBRARY_SOURCE" "$LIBRARY_ID"

# Guards the exact defect fixed above: the solve step below must have one and
# only one candidate file for this id, or `findNormalisedPath`'s unsorted
# directory scan decides which puzzle gets solved.
copies=$(docker exec "$CONTAINER" \
  sh -c 'find "$1" -type f -name "$2.json" | wc -l' sh "$LIBRARY_DIR" "$LIBRARY_ID" \
  | tr -cd '0-9')
[ "$copies" = "1" ] \
  || fail "expected exactly one $LIBRARY_ID.json under $LIBRARY_DIR, found $copies"

echo "smoke-container: xw --cache-dir $CACHE_DIR solve $LIBRARY_ID --offline --profile $PROFILE"
set +e
output=$(docker exec \
  -e NEBIUS_API_KEY="$PLACEHOLDER_KEY" \
  -e CROSSWORD_PUZZLES_DIR="$LIBRARY_DIR" \
  "$CONTAINER" \
  xw --cache-dir "$CACHE_DIR" solve "$LIBRARY_ID" \
  --offline --profile "$PROFILE" --seed "$SEED" --budget-usd "$BUDGET_USD" \
  --no-inference-log --out "$RUN_OUT" 2>&1)
status=$?
set -e

echo "$output"

[ "$status" -eq 0 ] || fail "xw solve exited $status"

# Tightened per review: with strict --offline a miss is already a hard exit
# above, but the printed accuracy is checked for a real number rather than
# for the mere presence of the line - an all-zero empty-grid score is what an
# empty or deleted cache directory produced under the old --offline-lenient
# flow, and the old `*letters=*words=*` pattern accepted it just as happily
# as a real run.
score_line=$(printf '%s\n' "$output" \
  | grep -E 'Score: letters=[0-9.]+ words=[0-9.]+' | head -n 1 || true)
[ -n "$score_line" ] \
  || fail "expected a 'Score: letters=<n> words=<n>' line in the solve output"

letters=$(printf '%s\n' "$score_line" | sed -n 's/.*letters=\([0-9][0-9.]*\).*/\1/p')
words=$(printf '%s\n' "$score_line" | sed -n 's/.*words=\([0-9][0-9.]*\).*/\1/p')
awk -v l="$letters" -v w="$words" -v min="$MIN_ACCURACY" \
  'BEGIN { exit !(l + 0 >= min && w + 0 >= min) }' \
  || fail "accuracy below $MIN_ACCURACY, so the cache was not really used: $score_line"

# Belt and braces: the same assertion off the written run record rather than
# off stdout text, and a check that the run actually completed ('ok') instead
# of exiting 0 with a 'partial' grid.
docker exec "$CONTAINER" node -e '
  const fs = require("fs");
  const record = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const min = Number(process.argv[2]);
  if (record.status !== "ok") {
    console.error("run record status is " + record.status + ", expected ok");
    process.exit(1);
  }
  if (!(record.accuracy.letters >= min) || record.accuracy.emptyCells !== 0) {
    console.error("run record accuracy " + JSON.stringify(record.accuracy));
    process.exit(1);
  }
' "$RUN_OUT" "$MIN_ACCURACY" || fail "the run record at $RUN_OUT is not a completed, accurate run"

echo "smoke-container: $score_line"
echo "smoke-container: OK"
