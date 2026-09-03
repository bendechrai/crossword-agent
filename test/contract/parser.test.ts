import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseCandidateResponse, type ParseOutcome } from '../../src/llm/parser.js';
import type { CandidateResponse } from '../../src/candidates/types.js';

/**
 * T11 contract. Every fixture under test/fixtures/responses is authored by
 * hand for this test and asserted here; the inline cases below cover the
 * decisions the fixture list does not name a file for.
 */

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/responses/${name}.txt`, import.meta.url), 'utf8');
}

/** Reads a response out of the outcome without a non-null assertion. */
function responseFor(outcome: ParseOutcome, id: string): CandidateResponse {
  const found = outcome.byId.get(id);
  if (found === undefined) {
    throw new Error(`no response for ${id}; failures: ${JSON.stringify(outcome.failures)}`);
  }
  return found;
}

function answersFor(outcome: ParseOutcome, id: string): string[] {
  return responseFor(outcome, id).candidates.map((c) => c.answer);
}

const SINGLE_ID = '12A';
const SINGLE_OPTS = { batchSize: 1, expectedIds: [SINGLE_ID] };
const BATCH_IDS = ['1A', '5A', '7D'];
const BATCH_OPTS = { batchSize: 3, expectedIds: BATCH_IDS };

/** What good-single.txt and its re-wrappings all mean. */
const SINGLE_RESPONSE: CandidateResponse = {
  clue_understood: 0.9,
  candidates: [
    { answer: 'ANIMAL', confidence: 0.7 },
    { answer: 'MAMMAL', confidence: 0.35 },
  ],
  notes: 'crossing_suspect: "12A"; the model also typed a stray { in here',
};

describe('parseCandidateResponse: single-clue fixtures', () => {
  it('1. good-single.txt: a bare object parses to one response with two candidates', () => {
    const outcome = parseCandidateResponse(fixture('good-single'), SINGLE_OPTS);

    expect(outcome.failures).toEqual([]);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.byId.size).toBe(1);
    expect(responseFor(outcome, SINGLE_ID)).toEqual(SINGLE_RESPONSE);
    expect(responseFor(outcome, SINGLE_ID).candidates).toHaveLength(2);
    expect(outcome.rawUsed.startsWith('{')).toBe(true);
    expect(outcome.rawUsed.endsWith('}')).toBe(true);
  });

  it('2. fenced.txt: a ```json fenced object parses identically', () => {
    const outcome = parseCandidateResponse(fixture('fenced'), SINGLE_OPTS);

    expect(outcome.failures).toEqual([]);
    expect(responseFor(outcome, SINGLE_ID)).toEqual(SINGLE_RESPONSE);
    expect(outcome.rawUsed).not.toContain('`');
  });

  it('3. prose-prefix.txt: a paragraph of prose then the object parses', () => {
    const outcome = parseCandidateResponse(fixture('prose-prefix'), SINGLE_OPTS);

    expect(outcome.failures).toEqual([]);
    expect(responseFor(outcome, SINGLE_ID)).toEqual(SINGLE_RESPONSE);
    expect(outcome.rawUsed).not.toContain('BEASTS');
  });

  it('4. trailing-commentary.txt: an object then prose parses', () => {
    const outcome = parseCandidateResponse(fixture('trailing-commentary'), SINGLE_OPTS);

    expect(outcome.failures).toEqual([]);
    expect(responseFor(outcome, SINGLE_ID)).toEqual(SINGLE_RESPONSE);
    expect(outcome.rawUsed).not.toContain('fallback');
  });

  it('5. reasoning-wrapped.txt: the <think> draft is dropped and the real object wins', () => {
    const outcome = parseCandidateResponse(fixture('reasoning-wrapped'), SINGLE_OPTS);

    expect(outcome.failures).toEqual([]);
    expect(responseFor(outcome, SINGLE_ID)).toEqual(SINGLE_RESPONSE);
    expect(answersFor(outcome, SINGLE_ID)).not.toContain('WRONG');
    expect(outcome.rawUsed).not.toContain('WRONG');
  });

  it('6. truncated.txt: an unterminated object fails once, naming the brace, without throwing', () => {
    const parse = (): ParseOutcome => parseCandidateResponse(fixture('truncated'), SINGLE_OPTS);
    expect(parse).not.toThrow();

    const outcome = parse();
    expect(outcome.byId.size).toBe(0);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.id).toBeNull();
    expect(outcome.failures[0]?.error).toMatch(/unbalanced brace/);
    expect(outcome.rawUsed).toBe('');
  });

  it('7. wrong-typed-confidence.txt: a string confidence fails ajv and is reported', () => {
    const outcome = parseCandidateResponse(fixture('wrong-typed-confidence'), SINGLE_OPTS);

    expect(outcome.byId.size).toBe(0);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.id).toBe(SINGLE_ID);
    expect(outcome.failures[0]?.error).toContain('confidence');
  });

  it('11. answers-with-spaces-and-accents.txt: answers pass through unnormalised', () => {
    const outcome = parseCandidateResponse(
      fixture('answers-with-spaces-and-accents'),
      SINGLE_OPTS,
    );

    expect(outcome.failures).toEqual([]);
    expect(answersFor(outcome, SINGLE_ID)).toEqual([
      'CAFE AU LAIT',
      'R\u00c9SUM\u00c9',
      'T-SHIRT',
      'O\u2019CLOCK',
    ]);
  });
});

