import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listCommand } from '../../../src/cli/list.js';
import type { GlobalOptions, ListOptions } from '../../../src/cli/options.js';
import { upsertIndexRow } from '../../../src/puzzle/library.js';
import type { PuzzleIndexRow } from '../../../src/puzzle/types.js';

const GLOBAL: GlobalOptions = { color: false };

function options(overrides: Partial<ListOptions> = {}): ListOptions {
  return { solved: false, json: false, ...overrides };
}

function sampleRow(id: string, overrides: Partial<PuzzleIndexRow> = {}): PuzzleIndexRow {
  return {
    id,
    source: 'xd',
    date: '2026-01-01',
    title: `Puzzle ${id}`,
    style: 'american',
    width: 15,
    height: 15,
    slotCount: 32,
    files: {
      original: `puzzles/xd/${id}.xd`,
      normalised: `puzzles/xd/${id}.json`,
    },
    schemaVersion: 1,
    parsedBy: 'xd-crossword-tools',
    addedAt: '2026-01-01T00:00:00.000Z',
    bestLetterAccuracy: null,
    lastRunAt: null,
    ...overrides,
  };
}

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crossword-cli-list-'));
  temps.push(dir);
  return dir;
}

let lines: string[];

beforeEach(() => {
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('listCommand', () => {
  it('prints a header plus one row per puzzle in the index', async () => {
    const dir = tempDir();
    await upsertIndexRow(sampleRow('a'), { puzzlesDir: dir });
    await upsertIndexRow(sampleRow('b', { source: 'guardian' }), { puzzlesDir: dir });
    await upsertIndexRow(sampleRow('c', { source: 'guardian' }), { puzzlesDir: dir });

    await listCommand(options(), GLOBAL, { puzzlesDir: dir });

    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^id\s+source\s+date\s+size\s+style\s+slots\s+best letters\s+last run$/);
  });

  it('--source filters to only that source', async () => {
    const dir = tempDir();
    await upsertIndexRow(sampleRow('a', { source: 'xd' }), { puzzlesDir: dir });
    await upsertIndexRow(sampleRow('b', { source: 'guardian' }), { puzzlesDir: dir });

    await listCommand(options({ source: 'xd' }), GLOBAL, { puzzlesDir: dir });

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('a');
    expect(lines[1]).not.toContain(' b ');
  });

  it('--style filters to only that style', async () => {
    const dir = tempDir();
    await upsertIndexRow(sampleRow('a', { style: 'cryptic' }), { puzzlesDir: dir });
    await upsertIndexRow(sampleRow('b', { style: 'american' }), { puzzlesDir: dir });

    await listCommand(options({ style: 'cryptic' }), GLOBAL, { puzzlesDir: dir });

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('a');
  });

  it('--solved includes a row at bestLetterAccuracy 1 and excludes one at 0.99', async () => {
    const dir = tempDir();
    await upsertIndexRow(sampleRow('perfect', { bestLetterAccuracy: 1 }), { puzzlesDir: dir });
    await upsertIndexRow(sampleRow('close', { bestLetterAccuracy: 0.99 }), { puzzlesDir: dir });

    await listCommand(options({ solved: true }), GLOBAL, { puzzlesDir: dir });

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('perfect');
    expect(lines.join('\n')).not.toContain('close');
  });

  it('renders a null bestLetterAccuracy as "-"', async () => {
    const dir = tempDir();
    await upsertIndexRow(sampleRow('unrun', { bestLetterAccuracy: null }), { puzzlesDir: dir });

    await listCommand(options(), GLOBAL, { puzzlesDir: dir });

    const dataLine = lines[1] ?? '';
    const cells = dataLine.trim().split(/\s{2,}/);
    // id, source, date, size, style, slots, best letters, last run
    expect(cells[6]).toBe('-');
  });

  it('an empty index prints exactly the B33 message and exits without throwing', async () => {
    const dir = tempDir();

    await listCommand(options(), GLOBAL, { puzzlesDir: dir });

    expect(lines).toEqual(['no puzzles yet - try: xw fetch xd --limit 5']);
  });

  it('an empty index with --json prints exactly "[]"', async () => {
    const dir = tempDir();

    await listCommand(options({ json: true }), GLOBAL, { puzzlesDir: dir });

    expect(lines).toEqual(['[]']);
  });

  it('--json prints the raw index rows', async () => {
    const dir = tempDir();
    await upsertIndexRow(sampleRow('a'), { puzzlesDir: dir });

    await listCommand(options({ json: true }), GLOBAL, { puzzlesDir: dir });

    expect(lines).toHaveLength(1);
    const parsed: unknown = JSON.parse(lines[0] ?? '[]');
    expect(parsed).toEqual([sampleRow('a')]);
  });

  it('caps every printed line at 80 columns, truncating a wide id with "..."', async () => {
    const dir = tempDir();
    const wideId = 'a'.repeat(40);
    await upsertIndexRow(sampleRow(wideId), { puzzlesDir: dir });

    await listCommand(options(), GLOBAL, { puzzlesDir: dir });

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
    const idCell = (lines[1] ?? '').trim().split(/\s{2,}/)[0] ?? '';
    expect(idCell.endsWith('...')).toBe(true);
    expect(idCell.length).toBeLessThan(wideId.length);
  });
});
