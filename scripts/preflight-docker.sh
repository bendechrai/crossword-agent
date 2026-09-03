#!/bin/sh
# Run `npm run preflight` (lint, typecheck, test) inside a THROWAWAY container
# built from this worktree.
#
# Why not `docker exec crossword-solver npm run preflight`: that container has
# a fixed name and a single bind mount, so it belongs to one checkout. Many git
# worktrees need to verify concurrently, so each gets its own image tag and its
# own short-lived container, both derived from the worktree directory name and
# the current branch.
#
# node_modules: the image installs dependencies at /app/node_modules, and the
# bind mount would shadow them. An ANONYMOUS VOLUME is mounted at that path,
# which Docker seeds from the image content, so the container sees the
# Linux-built install from the image while /app is the live worktree. The
# alternative (installing to a path outside /app and setting NODE_PATH) does
# not work for bin scripts such as tsx, vitest and eslint, which npm expects to
# find under the package's own node_modules/.bin.
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH='' cd -- "$script_dir/.." && pwd)

# Lower-case, and anything outside [a-z0-9._-] becomes a dash, so the result is
# always a legal Docker image tag and container name.
sanitise() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._-' '-'
}

dir_part=$(sanitise "$(basename "$root")")
branch=$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "no-branch")
branch_part=$(sanitise "$branch")

image="${dir_part}-${branch_part}"
container="${image}-preflight-$$"

# Pass the Nebius key through only when a .env exists (it usually will not in a
# worktree). The value is exported rather than written onto the command line,
# so the command this script prints never carries the secret.
env_flags=""
if [ -f "$root/.env" ]; then
  key_line=$(grep -E '^[[:space:]]*NEBIUS_API_KEY=' "$root/.env" | tail -n 1 || true)
  if [ -n "$key_line" ]; then
    NEBIUS_API_KEY=$(printf '%s' "$key_line" | sed -e 's/^[[:space:]]*NEBIUS_API_KEY=//' -e 's/^"//' -e 's/"$//')
    export NEBIUS_API_KEY
    env_flags="-e NEBIUS_API_KEY"
    echo "preflight: passing NEBIUS_API_KEY through from .env"
  fi
fi

echo "preflight: + docker build -t $image $root"
docker build -t "$image" "$root"

echo "preflight: + docker run --rm --name $container -v $root:/app -v /app/node_modules -w /app $env_flags $image npm run preflight"
set +e
# shellcheck disable=SC2086 # env_flags is intentionally word-split (it is empty or "-e NAME")
docker run --rm --name "$container" \
  -v "$root":/app \
  -v /app/node_modules \
  -w /app \
  $env_flags \
  "$image" npm run preflight
status=$?
set -e

echo "preflight: exit $status"
exit "$status"
