import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { xdAdapter } from '../../../src/puzzle/adapters/xd.js';
import { ExitCode, isCliError } from '../../../src/cli/exit.js';
import type { NormalisedPuzzleFile } from '../../../src/puzzle/types.js';

function fixturePath(name: string): URL {
  return new URL(`../../fixtures/puzzles/${name}`, import.meta.url);
}

function readFixtureBytes(name: string): Buffer {
  return Buffer.from(readFileSync(fixturePath(name)));
}

function readFixtureJson(name: string): NormalisedPuzzleFile {
  return JSON.parse(readFileSync(fixturePath(name), 'utf8')) as NormalisedPuzzleFile;
}

describe('xdAdapter', () => {
  it('parses synthetic-5x5.xd to match synthetic-5x5.json', async () => {
    const result = await xdAdapter.parse(readFixtureBytes('synthetic-5x5.xd'), {
      id: 'synthetic-5x5',
      source: 'synthetic',
    });

    const fixture = readFixtureJson('synthetic-5x5.json');
    // schemaVersion and fetchedAt are added when a normalised file is
    // written (T21), not by a loader adapter. parsedBy is compared
    // separately below: this task's parser is the hand-written one (see the
    // comment atop src/puzzle/adapters/xd.ts), so it produces 'xd-hand'
    // rather than the frozen fixture's 'xd-crossword-tools'.
    const { schemaVersion: _schemaVersion, fetchedAt: _fetchedAt, parsedBy: _fixtureParsedBy, ...expected } =
      fixture;
    const { parsedBy: resultParsedBy, ...resultRest } = result;

    expect(resultRest).toEqual(expected);
    expect(resultParsedBy).toBe('xd-hand');
  });

  it('B42: leaky-clues.xd contains no clue whose text carries any slot solution as a substring', async () => {
    const result = await xdAdapter.parse(readFixtureBytes('leaky-clues.xd'), {
      id: 'leaky-clues',
      source: 'synthetic',
    });

    const solutions = result.slots.map((slot) => slot.id);
    expect(solutions.length).toBeGreaterThan(0);

    for (const slot of result.slots) {
      const answer = slot.cells
        .map(([row, col]) => result.solution[row]?.[col] ?? '')
        .join('')
        .toUpperCase();
      expect(answer.length).toBeGreaterThan(0);

      for (const other of result.slots) {
        const otherAnswer = other.cells
          .map(([row, col]) => result.solution[row]?.[col] ?? '')
          .join('')
          .toUpperCase();
        expect(slot.clue.toUpperCase().includes(otherAnswer)).toBe(false);
      }
    }
  });

  it('keeps a tilde in a clue that is not the " ~ " answer separator', async () => {
    const text = [
      'Title: Tilde',
      'Author: crossword-agent',
      '',
      'CAT',
      'ARE',
      'RED',
      '',
      'A1. Symbol written as (~) meaning approximately ~ TILDE',
      'A4. Second-person plural of to be ~ ARE',
      'A5. Color of a stop sign ~ RED',
      '',
      'D1. Automobile ~ CAR',
      'D2. Existential verb form used with we, you, they ~ ARE',
      'D3. Diminutive form of a common first name ~ TED',
      '',
    ].join('\n');

    const result = await xdAdapter.parse(Buffer.from(text, 'utf8'), {
      id: 'tilde',
      source: 'synthetic',
    });

    const oneAcross = result.slots.find((slot) => slot.id === '1A');
    expect(oneAcross?.clue).toBe('Symbol written as (~) meaning approximately');
  });

  it('throws a numbering-mismatch CliError naming the first divergent cell', async () => {
    const original = readFileSync(fixturePath('synthetic-5x5.xd'), 'utf8');
    // D6 (the clue at r1c2) is renumbered to D7, an already-used number, so
    // the file's stated sequence of distinct numbers no longer matches the
    // grid's actual 1..9 sequence starting at that position.
    const mutated = original.replace('D6. The person being addressed', 'D7. The person being addressed');
    expect(mutated).not.toBe(original);

    let thrown: unknown;
    try {
      await xdAdapter.parse(Buffer.from(mutated, 'utf8'), { id: 'mismatch', source: 'synthetic' });
    } catch (error) {
      thrown = error;
    }

    expect(isCliError(thrown)).toBe(true);
    if (isCliError(thrown)) {
      expect(thrown.code).toBe(ExitCode.NOT_FOUND);
      expect(thrown.message).toContain('r1c2');
    }
  });

  it('drops an unrecognised metadata key without failing the parse', async () => {
    const text = [
      'Title: Has extras',
      'Author: crossword-agent',
      'Difficulty: Easy',
      'Copyright: 2026 Nobody',
      '',
      'CAT',
      'ARE',
      'RED',
      '',
      'A1. Common house pet ~ CAT',
      'A4. Second-person plural of to be ~ ARE',
      'A5. Color of a stop sign ~ RED',
      '',
      'D1. Automobile ~ CAR',
      'D2. Existential verb form used with we, you, they ~ ARE',
      'D3. Diminutive form of a common first name ~ TED',
      '',
    ].join('\n');

    const result = await xdAdapter.parse(Buffer.from(text, 'utf8'), {
      id: 'extras',
      source: 'synthetic',
    });

    expect(result.title).toBe('Has extras');
    expect(result.author).toBe('crossword-agent');
    expect((result as unknown as Record<string, unknown>)['difficulty']).toBeUndefined();
    expect((result as unknown as Record<string, unknown>)['copyright']).toBeUndefined();
  });

  it('throws a CliError naming the row when a grid line length differs from the others', async () => {
    const text = [
      'Title: Bad grid',
      'Author: crossword-agent',
      '',
      'CAT',
      'AR',
      'RED',
      '',
      'A1. Common house pet ~ CAT',
      '',
      'D1. Automobile ~ CAR',
      '',
    ].join('\n');

    let thrown: unknown;
    try {
      await xdAdapter.parse(Buffer.from(text, 'utf8'), { id: 'bad-grid', source: 'synthetic' });
    } catch (error) {
      thrown = error;
    }

    expect(isCliError(thrown)).toBe(true);
    if (isCliError(thrown)) {
      expect(thrown.code).toBe(ExitCode.NOT_FOUND);
      expect(thrown.message).toContain('row 1');
    }
  });

  it('ignores an unrecognised trailing section rather than failing the parse', async () => {
    const text = [
      'Title: Has notes',
      'Author: crossword-agent',
      '',
      'CAT',
      'ARE',
      'RED',
      '',
      'A1. Common house pet ~ CAT',
      'A4. Second-person plural of to be ~ ARE',
      'A5. Color of a stop sign ~ RED',
      '',
      'D1. Automobile ~ CAR',
      'D2. Existential verb form used with we, you, they ~ ARE',
      'D3. Diminutive form of a common first name ~ TED',
      '',
      'This puzzle first appeared in a collection whose provenance is not',
      'tracked by any Key: Value metadata line at all.',
      '',
    ].join('\n');

    const result = await xdAdapter.parse(Buffer.from(text, 'utf8'), {
      id: 'has-notes',
      source: 'synthetic',
    });

    expect(result.slots).toHaveLength(6);
  });
});
