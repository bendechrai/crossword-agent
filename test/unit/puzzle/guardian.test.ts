import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { isCliError } from '../../../src/cli/exit.js';
import {
  guardianAdapter,
  parseGuardianPayload,
  type GuardianPayload,
} from '../../../src/puzzle/adapters/guardian.js';
import type { PuzzleAdapterContext } from '../../../src/puzzle/adapters/index.js';
import { log } from '../../../src/util/log.js';

// Mirrors the real Guardian crossword JSON shape (the part of it this
// adapter reads): `crossword.entries[]`, each entry carrying `id`, `number`,
// `direction`, `position: {x, y}` (col, row - the Guardian convention),
// `length`, `clue`, `solution` and `separatorLocations`. See the fixture
// file for the full 7x7 layout and a note in src/puzzle/adapters/guardian.ts
// on the shape assumed for the (optional, absent here) `dimensions` field.
const FIXTURE_PATH = fileURLToPath(
  new URL('../../fixtures/guardian/cryptic-sample.json', import.meta.url),
);

function loadFixture(): GuardianPayload {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as GuardianPayload;
}

function ctx(id = 'cryptic-sample'): PuzzleAdapterContext {
  return { id, source: 'guardian', origin: FIXTURE_PATH };
}

// The full expected result for the fixture, asserted cell by cell (grid,
// slots and solution) against the literal below (acceptance 1).
const EXPECTED_CELLS = [
  [
    { row: 0, col: 0, block: false, number: 1 },
    { row: 0, col: 1, block: false },
    { row: 0, col: 2, block: false, number: 2 },
    { row: 0, col: 3, block: true },
    { row: 0, col: 4, block: false, number: 3 },
    { row: 0, col: 5, block: false },
    { row: 0, col: 6, block: false, number: 4 },
  ],
  [
    { row: 1, col: 0, block: false },
    { row: 1, col: 1, block: true },
    { row: 1, col: 2, block: false, number: 5 },
    { row: 1, col: 3, block: false },
    { row: 1, col: 4, block: false },
    { row: 1, col: 5, block: true },
    { row: 1, col: 6, block: false },
  ],
  [
    { row: 2, col: 0, block: false, number: 6 },
    { row: 2, col: 1, block: false, number: 7 },
    { row: 2, col: 2, block: false },
    { row: 2, col: 3, block: true },
    { row: 2, col: 4, block: false, number: 8 },
    { row: 2, col: 5, block: false, number: 9 },
    { row: 2, col: 6, block: false },
  ],
  [
    { row: 3, col: 0, block: true },
    { row: 3, col: 1, block: false, number: 10 },
    { row: 3, col: 2, block: false },
    { row: 3, col: 3, block: false },
    { row: 3, col: 4, block: false },
    { row: 3, col: 5, block: false },
    { row: 3, col: 6, block: true },
  ],
  [
    { row: 4, col: 0, block: false, number: 11 },
    { row: 4, col: 1, block: false },
    { row: 4, col: 2, block: false },
    { row: 4, col: 3, block: true },
    { row: 4, col: 4, block: false, number: 12 },
    { row: 4, col: 5, block: false },
    { row: 4, col: 6, block: false, number: 13 },
  ],
  [
    { row: 5, col: 0, block: false },
    { row: 5, col: 1, block: true },
    { row: 5, col: 2, block: false, number: 14 },
    { row: 5, col: 3, block: false },
    { row: 5, col: 4, block: false },
    { row: 5, col: 5, block: true },
    { row: 5, col: 6, block: false },
  ],
  [
    { row: 6, col: 0, block: false, number: 15 },
    { row: 6, col: 1, block: false },
    { row: 6, col: 2, block: false },
    { row: 6, col: 3, block: true },
    { row: 6, col: 4, block: false, number: 16 },
    { row: 6, col: 5, block: false },
    { row: 6, col: 6, block: false },
  ],
];

const EXPECTED_SOLUTION = [
  ['C', 'A', 'B', '', 'S', 'U', 'N'],
  ['A', '', 'A', 'G', 'E', '', 'E'],
  ['T', 'I', 'N', '', 'A', 'N', 'T'],
  ['', 'C', 'A', 'T', 'W', 'A', ''],
  ['T', 'E', 'N', '', 'E', 'P', 'S'],
  ['O', '', 'A', 'T', 'E', '', 'E'],
  ['P', 'A', 'S', '', 'D', 'O', 'A'],
];

