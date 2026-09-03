import { describe, expect, it } from 'vitest';

import {
  buildPattern,
  fixedLetterCount,
  isFullyFixed,
  patternMatches,
  regexFromPattern,
} from '../../../src/grid/pattern.js';

describe('buildPattern', () => {
  it('turns known letters and nulls into a pattern string (acceptance 1)', () => {
    expect(buildPattern(['A', null, 'I', null, 'N'])).toBe('A?I?N');
  });

  it('produces an all-? pattern for an all-unknown slot', () => {
    expect(buildPattern([null, null, null])).toBe('???');
  });

  it('produces a fully-fixed pattern when every letter is known', () => {
    expect(buildPattern(['A', 'L', 'I', 'E', 'N'])).toBe('ALIEN');
  });

  it('handles the empty slot', () => {
    expect(buildPattern([])).toBe('');
  });

  it('throws on a non-uppercase-letter entry', () => {
    expect(() => buildPattern(['a', null])).toThrow();
    expect(() => buildPattern(['AB', null])).toThrow();
    expect(() => buildPattern(['1', null])).toThrow();
  });
});

describe('regexFromPattern', () => {
  it('builds the anchored, case-sensitive regex (acceptance 2)', () => {
    expect(regexFromPattern('A?I?N').source).toBe('^A[A-Z]I[A-Z]N$');
  });

  it('matches ALIEN and rejects ALARM, ACORN, AMEND (acceptance 3)', () => {
    const re = regexFromPattern('A?I?N');
    expect(re.test('ALIEN')).toBe(true);
    expect(re.test('ALARM')).toBe(false);
    expect(re.test('ACORN')).toBe(false);
    expect(re.test('AMEND')).toBe(false);
  });

  it('an all-? pattern matches any A-Z string of that exact length (acceptance 4)', () => {
    const re = regexFromPattern('?????');
    expect(re.test('ALIEN')).toBe(true);
    expect(re.test('SPICE')).toBe(true);
    expect(re.test('ABCD')).toBe(false);
    expect(re.test('ABCDEF')).toBe(false);
  });

  it('returns the identical RegExp object across calls for the same pattern (acceptance 5)', () => {
    const first = regexFromPattern('A?I?N');
    const second = regexFromPattern('A?I?N');
    expect(first).toBe(second);
  });

  it('memoises independently per distinct pattern string', () => {
    const a = regexFromPattern('A?I?N');
    const b = regexFromPattern('???');
    expect(a).not.toBe(b);
    expect(regexFromPattern('???')).toBe(b);
  });

  it('throws on a character outside A-Z and ? (acceptance 6)', () => {
    expect(() => regexFromPattern('A-IN')).toThrow();
  });

  it('throws on a lowercase letter', () => {
    expect(() => regexFromPattern('a?i?n')).toThrow();
  });

  it('a fully-fixed pattern matches only its own letters', () => {
    const re = regexFromPattern('ALIEN');
    expect(re.test('ALIEN')).toBe(true);
    expect(re.test('ALIAS')).toBe(false);
  });
});

describe('patternMatches', () => {
  it('matches without allocating a fresh RegExp (reuses the memoised one)', () => {
    expect(patternMatches('A?I?N', 'ALIEN')).toBe(true);
    expect(patternMatches('A?I?N', 'ALARM')).toBe(false);
    // Same pattern queried again still resolves through the same cache entry.
    expect(regexFromPattern('A?I?N')).toBe(regexFromPattern('A?I?N'));
  });

  it('rejects a word of the wrong length', () => {
    expect(patternMatches('A?I?N', 'ALIENS')).toBe(false);
    expect(patternMatches('A?I?N', 'ALIN')).toBe(false);
  });

  it('throws for an invalid pattern', () => {
    expect(() => patternMatches('A_IN', 'ALIEN')).toThrow();
  });
});

describe('isFullyFixed', () => {
  it('is true for a pattern with no ? (acceptance 7)', () => {
    expect(isFullyFixed('ALIEN')).toBe(true);
  });

  it('is false when at least one ? remains', () => {
    expect(isFullyFixed('A?I?N')).toBe(false);
    expect(isFullyFixed('?????')).toBe(false);
  });

  it('is true for the empty pattern (vacuously no ?)', () => {
    expect(isFullyFixed('')).toBe(true);
  });

  it('throws for an invalid pattern', () => {
    expect(() => isFullyFixed('AB!D')).toThrow();
  });
});

describe('fixedLetterCount', () => {
  it('counts the fixed letters (acceptance 7)', () => {
    expect(fixedLetterCount('A?I?N')).toBe(3);
  });

  it('is 0 for an all-? pattern and the length for a fully-fixed one', () => {
    expect(fixedLetterCount('?????')).toBe(0);
    expect(fixedLetterCount('ALIEN')).toBe(5);
  });

  it('is 0 for the empty pattern', () => {
    expect(fixedLetterCount('')).toBe(0);
  });

  it('throws for an invalid pattern', () => {
    expect(() => fixedLetterCount('A?I?N9')).toThrow();
  });
});
