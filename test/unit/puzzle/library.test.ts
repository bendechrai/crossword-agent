import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchemaObject } from 'ajv/dist/2020.js';
import * as ajvFormatsModule from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliError, ExitCode } from '../../../src/cli/exit.js';
import {
  loadPuzzleById,
  loadSolution,
  readIndex,
  readNormalised,
  upsertIndexRow,
  writeNormalised,
} from '../../../src/puzzle/library.js';
import type { PuzzleIndexRow, PuzzleWithSolution } from '../../../src/puzzle/types.js';

const addFormats = ajvFormatsModule.default as unknown as FormatsPlugin;
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function compileSchema(schemaFile: string) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const schema = JSON.parse(
    readFileSync(`${repoRoot}schemas/${schemaFile}`, 'utf8'),
  ) as AnySchemaObject;
  return ajv.compile(schema);
}

const validatePuzzleFile = compileSchema('puzzle.schema.json');
const validateIndexRow = compileSchema('puzzle-index.schema.json');

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crossword-library-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** A minimal 2x2 puzzle, block-free, small enough to keep every test focused. */
function samplePuzzle(id: string, source = 'test-source'): PuzzleWithSolution {
  return {
    id,
    source,
    style: 'american',
    width: 2,
    height: 2,
    parsedBy: 'xd-crossword-tools',
    cells: [
      [
        { row: 0, col: 0, block: false, number: 1 },
        { row: 0, col: 1, block: false, number: 2 },
      ],
      [
        { row: 1, col: 0, block: false, number: 3 },
        { row: 1, col: 1, block: false },
      ],
    ],
    slots: [
      {
        id: '1A',
        number: 1,
        direction: 'across',
        row: 0,
        col: 0,
        length: 2,
        clue: 'First across',
        cells: [
          [0, 0],
          [0, 1],
        ],
      },
      {
        id: '1D',
        number: 1,
        direction: 'down',
        row: 0,
        col: 0,
        length: 2,
        clue: 'First down',
        cells: [
          [0, 0],
          [1, 0],
        ],
      },
    ],
    solution: [
      ['A', 'B'],
      ['C', 'D'],
    ],
  };
}

function sampleRow(id: string, overrides: Partial<PuzzleIndexRow> = {}): PuzzleIndexRow {
  return {
    id,
    source: 'test-source',
    date: null,
    title: null,
    style: 'american',
    width: 2,
    height: 2,
    slotCount: 2,
    files: {
      original: `puzzles/test-source/${id}.xd`,
      normalised: `puzzles/test-source/${id}.json`,
    },
    schemaVersion: 1,
    parsedBy: 'xd-crossword-tools',
    addedAt: '2026-01-01T00:00:00.000Z',
    bestLetterAccuracy: null,
    lastRunAt: null,
    ...overrides,
  };
}

describe('writeNormalised / readNormalised', () => {
  it('round-trips deep-equal and the written file validates against schemas/puzzle.schema.json', async () => {
    const dir = tempDir();
    const puzzle = samplePuzzle('roundtrip');

    const written = await writeNormalised(puzzle, { puzzlesDir: dir });
    const read = await readNormalised('roundtrip', { puzzlesDir: dir });

    expect(read).toEqual(written);

    const onDisk: unknown = JSON.parse(
      readFileSync(join(dir, 'test-source', 'roundtrip.json'), 'utf8'),
    );
    expect(validatePuzzleFile(onDisk), JSON.stringify(validatePuzzleFile.errors)).toBe(true);
  });

  it('adds schemaVersion 1 and an ISO-8601 fetchedAt', async () => {
    const dir = tempDir();
    const written = await writeNormalised(samplePuzzle('stamped'), { puzzlesDir: dir });

    expect(written.schemaVersion).toBe(1);
    expect(new Date(written.fetchedAt).toISOString()).toBe(written.fetchedAt);
  });

  it('readNormalised finds the file by id alone, regardless of source subdirectory', async () => {
    const dir = tempDir();
    await writeNormalised(samplePuzzle('findme', 'another-source'), { puzzlesDir: dir });

    const read = await readNormalised('findme', { puzzlesDir: dir });
    expect(read.source).toBe('another-source');
  });

  it('rejects a missing id with a not-found error', async () => {
    const dir = tempDir();
    await expect(readNormalised('nope', { puzzlesDir: dir })).rejects.toMatchObject({
      code: ExitCode.NOT_FOUND,
    });
  });
});