const EXPECTED_SLOTS = [
  {
    id: '1A',
    number: 1,
    direction: 'across',
    row: 0,
    col: 0,
    length: 3,
    clue: 'Vehicle for hire',
    cells: [
      [0, 0],
      [0, 1],
      [0, 2],
    ],
  },
  {
    id: '1D',
    number: 1,
    direction: 'down',
    row: 0,
    col: 0,
    length: 3,
    clue: 'Household pet',
    cells: [
      [0, 0],
      [1, 0],
      [2, 0],
    ],
  },
  {
    id: '2D',
    number: 2,
    direction: 'down',
    row: 0,
    col: 2,
    length: 7,
    clue: 'Yellow fruit, informally crazy (3,4)',
    enumeration: '(3,4)',
    cells: [
      [0, 2],
      [1, 2],
      [2, 2],
      [3, 2],
      [4, 2],
      [5, 2],
      [6, 2],
    ],
  },
  {
    id: '3A',
    number: 3,
    direction: 'across',
    row: 0,
    col: 4,
    length: 3,
    clue: 'Star at the centre of our solar system',
    cells: [
      [0, 4],
      [0, 5],
      [0, 6],
    ],
  },
  {
    id: '3D',
    number: 3,
    direction: 'down',
    row: 0,
    col: 4,
    length: 7,
    clue: 'Marine plant washed up on shore',
    enumeration: '(3,4)',
    cells: [
      [0, 4],
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4],
      [5, 4],
      [6, 4],
    ],
  },
  {
    id: '4D',
    number: 4,
    direction: 'down',
    row: 0,
    col: 6,
    length: 3,
    clue: 'Fishing gear, or a website suffix',
    cells: [
      [0, 6],
      [1, 6],
      [2, 6],
    ],
  },
  {
    id: '5A',
    number: 5,
    direction: 'across',
    row: 1,
    col: 2,
    length: 3,
    clue: 'How many years old one is',
    cells: [
      [1, 2],
      [1, 3],
      [1, 4],
    ],
  },
  {
    id: '6A',
    number: 6,
    direction: 'across',
    row: 2,
    col: 0,
    length: 3,
    clue: 'Metal can material',
    cells: [
      [2, 0],
      [2, 1],
      [2, 2],
    ],
  },
  {
    id: '7D',
    number: 7,
    direction: 'down',
    row: 2,
    col: 1,
    length: 3,
    clue: 'Frozen water',
    cells: [
      [2, 1],
      [3, 1],
      [4, 1],
    ],
  },
  {
    id: '8A',
    number: 8,
    direction: 'across',
    row: 2,
    col: 4,
    length: 3,
    clue: 'Small industrious insect',
    cells: [
      [2, 4],
      [2, 5],
      [2, 6],
    ],
  },
  {
    id: '9D',
    number: 9,
    direction: 'down',
    row: 2,
    col: 5,
    length: 3,
    clue: 'Short daytime sleep',
    cells: [
      [2, 5],
      [3, 5],
      [4, 5],
    ],
  },
  {
    id: '10A',
    number: 10,
    direction: 'across',
    row: 3,
    col: 1,
    length: 5,
    clue: 'Synthetic filler word A (test fixture only)',
    cells: [
      [3, 1],
      [3, 2],
      [3, 3],
      [3, 4],
      [3, 5],
    ],
  },
  {
    id: '11A',
    number: 11,
    direction: 'across',
    row: 4,
    col: 0,
    length: 3,
    clue: 'Number after nine',
    cells: [
      [4, 0],
      [4, 1],
      [4, 2],
    ],
  },
  {
    id: '11D',
    number: 11,
    direction: 'down',
    row: 4,
    col: 0,
    length: 3,
    clue: 'Highest point',
    cells: [
      [4, 0],
      [5, 0],
      [6, 0],
    ],
  },
  {
    id: '12A',
    number: 12,
    direction: 'across',
    row: 4,
    col: 4,
    length: 3,
    clue: 'Synthetic filler word B (test fixture only)',
    cells: [
      [4, 4],
      [4, 5],
      [4, 6],
    ],
  },
  {
    id: '13D',
    number: 13,
    direction: 'down',
    row: 4,
    col: 6,
    length: 3,
    clue: 'Large body of salt water',
    cells: [
      [4, 6],
      [5, 6],
      [6, 6],
    ],
  },
  {
    id: '14A',
    number: 14,
    direction: 'across',
    row: 5,
    col: 2,
    length: 3,
    clue: 'Consumed in the past',
    cells: [
      [5, 2],
      [5, 3],
      [5, 4],
    ],
  },
  {
    id: '15A',
    number: 15,
    direction: 'across',
    row: 6,
    col: 0,
    length: 3,
    clue: 'Synthetic filler word C (test fixture only)',
    cells: [
      [6, 0],
      [6, 1],
      [6, 2],
    ],
  },
  {
    id: '16A',
    number: 16,
    direction: 'across',
    row: 6,
    col: 4,
    length: 3,
    clue: 'Synthetic filler word D (test fixture only)',
    cells: [
      [6, 4],
      [6, 5],
      [6, 6],
    ],
  },
];

