import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { xdAdapter } from '../../../src/puzzle/adapters/xd.js';
import { ExitCode, isCliError } from '../../../src/cli/exit.js';
import type { NormalisedPuzzleFile, PuzzleWithSolution } from '../../../src/puzzle/types.js';

function fixturePath(name: string): URL {
  return new URL(`../../fixtures/puzzles/${name}`, import.meta.url);
}

function readFixtureBytes(name: string): Buffer {
  return Buffer.from(readFileSync(fixturePath(name)));
}

function readFixtureText(name: string): string {
  return readFileSync(fixturePath(name), 'utf8');
}

function readFixtureJson(name: string): NormalisedPuzzleFile {
  return JSON.parse(readFileSync(fixturePath(name), 'utf8')) as NormalisedPuzzleFile;
}

/** Parses `text` as a `.xd` file, returning whatever it threw instead. */
async function parseFailure(text: string, id: string): Promise<unknown> {
  try {
    await xdAdapter.parse(Buffer.from(text, 'utf8'), { id, source: 'synthetic' });
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectLoadError(thrown: unknown, ...fragments: readonly string[]): void {
  expect(isCliError(thrown)).toBe(true);
  if (!isCliError(thrown)) return;
  expect(thrown.code).toBe(ExitCode.NOT_FOUND);
  for (const fragment of fragments) expect(thrown.message).toContain(fragment);
}

/** The letters a slot's cells hold in the solution grid. */
function answerOf(puzzle: PuzzleWithSolution, cells: ReadonlyArray<readonly [number, number]>): string {
  return cells
    .map(([row, col]) => puzzle.solution[row]?.[col] ?? '')
    .join('')
    .toUpperCase();
}

/**
 * B42: no clue text may carry any slot's solution as a substring. Asserted as
 * a post-condition over a whole parsed puzzle, so it holds for every fixture
 * it is run over, not just the one authored to exercise it.
 */
function expectNoSolutionLeak(puzzle: PuzzleWithSolution): void {
  expect(puzzle.slots.length).toBeGreaterThan(0);
  const answers = puzzle.slots.map((slot) => answerOf(puzzle, slot.cells));
  for (const answer of answers) expect(answer.length).toBeGreaterThan(0);

  const leaks: string[] = [];
  for (const slot of puzzle.slots) {
    const clue = slot.clue.toUpperCase();
    for (const answer of answers) {
      if (clue.includes(answer)) leaks.push(`${slot.id} carries ${answer}`);
    }
  }
  expect(leaks).toEqual([]);
}

/** The CAT/ARE/RED 3x3 used by the inline cases; `extra` lines go on the end. */
function threeByThree(clues: readonly string[], head: readonly string[] = []): string {
  return [...head, '', 'CAT', 'ARE', 'RED', '', ...clues, ''].join('\n');
}

const THREE_BY_THREE_CLUES = [
  'A1. Common house pet ~ CAT',
  'A4. Second-person plural of to be ~ ARE',
  'A5. Color of a stop sign ~ RED',
  '',
  'D1. Automobile ~ CAR',
  'D2. Existential verb form used with we, you, they ~ ARE',
  'D3. Diminutive form of a common first name ~ TED',
];

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
    const {
      schemaVersion: _schemaVersion,
      fetchedAt: _fetchedAt,
      parsedBy: _fixtureParsedBy,
      ...expected
    } = fixture;
    const { parsedBy: resultParsedBy, ...resultRest } = result;

    expect(resultRest).toEqual(expected);
    expect(resultParsedBy).toBe('xd-hand');
  });

  it('B42: leaky-clues.xd contains no clue whose text carries any slot solution as a substring', async () => {
    const result = await xdAdapter.parse(readFixtureBytes('leaky-clues.xd'), {
      id: 'leaky-clues',
      source: 'synthetic',
    });

    expect(result.slots).toHaveLength(6);
    expectNoSolutionLeak(result);
  });

  it('B42: the same post-condition holds for synthetic-5x5.xd', async () => {
    const result = await xdAdapter.parse(readFixtureBytes('synthetic-5x5.xd'), {
      id: 'synthetic-5x5',
      source: 'synthetic',
    });

    expectNoSolutionLeak(result);
  });

  it('keeps a tilde in a clue that is not the " ~ " answer separator', async () => {
    const text = threeByThree(
      ['A1. House pet, symbol (~) included ~ CAT', ...THREE_BY_THREE_CLUES.slice(1)],
      ['Title: Tilde', 'Author: crossword-agent'],
    );

    const result = await xdAdapter.parse(Buffer.from(text, 'utf8'), {
      id: 'tilde',
      source: 'synthetic',
    });

    const oneAcross = result.slots.find((slot) => slot.id === '1A');
    expect(oneAcross?.clue).toBe('House pet, symbol (~) included');
  });

  it('throws a numbering-mismatch CliError naming the first divergent cell', async () => {
    const original = readFixtureText('synthetic-5x5.xd');
    // D6 (the clue at r1c2) is renumbered to D7, an already-used number, so
    // the file's stated sequence of distinct numbers no longer matches the
    // grid's actual 1..9 sequence starting at that position.
    const mutated = original.replace(
      'D6. The person being addressed',
      'D7. The person being addressed',
    );
    expect(mutated).not.toBe(original);

    expectLoadError(await parseFailure(mutated, 'mismatch'), 'r1c2');
  });

  it('throws when a clue is misnumbered to a number that is still stated elsewhere', async () => {
    const original = readFixtureText('synthetic-5x5.xd');
    // A3 -> A4. The distinct-number *set* is untouched (3 survives via D3, 4
    // via D4), so the numbering zip alone sees nothing wrong; but no across
    // run starts at the cell numbered 4, so 3A would silently disappear from
    // the puzzle if the clue-to-run check were not there (B19).
    const mutated = original.replace(
      'A3. Greek letter of a famous ratio',
      'A4. Greek letter of a famous ratio',
    );
    expect(mutated).not.toBe(original);

    expectLoadError(await parseFailure(mutated, 'misnumbered'), 'A4', 'r0c4');
  });

  it('throws when a clue names a number no cell in the grid carries', async () => {
    const original = readFixtureText('synthetic-5x5.xd');
    const mutated = original.replace(
      'A9. Former partner',
      'A9. Former partner ~ EX\nA42. Former partner',
    );
    expect(mutated).not.toBe(original);

    expectLoadError(await parseFailure(mutated, 'phantom'), 'A42', '42');
  });

  it('throws when the same clue is stated twice', async () => {
    const text = threeByThree([...THREE_BY_THREE_CLUES, 'A1. Common house pet ~ CAT'], [
      'Title: Duplicate',
    ]);

    expectLoadError(await parseFailure(text, 'duplicate'), 'A1', 'more than once');
  });

  it('throws when a clue answer disagrees with the grid, naming the divergent cell', async () => {
    const original = readFixtureText('synthetic-5x5.xd');
    const mutated = original.replace('A1. Cry of surprise ~ OH', 'A1. Cry of surprise ~ AH');
    expect(mutated).not.toBe(original);

    expectLoadError(await parseFailure(mutated, 'wrong-answer'), 'A1', 'r0c0');
  });

  it('throws when a clue answer is the wrong length for its run', async () => {
    const original = readFixtureText('synthetic-5x5.xd');
    const mutated = original.replace('A1. Cry of surprise ~ OH', 'A1. Cry of surprise ~ OHO');
    expect(mutated).not.toBe(original);

    expectLoadError(await parseFailure(mutated, 'wrong-length'), 'A1', 'r0c0');
  });

  it('throws on a malformed clue line rather than dropping the whole clue block', async () => {
    // The period after the number is missing. Under a "every line must be a
    // clue line" classification the entire Across block would have been
    // demoted to an unrecognised section and dropped with only a warning.
    const text = threeByThree([
      'A1. Common house pet ~ CAT',
      'A4 Second-person plural of to be ~ ARE',
      'A5. Color of a stop sign ~ RED',
      '',
      ...THREE_BY_THREE_CLUES.slice(4),
    ]);

    expectLoadError(await parseFailure(text, 'malformed'), 'A4 Second-person plural');
  });

  it('throws when a clue line has no " ~ " answer separator', async () => {
    const text = threeByThree(['A1. Common house pet', ...THREE_BY_THREE_CLUES.slice(1)]);

    expectLoadError(await parseFailure(text, 'no-separator'), 'A1', 'separator');
  });

  it('drops an unrecognised metadata key without failing the parse', async () => {
    const text = threeByThree(THREE_BY_THREE_CLUES, [
      'Title: Has extras',
      'Author: crossword-agent',
      'Difficulty: Easy',
      'Copyright: 2026 Nobody',
    ]);

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

    expectLoadError(await parseFailure(text, 'bad-grid'), 'row 1');
  });

  it('ignores an unrecognised trailing section rather than failing the parse', async () => {
    const text = [
      threeByThree(THREE_BY_THREE_CLUES, ['Title: Has notes', 'Author: crossword-agent']),
      'This puzzle first appeared in a collection whose provenance is not',
      'tracked by any metadata line at all.',
      '',
    ].join('\n');

    const result = await xdAdapter.parse(Buffer.from(text, 'utf8'), {
      id: 'has-notes',
      source: 'synthetic',
    });

    expect(result.slots).toHaveLength(6);
  });

  it('keeps loading when a run has no clue at all, leaving that run without a slot (B20)', async () => {
    const original = readFixtureText('synthetic-5x5.xd');
    // 3 is still stated by D3, so the numbering check is untouched; the 3A
    // run simply has nothing to attach. That is B20's documented behaviour,
    // not an error - unlike a clue that names no run, which is.
    const mutated = original.replace('A3. Greek letter of a famous ratio ~ PI\n', '');
    expect(mutated).not.toBe(original);

    const result = await xdAdapter.parse(Buffer.from(mutated, 'utf8'), {
      id: 'unclued',
      source: 'synthetic',
    });

    expect(result.slots).toHaveLength(10);
    expect(result.slots.some((slot) => slot.id === '3A')).toBe(false);
    expect(result.slots.some((slot) => slot.id === '3D')).toBe(true);
  });
});
