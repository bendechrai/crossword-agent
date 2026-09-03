/**
 * Matches a trailing enumeration group: an opening paren, one or more
 * digit groups separated by `,`, `-` or whitespace, a closing paren, and
 * optionally one trailing word (for example "(3,4) hyphenated"). The group
 * must be the very end of the string (aside from trailing whitespace), so a
 * parenthetical elsewhere in the clue - "(see 4 down)" - never matches.
 */
const ENUMERATION_RE = /\(\s*\d+(?:(?:\s*[,-]\s*|\s+)\d+)*\s*\)(?:\s+[A-Za-z]+)?\s*$/;

/**
 * T7 (B21): matches a trailing `(3,4)`-style group on the clue text. Prompt
 * only, never used for validation, and the clue text is kept verbatim.
 */
export function extractEnumeration(clueText: string): string | undefined {
  const match = ENUMERATION_RE.exec(clueText);
  return match === null ? undefined : match[0].trim();
}

/** Normalises a structured source field, such as Guardian separator locations. */
export function normaliseEnumeration(lengths: ReadonlyArray<number>): string {
  return `(${lengths.join(',')})`;
}
