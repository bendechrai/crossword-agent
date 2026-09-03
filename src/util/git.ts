import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { repoRoot } from './fs.js';

const HEX40 = /^[0-9a-f]{40}$/;

/** `.git` as a plain directory, or the `gitdir: <path>` pointer a worktree checkout uses. */
function resolveGitDir(root: string): string | null {
  const dotGit = join(root, '.git');
  try {
    const stats = statSync(dotGit);
    if (stats.isDirectory()) return dotGit;
    if (stats.isFile()) {
      const text = readFileSync(dotGit, 'utf8').trim();
      const match = /^gitdir:\s*(.+)$/.exec(text);
      if (match) {
        const target = match[1] ?? '';
        if (target.length === 0) return null;
        return isAbsolute(target) ? target : join(root, target);
      }
    }
  } catch {
    // Fall through to the caller's fallbacks; provenance never fails a run.
  }
  return null;
}

/**
 * `<gitDir>/commondir`, present only in a worktree's per-worktree gitdir. It
 * names the common gitdir (typically `../..`) where refs, packed-refs, and
 * objects actually live; the per-worktree gitdir holds only HEAD and other
 * worktree-local state.
 */
function resolveCommonDir(gitDir: string): string | null {
  try {
    const text = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    if (text.length === 0) return null;
    return isAbsolute(text) ? text : join(gitDir, text);
  } catch {
    return null;
  }
}

/** A loose ref file, `<gitDir>/<ref>` (for example `refs/heads/main`). */
function readLooseRef(gitDir: string, ref: string): string | null {
  try {
    const text = readFileSync(join(gitDir, ref), 'utf8').trim();
    return HEX40.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** `<gitDir>/packed-refs`: lines are `<hash> <ref>`, with `#`/`^` lines to skip. */
function readPackedRef(gitDir: string, ref: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(gitDir, 'packed-refs'), 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('^')) continue;
    const spaceIndex = trimmed.indexOf(' ');
    if (spaceIndex === -1) continue;
    const hash = trimmed.slice(0, spaceIndex);
    const refName = trimmed.slice(spaceIndex + 1).trim();
    if (refName === ref && HEX40.test(hash)) return hash;
  }
  return null;
}

/**
 * T17 (B30): read `.git/HEAD`, follow the ref, fall back to
 * `.git/packed-refs`, then `$GIT_COMMIT`, then `"unknown"`. Also follows a
 * worktree's `gitdir:` pointer file, then its `commondir` when the
 * per-worktree gitdir has no ref for HEAD itself (refs live in the common
 * dir for a worktree checkout, which is this repo's own layout). No git
 * binary is invoked, because the container does not have one, and
 * provenance never fails a run.
 */
export function readGitCommit(root?: string): string {
  const base = root ?? repoRoot();
  try {
    const gitDir = resolveGitDir(base);
    if (gitDir) {
      const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
      if (HEX40.test(head)) return head;
      const refMatch = /^ref:\s*(.+)$/.exec(head);
      if (refMatch) {
        const ref = (refMatch[1] ?? '').trim();
        if (ref.length > 0) {
          const loose = readLooseRef(gitDir, ref);
          if (loose) return loose;
          const packed = readPackedRef(gitDir, ref);
          if (packed) return packed;
          // Worktree checkouts keep only HEAD in the per-worktree gitdir;
          // refs and packed-refs live in the common dir named by
          // `<gitDir>/commondir` (see resolveCommonDir).
          const commonDir = resolveCommonDir(gitDir);
          if (commonDir) {
            const commonLoose = readLooseRef(commonDir, ref);
            if (commonLoose) return commonLoose;
            const commonPacked = readPackedRef(commonDir, ref);
            if (commonPacked) return commonPacked;
          }
        }
      }
    }
  } catch {
    // Never throw: fall through to the environment and then "unknown".
  }
  const envCommit = process.env.GIT_COMMIT;
  if (envCommit !== undefined && envCommit.trim().length > 0) return envCommit.trim();
  return 'unknown';
}
