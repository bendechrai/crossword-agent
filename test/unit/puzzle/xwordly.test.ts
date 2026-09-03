import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CliError, ExitCode } from '../../../src/cli/exit.js';
import { xwordlyAdapter, type XwordlyAdapterContext } from '../../../src/puzzle/adapters/xwordly.js';
import type { PuzzleWithSolution, Slot } from '../../../src/puzzle/types.js';

function fixtureUrl(name: string): URL {
  return new URL(`../../fixtures/puzzles/${name}`, import.meta.url);
}

/** Raw bytes for every format: the adapter always takes a `Buffer`, text or binary alike. */
function readFixtureBytes(name: string): Buffer {
  return readFileSync(fixtureUrl(name));
}

/**
 * The canonical normalised fixture, minus `schemaVersion` and `fetchedAt`
 * (acceptance item 1) and minus `parsedBy`. `synthetic-5x5.json` and
 * `synthetic-7x7.json` are shared, frozen ground truth for both this task
 * (T24, `@xwordly/xword-parser`) and its sibling T25 (`.xd`, `xd-hand` or
 * `xd-crossword-tools`), so they can only encode one `parsedBy` value -
 * they hold "xd-crossword-tools". Acceptance item 5 pins the value this
 * adapter must actually produce ("@xwordly/xword-parser") separately below,
 * so `parsedBy` is excluded here rather than the two conflicting acceptance
 * items being made to fight over one field. See the PR's deviations note.
 */
function readExpected(name: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(fixtureUrl(`${name}.json`), 'utf8')) as Record<string, unknown>;
  const { schemaVersion: _schemaVersion, fetchedAt: _fetchedAt, parsedBy: _parsedBy, ...rest } = raw;
  return rest;
}

/** Reads the solved word for a slot back out of a parsed puzzle's solution grid. */
function wordAt(puzzle: PuzzleWithSolution, slot: Slot): string {
  return slot.cells.map(([row, col]) => puzzle.solution[row]?.[col] ?? '').join('');
}

/** A parsed result with `parsedBy` dropped, to compare against `readExpected`. */
function withoutParsedBy(puzzle: PuzzleWithSolution): Record<string, unknown> {
  const { parsedBy: _parsedBy, ...rest } = puzzle;
  return rest;
}

const FIXTURES: ReadonlyArray<{ file: string; ctx: XwordlyAdapterContext }> = [
  {
    file: 'synthetic-5x5.ipuz',
    ctx: { id: 'synthetic-5x5', source: 'synthetic', origin: 'synthetic-5x5.ipuz', style: 'american' },
  },
  {
    file: 'synthetic-5x5.puz',
    ctx: { id: 'synthetic-5x5', source: 'synthetic', origin: 'synthetic-5x5.puz', style: 'american' },
  },
  {
    file: 'synthetic-5x5.jpz',
    ctx: { id: 'synthetic-5x5', source: 'synthetic', origin: 'synthetic-5x5.jpz', style: 'american' },
  },
  {
    file: 'synthetic-7x7.ipuz',
    ctx: { id: 'synthetic-7x7', source: 'synthetic', origin: 'synthetic-7x7.ipuz', style: 'american' },
  },
];

