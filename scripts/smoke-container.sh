#!/bin/sh
# T51: human-facing container smoke check. Not run by `npm test` or CI (B48
# keeps the `image` job to a build, and this needs `docker exec` against a
# real container) - run it by hand, against the long-running `crossword-solver`
# container (`docker compose up -d` first), as a pre-release check.
#
# Two independent steps against the real `xw` binary inside the container
# (the same entry point `npm link` in the Docker image points `xw` at),
# deliberately not chained - see "Cache alignment" below for why:
#   1. `xw fetch file test/fixtures/puzzles/synthetic-5x5.ipuz` - the
#      container's own `puzzles/` (bind-mounted from the repo), so this
#      doubles as proof the `file` source and the loader dispatch work end to
#      end.
#   2. `xw --cache-dir test/fixtures/cache solve synthetic-5x5 --offline
#      --profile no-repair` against the committed cache (T50), against a
#      puzzle seeded directly into the library (see below), not against
#      step 1's fetch output.
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
# library form (`puzzles/<source>/<id>.json`), bypassing `xw fetch`
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
#
# Cleanup: everything this script adds under puzzles/ (the fetch step's
# file-source copies, the library-seeded puzzle file for the solve step, and
# puzzles/index.json - restored to its prior content, or removed if it did
# not previously exist) is undone again before this script exits, per this
# task's acceptance criteria. The backups live at fixed paths rather than
# ones keyed by this script's own PID, because the two steps and the cleanup
# step below are separate `docker exec` invocations (so separate
# container-side shell PIDs) that all need to agree on the names.
set -eu

CONTAINER=${CROSSWORD_SMOKE_CONTAINER:-crossword-solver}
FETCH_FIXTURE_ID=synthetic-5x5
FETCH_FIXTURE_PATH=test/fixtures/puzzles/synthetic-5x5.ipuz
LIBRARY_FIXTURE_PATH=test/fixtures/puzzles/synthetic-5x5.json
LIBRARY_SOURCE=synthetic
LIBRARY_ID=synthetic-5x5
PLACEHOLDER_KEY=offline-smoke-placeholder-key
INDEX_BACKUP=/tmp/xw-smoke-index-backup.json
HAD_INDEX_MARKER=/tmp/xw-smoke-had-index
HAD_LIBRARY_MARKER=/tmp/xw-smoke-had-library

cleanup() {
  docker exec "$CONTAINER" sh -c '
    fetch_fixture_id="'"$FETCH_FIXTURE_ID"'"
    library_source="'"$LIBRARY_SOURCE"'"
    library_id="'"$LIBRARY_ID"'"
    index_path="puzzles/index.json"
    index_backup="'"$INDEX_BACKUP"'"
    had_index_marker="'"$HAD_INDEX_MARKER"'"
    had_library_marker="'"$HAD_LIBRARY_MARKER"'"
    had_index=0
    [ -f "$had_index_marker" ] && had_index=$(cat "$had_index_marker")

    rm -f "puzzles/file/${fetch_fixture_id}.ipuz" "puzzles/file/${fetch_fixture_id}.json" \
      /tmp/smoke-run.json "$had_index_marker"

    # The library file this script seeds did not exist before (a fresh id);
    # only remove it, and only the directory this script itself created.
    if [ -f "$had_library_marker" ]; then
      rm -f "puzzles/${library_source}/${library_id}.json"
      rmdir "puzzles/${library_source}" 2>/dev/null || true
      rm -f "$had_library_marker"
    fi

    if [ "$had_index" = "1" ]; then
      mv "$index_backup" "$index_path"
    else
      rm -f "$index_path" "$index_backup"
    fi
  ' 2>/dev/null || true
}
trap cleanup EXIT

echo "smoke-container: xw fetch file ${FETCH_FIXTURE_PATH}"
docker exec -e NEBIUS_API_KEY="$PLACEHOLDER_KEY" "$CONTAINER" sh -c '
  set -eu
  fixture_path="'"$FETCH_FIXTURE_PATH"'"
  index_path="puzzles/index.json"
  index_backup="'"$INDEX_BACKUP"'"
  had_index_marker="'"$HAD_INDEX_MARKER"'"

  if [ -f "$index_path" ]; then
    cp "$index_path" "$index_backup"
    echo 1 >"$had_index_marker"
  else
    echo 0 >"$had_index_marker"
  fi

  xw fetch file --path "$fixture_path"
'

echo "smoke-container: seeding library puzzle for the offline solve"
docker exec "$CONTAINER" sh -c '
  set -eu
  library_fixture_path="'"$LIBRARY_FIXTURE_PATH"'"
  library_source="'"$LIBRARY_SOURCE"'"
  library_id="'"$LIBRARY_ID"'"
  had_library_marker="'"$HAD_LIBRARY_MARKER"'"
  library_path="puzzles/${library_source}/${library_id}.json"

  if [ -f "$library_path" ]; then
    echo "smoke-container: ${library_path} already exists - refusing to overwrite" >&2
    exit 1
  fi
  echo 1 >"$had_library_marker"
  mkdir -p "puzzles/${library_source}"
  cp "$library_fixture_path" "$library_path"
'

echo "smoke-container: xw solve ${LIBRARY_ID} --offline --profile no-repair"
set +e
output=$(docker exec -e NEBIUS_API_KEY="$PLACEHOLDER_KEY" "$CONTAINER" \
  xw --cache-dir test/fixtures/cache solve "$LIBRARY_ID" --offline --profile no-repair \
  --seed 42 --budget-usd 0.4 --no-inference-log --out /tmp/smoke-run.json)
status=$?
set -e

echo "$output"

if [ "$status" -ne 0 ]; then
  echo "smoke-container: xw solve exited $status" >&2
  exit "$status"
fi

# Tightened per review: with strict --offline a miss is already a hard exit
# above, but this stays as a second, independent check that the printed
# accuracy is a real one, not an all-zero empty-grid line (which is what an
# empty or deleted cache directory produced under the old --offline-lenient
# flow, and which the old `*letters=*words=*` pattern accepted just as
# happily as a real run).
case "$output" in
  *"letters=0.000 words=0.000"*)
    echo "smoke-container: got an empty-grid score (letters=0.000 words=0.000) - solve did not actually use the cache" >&2
    exit 1
    ;;
  *"letters="*"words="*) : ;;
  *)
    echo "smoke-container: expected output to contain letters= and words= accuracy lines" >&2
    exit 1
    ;;
esac

echo "smoke-container: OK"
