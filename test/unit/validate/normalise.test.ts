import { describe, expect, it } from 'vitest';

import { dedupeCandidates, normaliseAnswer, validateCandidates } from '../../../src/validate/normalise.js';
import type { ValidateInput } from '../../../src/validate/normalise.js';
import type { Candidate } from '../../../src/candidates/types.js';

function baseInput(overrides: Partial<ValidateInput> = {}): ValidateInput {
  return {
    raw: [],
    length: 7,
    pattern: '???????',
    clue: 'Celebrity gossip magazine reader',
    tier: 1,
    fromCache: false,
    rejected: [],
    ...overrides,
  };
}

describe('normaliseAnswer', () => {
  it('uppercases and strips spaces', () => {
    expect(normaliseAnswer('Nano Banana')).toBe('NANOBANANA');
  });

  it('strips hyphens', () => {
    expect(normaliseAnswer('A-lister')).toBe('ALISTER');
  });

  it('normalises both the precomposed and NFD-decomposed form of an accented word to the same result', () => {
    // Precomposed: A, n, LATIN SMALL LETTER A WITH ACUTE (\u00e1), l, i, s, i, s.
    const precomposed = 'An\u00e1lisis';
    // Decomposed: A, n, a, COMBINING ACUTE ACCENT (\u0301), l, i, s, i, s.
    const decomposed = 'Ana\u0301lisis';
    expect(normaliseAnswer(precomposed)).toBe('ANALISIS');
    expect(normaliseAnswer(decomposed)).toBe('ANALISIS');
  });

  it('strips diacritics from other accented inputs, written as unicode escapes to keep the source ASCII', () => {
    // 'FIANCEE' with a precomposed E-acute (\u00c9) standing in for plain E.
    expect(normaliseAnswer('FIANC\u00c9E')).toBe('FIANCEE');
    // 'cafe' with a precomposed e-acute (\u00e9) standing in for plain e.
    expect(normaliseAnswer('caf\u00e9')).toBe('CAFE');
  });

  it('is idempotent on an already-normalised string', () => {
    expect(normaliseAnswer('ALISTER')).toBe('ALISTER');
  });
});

describe('validateCandidates: charset rejects', () => {
  it('rejects a candidate containing a digit', () => {
    const result = validateCandidates(
      baseInput({ raw: [{ answer: 'AB3DEFG', confidence: 0.9 }] }),
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejects).toEqual([{ answer: 'AB3DEFG', raw: 'AB3DEFG', reason: 'charset' }]);
  });

  it('rejects a candidate containing an emoji', () => {
    const result = validateCandidates(
      baseInput({ raw: [{ answer: 'AB\u{1F600}DEFG', confidence: 0.9 }] }),
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejects[0]?.reason).toBe('charset');
  });
});

describe('validateCandidates: every RejectReason is produced', () => {
  it('produces charset for a non-letter survivor', () => {
    const result = validateCandidates(baseInput({ raw: [{ answer: 'AB3DEFG', confidence: 0.5 }] }));
    expect(result.rejects.map((r) => r.reason)).toEqual(['charset']);
  });

  it('produces length for a candidate whose normalised length is wrong', () => {
    const result = validateCandidates(
      baseInput({ length: 3, pattern: '???', raw: [{ answer: 'ELEPHANT', confidence: 0.5 }] }),
    );
    expect(result.rejects.map((r) => r.reason)).toEqual(['length']);
  });

  it('produces pattern for a candidate that fails the fixed-letter regex', () => {
    const result = validateCandidates(
      baseInput({ length: 4, pattern: 'A???', raw: [{ answer: 'BXYZ', confidence: 0.5 }] }),
    );
    expect(result.rejects.map((r) => r.reason)).toEqual(['pattern']);
  });

  it('produces duplicate on the second of two candidates normalising to the same answer', () => {
    const result = validateCandidates(
      baseInput({
        raw: [
          { answer: 'A-lister', confidence: 0.4 },
          { answer: 'ALISTER', confidence: 0.9 },
        ],
      }),
    );
    expect(result.rejects.map((r) => r.reason)).toEqual(['duplicate']);
  });

  it('produces clue-echo for a candidate contained in the normalised clue', () => {
    const result = validateCandidates(
      baseInput({ clue: 'Add zest to', raw: [{ answer: 'ADDZEST', confidence: 0.9 }] }),
    );
    expect(result.rejects.map((r) => r.reason)).toEqual(['clue-echo']);
  });

  it('produces rejected-before for a candidate already in the persistent rejection set', () => {
    const result = validateCandidates(
      baseInput({
        raw: [{ answer: 'ALISTER', confidence: 0.9 }],
        rejected: [{ answer: 'ALISTER', reason: 'previously ruled out' }],
      }),
    );
    expect(result.rejects.map((r) => r.reason)).toEqual(['rejected-before']);
  });
});