describe('xwordlyAdapter', () => {
  it('parses synthetic-5x5.ipuz to match the canonical fixture', async () => {
    const result = await xwordlyAdapter.parse(readFixtureBytes('synthetic-5x5.ipuz'), FIXTURES[0]!.ctx);
    expect(withoutParsedBy(result)).toEqual(readExpected('synthetic-5x5'));
  });

  it('parses synthetic-5x5.puz to match the canonical fixture', async () => {
    const result = await xwordlyAdapter.parse(readFixtureBytes('synthetic-5x5.puz'), FIXTURES[1]!.ctx);
    expect(withoutParsedBy(result)).toEqual(readExpected('synthetic-5x5'));
  });

  it('parses synthetic-5x5.jpz to match the canonical fixture', async () => {
    const result = await xwordlyAdapter.parse(readFixtureBytes('synthetic-5x5.jpz'), FIXTURES[2]!.ctx);
    expect(withoutParsedBy(result)).toEqual(readExpected('synthetic-5x5'));
  });

  it('parses synthetic-7x7.ipuz to match the canonical fixture', async () => {
    const result = await xwordlyAdapter.parse(readFixtureBytes('synthetic-7x7.ipuz'), FIXTURES[3]!.ctx);
    expect(withoutParsedBy(result)).toEqual(readExpected('synthetic-7x7'));
  });

  it('sets parsedBy to "@xwordly/xword-parser" for every format it handles', async () => {
    for (const { file, ctx } of FIXTURES) {
      const result = await xwordlyAdapter.parse(readFixtureBytes(file), ctx);
      expect(result.parsedBy).toBe('@xwordly/xword-parser');
    }
  });

  it('carries the 7x7 multi-word slot enumeration and leaves the clue text unchanged', async () => {
    const result = await xwordlyAdapter.parse(readFixtureBytes('synthetic-7x7.ipuz'), FIXTURES[3]!.ctx);
    const slot = result.slots.find((s) => s.id === '9A');
    expect(slot?.enumeration).toBe('(3,4)');
    expect(slot?.clue).toBe('US city on the Hudson (3,4)');
  });

  it('normalises an accented source letter to plain A-Z (FIANCEE)', async () => {
    const result = await xwordlyAdapter.parse(readFixtureBytes('synthetic-7x7.ipuz'), FIXTURES[3]!.ctx);
    const slot = result.slots.find((s) => s.id === '11A');
    expect(slot).toBeDefined();
    expect(wordAt(result, slot!)).toBe('FIANCEE');
  });

  it('B42: no slot clue contains any slot solution as a substring, across every fixture', async () => {
    for (const { file, ctx } of FIXTURES) {
      const puzzle = await xwordlyAdapter.parse(readFixtureBytes(file), ctx);
      const words = puzzle.slots.map((slot) => wordAt(puzzle, slot).toLowerCase());
      for (const slot of puzzle.slots) {
        const clueLower = slot.clue.toLowerCase();
        for (const word of words) {
          if (word.length === 0) continue;
          expect(clueLower.includes(word), `${file} ${slot.id}: clue "${slot.clue}" leaks "${word}"`).toBe(
            false,
          );
        }
      }
    }
  });

  it('throws a NOT_FOUND CliError naming the first divergent cell on a numbering mismatch', async () => {
    const raw = JSON.parse(readFileSync(fixtureUrl('synthetic-5x5.ipuz'), 'utf8')) as {
      puzzle: unknown[][];
    };
    // r0c0 is numbered 1 in the fixture; force a mismatch against the recomputed numbering.
    raw.puzzle[0]![0] = 99;
    const bytes = Buffer.from(JSON.stringify(raw), 'utf8');

    let caught: unknown;
    try {
      await xwordlyAdapter.parse(bytes, {
        id: 'mismatch',
        source: 'synthetic',
        origin: 'mismatch.ipuz',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CliError);
    const cliError = caught as CliError;
    expect(cliError.code).toBe(ExitCode.NOT_FOUND);
    expect(cliError.message).toContain('r0c0');
  });

  it('throws a NOT_FOUND CliError naming the cell on a rebus square', async () => {
    const raw = JSON.parse(readFileSync(fixtureUrl('synthetic-5x5.ipuz'), 'utf8')) as {
      solution: string[][];
    };
    // r1c1 ("A" in RAYON) carries no clue number, so this cannot also trip the
    // numbering-mismatch check above - only the rebus check should fire.
    raw.solution[1]![1] = 'ST';
    const bytes = Buffer.from(JSON.stringify(raw), 'utf8');

    let caught: unknown;
    try {
      await xwordlyAdapter.parse(bytes, { id: 'rebus', source: 'synthetic', origin: 'rebus.ipuz' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CliError);
    const cliError = caught as CliError;
    expect(cliError.code).toBe(ExitCode.NOT_FOUND);
    expect(cliError.message).toContain('r1c1');
  });

  it('rejects a solution letter that is still not A-Z after normalisation', async () => {
    const raw = JSON.parse(readFileSync(fixtureUrl('synthetic-5x5.ipuz'), 'utf8')) as {
      solution: string[][];
    };
    raw.solution[2]![2] = '3';
    const bytes = Buffer.from(JSON.stringify(raw), 'utf8');

    let caught: unknown;
    try {
      await xwordlyAdapter.parse(bytes, { id: 'bad-letter', source: 'synthetic', origin: 'bad-letter.ipuz' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CliError);
    const cliError = caught as CliError;
    expect(cliError.code).toBe(ExitCode.NOT_FOUND);
    expect(cliError.message).toContain('r2c2');
  });

  it('defaults style to "unknown" when the caller does not supply one', async () => {
    const result = await xwordlyAdapter.parse(readFixtureBytes('synthetic-5x5.ipuz'), {
      id: 'synthetic-5x5',
      source: 'synthetic',
      origin: 'synthetic-5x5.ipuz',
    });
    expect(result.style).toBe('unknown');
  });
});