describe('parseCandidateResponse: batched fixtures', () => {
  const expectedBatch: Record<string, string[]> = {
    '1A': ['ANIMAL', 'MAMMAL'],
    '5A': ['BADGER'],
    '7D': ['OTTERS'],
  };

  it('8. batched-good.txt: three results realign to 1A, 5A and 7D', () => {
    const outcome = parseCandidateResponse(fixture('batched-good'), BATCH_OPTS);

    expect(outcome.failures).toEqual([]);
    expect([...outcome.byId.keys()].sort()).toEqual([...BATCH_IDS].sort());
    for (const id of BATCH_IDS) {
      expect(answersFor(outcome, id)).toEqual(expectedBatch[id]);
    }
    expect(responseFor(outcome, '7D').notes).toBe('the enumeration is ambiguous');
  });

  it('9. batched-missing-id.txt: the absent id fails as "missing" and the others survive', () => {
    const outcome = parseCandidateResponse(fixture('batched-missing-id'), BATCH_OPTS);

    expect(outcome.failures).toEqual([{ id: '5A', error: 'missing' }]);
    expect([...outcome.byId.keys()].sort()).toEqual(['1A', '7D']);
    expect(answersFor(outcome, '1A')).toEqual(expectedBatch['1A']);
    expect(answersFor(outcome, '7D')).toEqual(expectedBatch['7D']);
  });

  it('10. batched-shuffled.txt: results in 7D, 1A, 5A order realign by id, not position', () => {
    const outcome = parseCandidateResponse(fixture('batched-shuffled'), BATCH_OPTS);

    expect(outcome.failures).toEqual([]);
    for (const id of BATCH_IDS) {
      expect(answersFor(outcome, id)).toEqual(expectedBatch[id]);
    }
  });
});

describe('parseCandidateResponse: stripping and scanning', () => {
  const real = '{"clue_understood": 0.9, "candidates": [{"answer": "ANIMAL", "confidence": 0.7}]}';
  const draft = '{"clue_understood": 0.1, "candidates": [{"answer": "WRONG", "confidence": 0.9}]}';

  it('takes the LAST balanced object when two bare objects are emitted (B41)', () => {
    const outcome = parseCandidateResponse(`${draft}\n\nOn reflection:\n${real}`, SINGLE_OPTS);

    expect(outcome.failures).toEqual([]);
    expect(answersFor(outcome, SINGLE_ID)).toEqual(['ANIMAL']);
    expect(outcome.rawUsed).toBe(real);
  });

  it('strips a reasoning_content field that would otherwise fail the schema (B41)', () => {
    const reasoning = '"reasoning_content": "I weighed \\"BEASTS\\" against {ANIMAL}"';
    const inTheMiddle = `{"clue_understood": 0.9, ${reasoning}, "candidates": [{"answer": "ANIMAL", "confidence": 0.7}]}`;
    const atTheEnd = `{"clue_understood": 0.9, "candidates": [{"answer": "ANIMAL", "confidence": 0.7}], ${reasoning}}`;

    for (const raw of [inTheMiddle, atTheEnd]) {
      const outcome = parseCandidateResponse(raw, SINGLE_OPTS);
      expect(outcome.failures, raw).toEqual([]);
      expect(answersFor(outcome, SINGLE_ID)).toEqual(['ANIMAL']);
      expect(outcome.rawUsed).not.toContain('reasoning_content');
    }
  });

  it('strips a dangling <think> with no closing tag', () => {
    const outcome = parseCandidateResponse(`${real}\n<think>and then I ran out of ${draft}`, SINGLE_OPTS);

    expect(outcome.failures).toEqual([]);
    expect(answersFor(outcome, SINGLE_ID)).toEqual(['ANIMAL']);
  });

  it('drops everything before an orphan </think>', () => {
    const outcome = parseCandidateResponse(`${draft}\n</think>\n${real}`, SINGLE_OPTS);

    expect(outcome.failures).toEqual([]);
    expect(answersFor(outcome, SINGLE_ID)).toEqual(['ANIMAL']);
  });

  it('is not fooled by braces or quotes inside string values', () => {
    const tricky =
      '{"clue_understood": 0.5, "candidates": [{"answer": "ANIMAL", "confidence": 0.5}], "notes": "a \\" then { and } unmatched"}';
    const outcome = parseCandidateResponse(tricky, SINGLE_OPTS);

    expect(outcome.failures).toEqual([]);
    expect(responseFor(outcome, SINGLE_ID).notes).toBe('a " then { and } unmatched');
  });

  it('reports one failure when the response holds no JSON object at all', () => {
    const outcome = parseCandidateResponse('I am sorry, I cannot answer that clue.', SINGLE_OPTS);

    expect(outcome.byId.size).toBe(0);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.id).toBeNull();
    expect(outcome.failures[0]?.error).toMatch(/no JSON object/);
  });

  it('reports one failure when the balanced object is not valid JSON', () => {
    const outcome = parseCandidateResponse('{"clue_understood": 0.9, }', SINGLE_OPTS);

    expect(outcome.byId.size).toBe(0);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.id).toBeNull();
    expect(outcome.failures[0]?.error).toMatch(/invalid JSON/);
  });
});