describe('loadPuzzleById / loadSolution', () => {
  it('loadPuzzleById strips solution so the key is absent, not undefined', async () => {
    const dir = tempDir();
    await writeNormalised(samplePuzzle('stripped'), { puzzlesDir: dir });

    const puzzle = await loadPuzzleById('stripped', { puzzlesDir: dir });
    expect('solution' in puzzle).toBe(false);
    expect(puzzle.id).toBe('stripped');
    expect(puzzle.slots).toHaveLength(2);
  });

  it('loadSolution returns the grid', async () => {
    const dir = tempDir();
    await writeNormalised(samplePuzzle('grid'), { puzzlesDir: dir });

    const solution = await loadSolution('grid', { puzzlesDir: dir });
    expect(solution).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ]);
  });
});

describe('readIndex', () => {
  it('returns [] when puzzles/index.json is missing', async () => {
    const dir = tempDir();
    await expect(readIndex({ puzzlesDir: dir })).resolves.toEqual([]);
  });
});

describe('upsertIndexRow', () => {
  it('a second call for the same id replaces the row with one entry', async () => {
    const dir = tempDir();
    await upsertIndexRow(sampleRow('dup', { bestLetterAccuracy: null }), { puzzlesDir: dir });
    await upsertIndexRow(sampleRow('dup', { bestLetterAccuracy: 0.9, lastRunAt: '2026-01-02T00:00:00.000Z' }), {
      puzzlesDir: dir,
    });

    const rows = await readIndex({ puzzlesDir: dir });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bestLetterAccuracy).toBe(0.9);
    expect(rows[0]?.lastRunAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('a row missing files fails schema validation and is rejected before any write', async () => {
    const dir = tempDir();
    const badRow = sampleRow('bad') as unknown as Record<string, unknown>;
    delete badRow.files;

    await expect(
      upsertIndexRow(badRow as unknown as PuzzleIndexRow, { puzzlesDir: dir }),
    ).rejects.toThrow(/schema/i);

    expect(existsSync(join(dir, 'index.json'))).toBe(false);
    expect(existsSync(join(dir, '.index.lock'))).toBe(false);
  });

  it('writes a row that itself validates against schemas/puzzle-index.schema.json', async () => {
    const dir = tempDir();
    await upsertIndexRow(sampleRow('valid'), { puzzlesDir: dir });

    const rows = await readIndex({ puzzlesDir: dir });
    expect(validateIndexRow(rows), JSON.stringify(validateIndexRow.errors)).toBe(true);
  });

  it('10 concurrent calls all land: 10 rows, and the file is valid JSON throughout', async () => {
    const dir = tempDir();
    const indexPath = join(dir, 'index.json');

    let stop = false;
    let sawInvalidJson = false;
    const watcher = (async () => {
      while (!stop) {
        if (existsSync(indexPath)) {
          try {
            JSON.parse(readFileSync(indexPath, 'utf8'));
          } catch {
            sawInvalidJson = true;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();

    await Promise.all(
      Array.from({ length: 10 }, (_, i) => upsertIndexRow(sampleRow(`row-${i}`), { puzzlesDir: dir })),
    );
    stop = true;
    await watcher;

    expect(sawInvalidJson).toBe(false);
    const rows = await readIndex({ puzzlesDir: dir });
    expect(rows).toHaveLength(10);
    expect(new Set(rows.map((r) => r.id)).size).toBe(10);
  });

  it('throws a CliError code 1 naming the lock path after a 5s timeout', async () => {
    const dir = tempDir();
    const lockPath = join(dir, '.index.lock');
    writeFileSync(lockPath, '');

    vi.useFakeTimers();
    const caught = upsertIndexRow(sampleRow('blocked'), { puzzlesDir: dir }).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(5000);
    const error = await caught;

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(ExitCode.UNEXPECTED);
    expect((error as CliError).message).toContain(lockPath);
  });
});
