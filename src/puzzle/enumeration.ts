import { notImplemented } from '../util/errors.js';

/**
 * T7 (B21): matches a trailing `(3,4)`-style group on the clue text. Prompt
 * only, never used for validation, and the clue text is kept verbatim.
 */
export function extractEnumeration(_clueText: string): string | undefined {
  return notImplemented('src/puzzle/enumeration.ts');
}

/** Normalises a structured source field, such as Guardian separator locations. */
export function normaliseEnumeration(_lengths: ReadonlyArray<number>): string {
  return notImplemented('src/puzzle/enumeration.ts');
}