describe('parseCandidateResponse: per-element accounting', () => {
  const one = (id: string, answer: string): string =>
    `{"id": "${id}", "clue_understood": 0.5, "candidates": [{"answer": "${answer}", "confidence": 0.5}]}`;

  it('reports an unexpected id as a failure carrying that id, not a silent drop', () => {
    const raw = `{"results": [${one('1A', 'ANIMAL')}, ${one('9D', 'STRAY')}]}`;
    const outcome = parseCandidateResponse(raw, { batchSize: 2, expectedIds: ['1A', '5A'] });

    expect(answersFor(outcome, '1A')).toEqual(['ANIMAL']);
    expect(outcome.byId.has('9D')).toBe(false);
    expect(outcome.failures).toContainEqual({ id: '9D', error: 'unexpected id' });
    expect(outcome.failures).toContainEqual({ id: '5A', error: 'missing' });
    expect(outcome.failures).toHaveLength(2);
  });

  it('keeps the first of two elements with the same id and fails the second', () => {
    const raw = `{"results": [${one('1A', 'ANIMAL')}, ${one('1A', 'SECOND')}]}`;
    const outcome = parseCandidateResponse(raw, { batchSize: 1, expectedIds: ['1A'] });

    expect(answersFor(outcome, '1A')).toEqual(['ANIMAL']);
    expect(outcome.failures).toEqual([{ id: '1A', error: 'duplicate id' }]);
  });

  it('fails only the malformed element of a batch', () => {
    const raw = `{"results": [${one('1A', 'ANIMAL')}, {"id": "5A", "clue_understood": 0.5, "candidates": [{"answer": "BAD", "confidence": "high"}]}, ${one('7D', 'OTTERS')}]}`;
    const outcome = parseCandidateResponse(raw, BATCH_OPTS);

    expect([...outcome.byId.keys()].sort()).toEqual(['1A', '7D']);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.id).toBe('5A');
    expect(outcome.failures[0]?.error).toContain('confidence');
  });

  it('fails an element that is not an object, and the missing id with it', () => {
    const raw = `{"results": [${one('1A', 'ANIMAL')}, "5A"]}`;
    const outcome = parseCandidateResponse(raw, { batchSize: 2, expectedIds: ['1A', '5A'] });

    expect([...outcome.byId.keys()]).toEqual(['1A']);
    expect(outcome.failures).toHaveLength(2);
    expect(outcome.failures[0]?.id).toBeNull();
    expect(outcome.failures[0]?.error).toContain('results[1]');
    expect(outcome.failures).toContainEqual({ id: '5A', error: 'missing' });
  });

  it('fails an element with no usable id', () => {
    const raw = '{"results": [{"clue_understood": 0.5, "candidates": []}]}';
    const outcome = parseCandidateResponse(raw, { batchSize: 1, expectedIds: ['1A'] });

    expect(outcome.byId.size).toBe(0);
    expect(outcome.failures[0]?.id).toBeNull();
    expect(outcome.failures[0]?.error).toContain('id');
    expect(outcome.failures).toContainEqual({ id: '1A', error: 'missing' });
  });

  it('defaults a missing clue_understood to 0 with a warning rather than failing', () => {
    const raw = '{"candidates": [{"answer": "ANIMAL", "confidence": 0.7}]}';
    const outcome = parseCandidateResponse(raw, SINGLE_OPTS);

    expect(outcome.failures).toEqual([]);
    expect(responseFor(outcome, SINGLE_ID).clue_understood).toBe(0);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]?.id).toBe(SINGLE_ID);
    expect(outcome.warnings[0]?.warning).toContain('clue_understood');
  });

  it('accepts a batched envelope for a single expected id', () => {
    const outcome = parseCandidateResponse(`{"results": [${one('1A', 'ANIMAL')}]}`, {
      batchSize: 1,
      expectedIds: ['1A'],
    });

    expect(outcome.failures).toEqual([]);
    expect(answersFor(outcome, '1A')).toEqual(['ANIMAL']);
  });

  it('fails the whole response when a batch comes back in the single-clue form', () => {
    const raw = '{"clue_understood": 0.9, "candidates": [{"answer": "ANIMAL", "confidence": 0.7}]}';
    const outcome = parseCandidateResponse(raw, BATCH_OPTS);

    expect(outcome.byId.size).toBe(0);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.id).toBeNull();
    expect(outcome.failures[0]?.error).toContain('results');
  });

  it('reports an empty candidate list as a success, not a failure (a negative result)', () => {
    const outcome = parseCandidateResponse('{"clue_understood": 0.2, "candidates": []}', SINGLE_OPTS);

    expect(outcome.failures).toEqual([]);
    expect(responseFor(outcome, SINGLE_ID).candidates).toEqual([]);
  });
});