describe('validateCandidates: dedupe', () => {
  it('dedupes on the normalised string, keeping the higher score and summing votes', () => {
    const result = validateCandidates(
      baseInput({
        raw: [
          { answer: 'A-lister', confidence: 0.4 },
          { answer: 'ALISTER', confidence: 0.9 },
        ],
      }),
    );
    expect(result.accepted).toHaveLength(1);
    const winner = result.accepted[0];
    expect(winner?.answer).toBe('ALISTER');
    expect(winner?.score).toBe(0.9);
    expect(winner?.votes).toBe(2);
    expect(result.rejects).toEqual([{ answer: 'ALISTER', raw: 'A-lister', reason: 'duplicate' }]);
  });

  it('runs dedupe after length and pattern filtering, so a rejected duplicate cannot shadow an accepted one', () => {
    const result = validateCandidates(
      baseInput({
        length: 7,
        pattern: '???????',
        raw: [
          // Same normalised answer, but this occurrence is the wrong length
          // before normalisation is even considered a duplicate candidate.
          { answer: 'A-listers', confidence: 0.9 }, // normalises to ALISTERS, length 8: rejected on length
          { answer: 'A-lister', confidence: 0.4 }, // normalises to ALISTER, length 7: survives
        ],
      }),
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.answer).toBe('ALISTER');
    expect(result.rejects).toEqual([{ answer: 'ALISTERS', raw: 'A-listers', reason: 'length' }]);
  });
});

describe('validateCandidates: clue echo', () => {
  it('rejects a candidate equal to or contained in the normalised clue', () => {
    const result = validateCandidates(
      baseInput({ clue: 'Add zest to', raw: [{ answer: 'ADDZEST', confidence: 0.9 }] }),
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.echoWaived).toBe(false);
    expect(result.rejects).toEqual([{ answer: 'ADDZEST', raw: 'ADDZEST', reason: 'clue-echo' }]);
  });

  it('waives the echo rule when it is the only way to leave the slot non-empty', () => {
    const result = validateCandidates(
      baseInput({
        clue: 'Add zest to',
        raw: [{ answer: 'ADDZEST', confidence: 0.9 }],
        allowEchoWhenEmpty: true,
      }),
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.answer).toBe('ADDZEST');
    expect(result.echoWaived).toBe(true);
    expect(result.rejects).toHaveLength(0);
  });

  it('does not waive the echo rule when a non-echo survivor already keeps the slot non-empty', () => {
    const result = validateCandidates(
      baseInput({
        clue: 'Add zest to',
        raw: [
          { answer: 'ADDZEST', confidence: 0.9 },
          { answer: 'SPICEUP', confidence: 0.5 },
        ],
        allowEchoWhenEmpty: true,
      }),
    );
    expect(result.accepted.map((c) => c.answer)).toEqual(['SPICEUP']);
    expect(result.echoWaived).toBe(false);
    expect(result.rejects).toEqual([{ answer: 'ADDZEST', raw: 'ADDZEST', reason: 'clue-echo' }]);
  });
});

describe('validateCandidates: persistent rejection set', () => {
  it('drops a candidate in the rejection set even though it would otherwise pass', () => {
    const result = validateCandidates(
      baseInput({
        raw: [{ answer: 'ALISTER', confidence: 0.9 }],
        rejected: [{ answer: 'ALISTER', reason: 'previously ruled out' }],
      }),
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejects).toEqual([{ answer: 'ALISTER', raw: 'ALISTER', reason: 'rejected-before' }]);
  });
});

describe('validateCandidates: ordering', () => {
  it('reports length, not clue-echo, for an over-length candidate that is also a clue echo', () => {
    const result = validateCandidates(
      baseInput({
        length: 5,
        pattern: '?????',
        clue: 'Add zest',
        raw: [{ answer: 'ADDZEST', confidence: 0.9 }],
      }),
    );
    expect(result.rejects).toEqual([{ answer: 'ADDZEST', raw: 'ADDZEST', reason: 'length' }]);
  });
});

describe('validateCandidates: accepted candidate shape', () => {
  it('carries tier, fromCache and rank through onto the accepted Candidate', () => {
    const result = validateCandidates(
      baseInput({
        tier: 2,
        fromCache: true,
        raw: [
          { answer: 'NOPE', confidence: 0.1 },
          { answer: 'ALISTER', confidence: 0.7 },
        ],
      }),
    );
    // NOPE fails length and never enters the accepted list, but its presence
    // confirms rank reflects the original model-order index, not the
    // post-filter position.
    expect(result.accepted).toHaveLength(1);
    const c = result.accepted[0];
    expect(c?.rank).toBe(1);
    expect(c?.tier).toBe(2);
    expect(c?.fromCache).toBe(true);
    expect(c?.selfConfidence).toBe(0.7);
  });
});

describe('dedupeCandidates', () => {
  function candidate(overrides: Partial<Candidate>): Candidate {
    return {
      answer: 'ALISTER',
      raw: 'ALISTER',
      rank: 0,
      selfConfidence: 0.5,
      votes: 1,
      score: 0.5,
      tier: 1,
      fromCache: false,
      ...overrides,
    };
  }

  it('dedupes already-built Candidate objects, keeping the higher score and summing votes', () => {
    const a = candidate({ raw: 'A-lister', score: 0.3, selfConfidence: 0.3 });
    const b = candidate({ raw: 'ALISTER', score: 0.8, selfConfidence: 0.8, rank: 1 });
    const result = dedupeCandidates([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0]?.score).toBe(0.8);
    expect(result[0]?.votes).toBe(2);
    expect(result[0]?.raw).toBe('ALISTER');
  });

  it('leaves distinct answers alone', () => {
    const a = candidate({ answer: 'ALISTER' });
    const b = candidate({ answer: 'OUTSIDER' });
    expect(dedupeCandidates([a, b])).toHaveLength(2);
  });
});