describe('guardian adapter (T26)', () => {
  it('parses the fixture into a PuzzleWithSolution matching the expected literal cell by cell (acceptance 1)', () => {
    const payload = loadFixture();
    const puzzle = parseGuardianPayload(payload, ctx(), { style: 'cryptic' });

    expect(puzzle.id).toBe('cryptic-sample');
    expect(puzzle.source).toBe('guardian');
    expect(puzzle.style).toBe('cryptic');
    expect(puzzle.width).toBe(7);
    expect(puzzle.height).toBe(7);
    expect(puzzle.cells).toEqual(EXPECTED_CELLS);
    expect(puzzle.slots).toEqual(EXPECTED_SLOTS);
    expect(puzzle.solution).toEqual(EXPECTED_SOLUTION);
  });

  it('sets parsedBy to "guardian-json" (acceptance 2)', () => {
    const puzzle = parseGuardianPayload(loadFixture(), ctx(), { style: 'cryptic' });
    expect(puzzle.parsedBy).toBe('guardian-json');
  });

  it('never lets a clue contain its own solution as a substring (B42, acceptance 3)', () => {
    const puzzle = parseGuardianPayload(loadFixture(), ctx(), { style: 'cryptic' });
    for (const slot of puzzle.slots) {
      const normalisedClue = slot.clue.toUpperCase().replace(/[^A-Z]/g, '');
      const normalisedSolution = slot.cells
        .map(([row, col]) => puzzle.solution[row]?.[col] ?? '')
        .join('')
        .toUpperCase();
      expect(normalisedClue.includes(normalisedSolution)).toBe(false);
    }
  });

  it('converts a Guardian {x: 2, y: 0} position to row 0, col 2 (the axis-swap test, acceptance 4)', () => {
    const puzzle = parseGuardianPayload(loadFixture(), ctx(), { style: 'cryptic' });
    const slot2D = puzzle.slots.find((s) => s.id === '2D');
    expect(slot2D?.row).toBe(0);
    expect(slot2D?.col).toBe(2);
  });

  it('derives "(3,4)" from separatorLocations on a 7-letter entry with no enumeration in the clue (acceptance 5)', () => {
    const puzzle = parseGuardianPayload(loadFixture(), ctx(), { style: 'cryptic' });
    const slot3D = puzzle.slots.find((s) => s.id === '3D');
    expect(slot3D?.clue).toBe('Marine plant washed up on shore');
    expect(slot3D?.enumeration).toBe('(3,4)');
  });

  it('keeps a clue-supplied "(3,4)" even when separatorLocations disagrees, and warns once (acceptance 6)', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const puzzle = parseGuardianPayload(loadFixture(), ctx('cryptic-sample-warn-test'), {
        style: 'cryptic',
      });
      const slot2D = puzzle.slots.find((s) => s.id === '2D');
      // separatorLocations on this entry is {",": [2]}, which derives "(2,5)"
      // - disagreeing with the clue's own trailing "(3,4)".
      expect(slot2D?.enumeration).toBe('(3,4)');
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('throws a CliError code 3 naming the entry id on a solution/length mismatch (acceptance 7)', () => {
    const payload = loadFixture();
    const broken: GuardianPayload = {
      crossword: {
        entries: payload.crossword.entries.map((entry) =>
          entry.id === '5-across' ? { ...entry, solution: 'AGED' } : entry,
        ),
      },
    };

    let thrown: unknown;
    try {
      parseGuardianPayload(broken, ctx(), { style: 'cryptic' });
    } catch (e) {
      thrown = e;
    }

    expect(isCliError(thrown)).toBe(true);
    if (isCliError(thrown)) {
      expect(thrown.code).toBe(3);
      expect(thrown.message).toContain('5-across');
    }
  });

  it('is registered under the "json" extension via the PuzzleAdapter interface, defaulting style to "unknown"', async () => {
    const bytes = readFileSync(FIXTURE_PATH);
    expect(guardianAdapter.name).toBe('guardian-json');
    expect(guardianAdapter.extensions).toContain('json');

    const puzzle = await guardianAdapter.parse(bytes, ctx('via-extension-dispatch'));
    expect(puzzle.parsedBy).toBe('guardian-json');
    expect(puzzle.style).toBe('unknown');
  });
});
