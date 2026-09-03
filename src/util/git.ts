import { notImplemented } from './errors.js';

/**
 * T17 (B30): read `.git/HEAD`, follow the ref, fall back to
 * `.git/packed-refs`, then `$GIT_COMMIT`, then `"unknown"`. No git binary is
 * invoked, because the container does not have one, and provenance never
 * fails a run.
 */
export function readGitCommit(_root?: string): string {
  return notImplemented('src/util/git.ts');
}
