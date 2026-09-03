#!/bin/sh
# Container entrypoint (B48).
#
# node_modules lives in a volume, so it can drift from the bind-mounted
# package-lock.json. Compare the lock file's sha256 with the hash recorded in
# the volume and re-run `npm ci` when they differ, then record the new hash.
#
# A mismatch this script cannot fix is logged and ignored: the container must
# never fail to start over a dependency check.
set -eu

APP_DIR=${APP_DIR:-/app}
LOCK_FILE="$APP_DIR/package-lock.json"
MODULES_DIR="$APP_DIR/node_modules"
HASH_FILE="$MODULES_DIR/.lockhash"

log() {
  echo "entrypoint: $1"
}

check_lockfile() {
  if [ ! -f "$LOCK_FILE" ]; then
    log "no package-lock.json at $LOCK_FILE, skipping dependency check"
    return 0
  fi

  current=$(sha256sum "$LOCK_FILE" | cut -d ' ' -f 1)
  recorded=""
  if [ -f "$HASH_FILE" ]; then
    recorded=$(cat "$HASH_FILE" 2>/dev/null || true)
  fi

  if [ "$current" = "$recorded" ]; then
    log "lockfile unchanged"
    return 0
  fi

  log "lockfile changed, running npm ci"
  if (cd "$APP_DIR" && npm ci); then
    mkdir -p "$MODULES_DIR"
    printf '%s\n' "$current" >"$HASH_FILE"
    log "dependencies reinstalled"
  else
    log "npm ci failed, continuing with the node_modules already in the volume"
  fi
  return 0
}

check_lockfile

exec "$@"
