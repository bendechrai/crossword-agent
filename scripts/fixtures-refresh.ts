import { notImplemented } from '../src/util/errors.js';

/**
 * T50 (B49): regenerates the committed candidate cache under
 * `test/fixtures/cache/` and the accuracy snapshots under
 * `test/fixtures/runs/snapshots/` together, in one commit, so the two can
 * never drift apart. This is a network task, run deliberately, never in CI.
 */
export function refreshFixtures(): Promise<void> {
  return notImplemented('scripts/fixtures-refresh.ts');
}

await refreshFixtures();
