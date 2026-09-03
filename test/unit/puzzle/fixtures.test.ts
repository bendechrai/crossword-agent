import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadPuzzleWithSolution } from '../../../src/puzzle/loader.js';
import { repoRoot } from '../../../src/util/fs.js';
import type { PuzzleWithSolution } from '../../../src/puzzle/types.js';

/**
 * T48: the four hand-picked, licence-clean `.xd` fixtures under
 * `puzzles/fixtures/` (A3). This test owns the post-condition checks the T48
 * task text asks for: each fixture parses through the real loader
 * (src/puzzle/loader.ts -> src/puzzle/adapters/xd.ts, T25) without error and
 * passes the B42 leakage check, plus the size/count/date bookkeeping the
 * acceptance list names. It does not duplicate T25's own xd.test.ts, which
 * covers the adapter's parsing rules with synthetic fixtures; this file only
 * asserts the *real corpus* fixtures this task selected are clean.
 */

const FIXTURES_DIR = join(repoRoot(), 'puzzles', 'fixtures');
const MAX_FIXTURE_BYTES = 20 * 1024;
const PRE_1965 = '1965-01-01';
const REQUIRED_FIXTURES_MD_FIELDS = [
  'Source URL',
  'Publication date',
  'Grid size',
  'Public-domain basis',
] as const;

function xdFixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith('.xd'))
    .sort();
}

/** The letters a slot's cells hold in the solution grid. */
function answerOf(puzzle: PuzzleWithSolution, cells: ReadonlyArray<readonly [number, number]>): string {
  return cells
    .map(([row, col]) => puzzle.solution[row]?.[col] ?? '')
    .join('')
    .toUpperCase();
}

/**
 * B42: no clue text may carry any slot's solution as a substring. Same check
 * as test/unit/puzzle/xd.test.ts's post-condition, restated here since that
 * file is owned by T25, not this task.
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

describe('puzzles/fixtures/*.xd (T48 licence-clean corpus fixtures)', () => {
  it('acceptance 1: exactly four .xd files exist, each under 20 KB', () => {
    const names = xdFixtureNames();
    expect(names).toHaveLength(4);
    for (const name of names) {
      const bytes = statSync(join(FIXTURES_DIR, name)).size;
      expect(bytes).toBeLessThan(MAX_FIXTURE_BYTES);
    }
  });

  // Acceptance 5 (`git check-ignore puzzles/fixtures/x.xd` reports the path
  // is not ignored) is not asserted here: the frozen .gitignore's
  // `!puzzles/fixtures/**` negation cannot take effect while `puzzles/**`
  // excludes the `puzzles/fixtures` directory itself from traversal (a
  // well-known gitignore limitation - a negated pattern has no effect if a
  // parent directory is excluded), and .gitignore is a frozen file this task
  // may not edit. The fixtures are committed anyway via `git add -f`; see the
  // PR's deviations note for the one-line fix (`!puzzles/fixtures` added
  // before `!puzzles/fixtures/**`) a future contract-owning task should make.

  for (const name of xdFixtureNames()) {
    it(`${name} parses through loadPuzzleWithSolution and has no B42 leak`, async () => {
      const puzzle = await loadPuzzleWithSolution(join(FIXTURES_DIR, name));
      expect(puzzle.parsedBy).toBe('xd-hand');
      expectNoSolutionLeak(puzzle);
    });
  }

  describe('FIXTURES.md', () => {
    const fixturesMdPath = join(FIXTURES_DIR, 'FIXTURES.md');
    const text = readFileSync(fixturesMdPath, 'utf8');
    // One `##` section per fixture, keyed by its .xd filename.
    const sections = text.split(/\n(?=## )/).filter((s) => s.startsWith('## '));

    it('acceptance 3: has one section per fixture with all four required fields, non-empty', () => {
      const names = xdFixtureNames();
      const fixtureSections = sections.filter((s) =>
        names.some((name) => s.startsWith(`## ${name}`)),
      );
      expect(fixtureSections).toHaveLength(names.length);

      for (const section of fixtureSections) {
        for (const field of REQUIRED_FIXTURES_MD_FIELDS) {
          const match = new RegExp(`- \\*\\*${field}:\\*\\*\\s*(.+)`).exec(section);
          expect(match, `${field} present in section: ${section.slice(0, 40)}`).not.toBeNull();
          expect((match?.[1] ?? '').trim().length).toBeGreaterThan(0);
        }
      }
    });

    it('acceptance 4: every recorded publication date is before 1965-01-01', () => {
      const dateMatches = [...text.matchAll(/- \*\*Publication date:\*\*\s*(\d{4}-\d{2}-\d{2})/g)];
      expect(dateMatches.length).toBeGreaterThanOrEqual(4);
      for (const match of dateMatches) {
        const date = match[1] ?? '';
        expect(date < PRE_1965).toBe(true);
      }
    });

    it('states the licence basis needs Ben\'s review before any redistribution claim', () => {
      expect(text).toContain("Licence basis needs Ben's review before any redistribution claim");
    });
  });
});
