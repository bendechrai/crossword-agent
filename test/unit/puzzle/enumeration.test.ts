import { describe, expect, it } from 'vitest';

import { extractEnumeration, normaliseEnumeration } from '../../../src/puzzle/enumeration.js';

describe('extractEnumeration', () => {
  it('matches a simple trailing single-number group', () => {
    expect(extractEnumeration('Dinner dish (5)')).toBe('(5)');
  });

  it('matches a trailing multi-number group separated by commas', () => {
    expect(extractEnumeration('Buttoned up (6,2,3)')).toBe('(6,2,3)');
  });

  it('returns undefined when there is no trailing group at all', () => {
    expect(extractEnumeration('Nothing here')).toBeUndefined();
  });

  it('returns undefined for a parenthetical that is not a digit group', () => {
    expect(extractEnumeration('Prize (see 4 down)')).toBeUndefined();
  });

  it('matches the two-word enumeration on the 7x7 fixture clue', () => {
    expect(extractEnumeration('US city on the Hudson (3,4)')).toBe('(3,4)');
  });

  it('accepts a hyphen as a separator', () => {
    expect(extractEnumeration('Well-known saying (4-4)')).toBe('(4-4)');
  });

  it('accepts a space as a separator', () => {
    expect(extractEnumeration('Two words (3 5)')).toBe('(3 5)');
  });

  it('accepts an optional trailing word after the group', () => {
    expect(extractEnumeration('Split down the middle (3,4) hyphenated')).toBe('(3,4) hyphenated');
  });

  it('is not fooled by a non-trailing parenthetical followed by more text', () => {
    expect(extractEnumeration('A clue (5) with trailing words after the group')).toBeUndefined();
  });

  it('ignores a leading number that is not inside parens', () => {
    expect(extractEnumeration('3 blind mice')).toBeUndefined();
  });
});

describe('normaliseEnumeration', () => {
  it('renders a single length as a single-number group', () => {
    expect(normaliseEnumeration([5])).toBe('(5)');
  });

  it('renders multiple lengths comma-separated', () => {
    expect(normaliseEnumeration([3, 4])).toBe('(3,4)');
  });

  it('renders three lengths', () => {
    expect(normaliseEnumeration([6, 2, 3])).toBe('(6,2,3)');
  });
});
