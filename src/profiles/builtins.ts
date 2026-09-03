import { notImplemented } from '../util/errors.js';
import type { Profile } from './schema.js';

/**
 * T23 (B8): every built-in as a complete literal object typechecked against
 * `Profile` - `baseline`, `eager-escalation`, `patient`, `no-repair`,
 * `tier1-only`, `strong-only`, `votes3`, `batch1`, `batch2`, `batch3`,
 * `batch5`, `batch8`.
 *
 * Exposed as functions rather than a const map so that this stub can throw on
 * use instead of on import.
 */
export function getBuiltins(): Record<string, Profile> {
  return notImplemented('src/profiles/builtins.ts');
}

export function getBuiltin(_name: string): Profile {
  return notImplemented('src/profiles/builtins.ts');
}

export function builtinNames(): string[] {
  return notImplemented('src/profiles/builtins.ts');
}
