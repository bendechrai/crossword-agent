#!/bin/sh
# T51: human-facing container smoke check. Not run by `npm test` or CI (B48
# keeps the `image` job to a build, and this needs `docker exec` against a
# real container) - run it by hand, against the long-running `crossword-solver`
# container (`docker compose up -d` first), as a pre-release check.
#
# Two steps, both against the real `xw` binary inside the container (the same
# entry point `npm link` in the Docker image points `xw` at):
#   1. `xw fetch file test/fixtures/puzzles/synthetic-5x5.ipuz` - the
#      container's own `puzzles/` (bind-mounted from the repo), so this
#      doubles as proof the `file` source and the loader dispatch work end to
#      end.
#   2. `xw --cache-dir test/fixtures/cache solve synthetic-5x5 --offline-lenient`
#      against the committed cache (T50).
#
# Fixture choice: not one of the four `puzzles/fixtures/*.xd` puzzles the
# task text names. `src/puzzle/adapters/xd.ts` always sets `parsedBy:
# 'xd-hand'`, a value `schemas/puzzle.schema.json` and
# `schemas/puzzle-index.schema.json` were never updated to allow (found and
# documented already by T29's reviewer in docs/build-notes/wave-2.md,
# "Blocking bug for real `xw fetch xd`", still unfixed) - so `xw fetch file`
# on any real `.xd` puzzle always fails schema validation. Both schema files
# are frozen for T51, so this is worked around, not fixed, by using
# `test/fixtures/puzzles/synthetic-5x5.ipuz` instead: it parses through
# `src/puzzle/adapters/xwordly.ts`, whose `parsedBy` value is schema-valid,
# and it is (verified by title and clue text) the same puzzle content T50's
# committed cache was populated against.
#
# `--offline-lenient`, not strict `--offline`: T50's
# scripts/fixtures-refresh.ts module doc comment (and every entry in the
# committed test/fixtures/runs/bounds.json, all six "offlineMode": "lenient")
# documents a verified, structural gap - src/llm/tierRouter.ts sends the
# reasoning-off parameter only for purpose: 'seed', so any reask/escalate/
# repair call on the reasoning-capable tier-1 model burns its token budget on
# chain-of-thought and CandidateService never caches the resulting parse
# failure. A strict --offline replay of any committed fixture that reaches
# such a call cannot converge no matter what seed or budget is chosen; fixing
# that is outside this task (src/llm/tierRouter.ts and
# src/candidates/service.ts are neither owned nor edited here).
# --offline-lenient never touches the network either way - it only changes
# what a cache miss does, not whether the transport is ever called - so this
# is still a fully offline check.
#
# NEBIUS_API_KEY: passed as a placeholder on the `docker exec` invocations
# themselves, so this passes with no real key configured (an absent or
# key-less .env): the transport needs *a* value to construct, and
# --offline-lenient guarantees it is never actually used over the network.
#
# Cleanup: everything this script adds under puzzles/ (the two file-source
# copies, and puzzles/index.json - restored to its prior content, or removed
# if it did not previously exist) is undone again before this script exits,
# per this task's acceptance criteria. The backup lives at a fixed path
# rather than one keyed by this script's own PID, because the fetch step and
# the cleanup step below are two separate `docker exec` invocations (so two
# separate container-side shell PIDs) that both need to agree on the name.
set -eu

CONTAINER=${CROSSWORD_SMOKE_CONTAINER:-crossword-solver}
FIXTURE_ID=synthetic-5x5
FIXTURE_PATH=test/fixtures/puzzles/synthetic-5x5.ipuz
PLACEHOLDER_KEY=offline-smoke-placeholder-key
INDEX_BACKUP=/tmp/xw-smoke-index-backup.json
HAD_INDEX_MARKER=/tmp/xw-smoke-had-index

cleanup() {
  docker exec "$CONTAINER" sh -c '
    fixture_id="'"$FIXTURE_ID"'"
    index_path="puzzles/index.json"
    index_backup="'"$INDEX_BACKUP"'"
    had_index_marker="'"$HAD_INDEX_MARKER"'"
    had_index=0
    [ -f "$had_index_marker" ] && had_index=$(cat "$had_index_marker")

    rm -f "puzzles/file/${fixture_id}.ipuz" "puzzles/file/${fixture_id}.json" \
      /tmp/smoke-run.json "$had_index_marker"
    if [ "$had_index" = "1" ]; then
      mv "$index_backup" "$index_path"
    else
      rm -f "$index_path" "$index_backup"
    fi
  ' 2>/dev/null || true
}
trap cleanup EXIT

echo "smoke-container: xw fetch file ${FIXTURE_PATH}"
docker exec -e NEBIUS_API_KEY="$PLACEHOLDER_KEY" "$CONTAINER" sh -c '
  set -eu
  fixture_path="'"$FIXTURE_PATH"'"
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

echo "smoke-container: xw solve ${FIXTURE_ID} --offline-lenient"
set +e
output=$(docker exec -e NEBIUS_API_KEY="$PLACEHOLDER_KEY" "$CONTAINER" \
  xw --cache-dir test/fixtures/cache solve "$FIXTURE_ID" --offline-lenient \
  --seed 42 --budget-usd 0.4 --no-inference-log --out /tmp/smoke-run.json)
status=$?
set -e

echo "$output"

if [ "$status" -ne 0 ]; then
  echo "smoke-container: xw solve exited $status" >&2
  exit "$status"
fi

case "$output" in
  *"letters="*"words="*) : ;;
  *)
    echo "smoke-container: expected output to contain letters= and words= accuracy lines" >&2
    exit 1
    ;;
esac

echo "smoke-container: OK"
