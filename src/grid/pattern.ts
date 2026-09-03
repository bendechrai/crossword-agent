/**
 * T5: pattern strings and their regex form.
 *
 * A pattern is a fixed-length string of `A-Z` (a known letter) and `?` (an
 * unknown letter) - see spec.md's "Data model" (`Grid.patternFor` /
 * `Grid.regexFor`) and crossword-algorithms.md's "Problem model" worked
 * example (`A?I?N` -> `/^A[A-Z]I[A-Z]N$/`). `?` is the only wildcard; any
 * other character is a caller bug and throws rather than silently
 * mismatching.
 */

/** Only `A-Z` and `?` are legal pattern characters (decision: `?` is the sole wildcard). */
const VALID_PATTERN = /^[A-Z?]*$/;

function assertValidPattern(pattern: string): void {
  if (!VALID_PATTERN.test(pattern)) {
    throw new Error(
      `invalid pattern (only A-Z and '?' are allowed): ${JSON.stringify(pattern)}`,
    );
  }
}

/**
 * `['A', null, 'I', null, 'N']` -> `"A?I?N"`. Each entry is either a single
 * uppercase letter or `null` for unknown.
 */
export function buildPattern(letters: ReadonlyArray<string | null>): string {
  return letters
    .map((letter) => {
      if (letter === null) return '?';
      if (!/^[A-Z]$/.test(letter)) {
        throw new Error(`invalid letter in buildPattern: ${JSON.stringify(letter)}`);
      }
      return letter;
    })
    .join('');
}

/**
 * Memoised by pattern string (decision: `patternMatches` is the hot path and
 * must not allocate a new RegExp per call). One process-wide cache is
 * intentional: patterns recur heavily during backtracking, and there is no
 * per-run state that would make sharing it across callers wrong.
 */
const regexCache = new Map<string, RegExp>();

/** `"A?I?N"` -> `/^A[A-Z]I[A-Z]N$/`. Anchored and case-sensitive on uppercase. */
export function regexFromPattern(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;

  assertValidPattern(pattern);
  const source = pattern.replace(/[A-Z?]/g, (ch) => (ch === '?' ? '[A-Z]' : ch));
  const regex = new RegExp(`^${source}$`);
  regexCache.set(pattern, regex);
  return regex;
}

/** Whether `word` matches `pattern` (exact length, fixed letters equal, `?` open). */
export function patternMatches(pattern: string, word: string): boolean {
  return regexFromPattern(pattern).test(word);
}

/** True when `pattern` has no `?` left, i.e. every letter is known. */
export function isFullyFixed(pattern: string): boolean {
  assertValidPattern(pattern);
  return !pattern.includes('?');
}

/** Count of non-`?` characters in `pattern`. */
export function fixedLetterCount(pattern: string): number {
  assertValidPattern(pattern);
  let count = 0;
  for (const ch of pattern) {
    if (ch !== '?') count += 1;
  }
  return count;
}
