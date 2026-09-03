# Development image for the crossword solver.
#
# The pattern is a long-running container that you exec into, not one-shot
# `docker compose run` invocations. The repository is bind-mounted over /app at
# run time, so source edits apply immediately with no rebuild.
FROM node:22-slim

ENV NODE_ENV=development
WORKDIR /app

# Dependencies are installed into the image. At run time /app is replaced by
# the bind mount, so /app/node_modules is masked by a volume: a named volume
# for the compose service, an anonymous volume for scripts/preflight-docker.sh.
# Docker seeds a fresh volume from the image content at that path, so this
# Linux-built install is what every container ends up using and the host tree
# stays clean.
COPY package.json package-lock.json ./
RUN npm ci \
  # Record the lock hash the entrypoint compares against (B48), so a container
  # whose volume was seeded from this image skips the reinstall.
  && sha256sum package-lock.json | cut -d ' ' -f 1 >node_modules/.lockhash

# The rest of the tree, so the image also works without the bind mount (CI
# builds it to prove it builds, and nothing else).
COPY . .

# npm link puts the package bins (xw, and the crossword alias) on PATH. They
# resolve back to /app, which is the bind mount at run time.
RUN npm link

# tsx and vitest live in the volume-mounted node_modules; having .bin on PATH
# means `tsx`, `vitest` and `eslint` work from an interactive shell too.
ENV PATH=/app/node_modules/.bin:$PATH

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["sleep", "infinity"]
