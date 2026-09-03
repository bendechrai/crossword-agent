import { notImplemented } from '../util/errors.js';

/** T5: `['A', null, 'I', null, 'N']` -> `"A?I?N"`. */
export function buildPattern(_letters: ReadonlyArray<string | null>): string {
  return notImplemented('src/grid/pattern.ts');
}

/** `"A?I?N"` -> `/^A[A-Z]I[A-Z]N$/`, memoised by pattern string. */
export function regexFromPattern(_pattern: string): RegExp {
  return notImplemented('src/grid/pattern.ts');
}

export function patternMatches(_pattern: string, _word: string): boolean {
  return notImplemented('src/grid/pattern.ts');
}

export function isFullyFixed(_pattern: string): boolean {
  return notImplemented('src/grid/pattern.ts');
}

export function fixedLetterCount(_pattern: string): number {
  return notImplemented('src/grid/pattern.ts');
}
