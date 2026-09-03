import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliError, ExitCode } from '../../../src/cli/exit.js';
import type { GlobalOptions, ShowOptions } from '../../../src/cli/options.js';
import { showCommand } from '../../../src/cli/show.js';

const GLOBAL: GlobalOptions = { color: false };

function options(overrides: Partial<ShowOptions> = {}): ShowOptions {
  return { solution: false, ...overrides };
}

const fixturePath = fileURLToPath(
  new URL('../../../test/fixtures/puzzles/synthetic-5x5.json', import.meta.url),
);

const temps: string[] = [];

/** `<dir>/synthetic/synthetic-5x5.json`, matching the fixture's own `source` field. */
function libraryWithSyntheticFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crossword-cli-show-'));
  temps.push(dir);
  const sourceDir = join(dir, 'synthetic');
  mkdirSync(sourceDir, { recursive: true });
  copyFileSync(fixturePath, join(sourceDir, 'synthetic-5x5.json'));
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

describe('showCommand', () => {
  it('prints a grid with # for blocks and . for letters, then Across and Down in number order', async () => {
    const dir = libraryWithSyntheticFixture();

    await showCommand('synthetic-5x5', options(), GLOBAL, { puzzlesDir: dir });

    const output = lines.join('\n');

    // Row 0 of the fixture: two open cells, a block, then two open cells.
    expect(lines[0]).toBe('. . # . .');
    // Row 4: block, open, block, open, open.
    expect(lines[4]).toBe('# . # . .');

    const acrossIndex = lines.indexOf('Across:');
    const downIndex = lines.indexOf('Down:');
    expect(acrossIndex).toBeGreaterThan(-1);
    expect(downIndex).toBeGreaterThan(acrossIndex);

    const acrossLines = lines.slice(acrossIndex + 1, downIndex).filter((l) => l.trim().length > 0);
    const acrossNumbers = acrossLines.map((l) => Number(l.trim().split('.')[0]));
    expect(acrossNumbers).toEqual([...acrossNumbers].sort((a, b) => a - b));
    expect(acrossLines.some((l) => l.includes('Cry of surprise'))).toBe(true);

    const downLines = lines.slice(downIndex + 1).filter((l) => l.trim().length > 0);
    const downNumbers = downLines.map((l) => Number(l.trim().split('.')[0]));
    expect(downNumbers).toEqual([...downNumbers].sort((a, b) => a - b));

    // No solution letter anywhere without --solution.
    expect(output).not.toContain('RAYON');
    expect(output).not.toContain('AVOID');
  });

  it('--solution prints the solution letters', async () => {
    const dir = libraryWithSyntheticFixture();

    await showCommand('synthetic-5x5', options({ solution: true }), GLOBAL, { puzzlesDir: dir });

    // Row 1 of the fixture's solution is R A Y O N.
    expect(lines[1]).toBe('R A Y O N');
  });

  it('exits 3 on an unknown id, with a hint suggesting xw list', async () => {
    const dir = libraryWithSyntheticFixture();

    let caught: unknown;
    try {
      await showCommand('does-not-exist', options(), GLOBAL, { puzzlesDir: dir });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CliError);
    const cliError = caught as CliError;
    expect(cliError.code).toBe(ExitCode.NOT_FOUND);
    expect(cliError.hint).toMatch(/xw list/);
  });
});
