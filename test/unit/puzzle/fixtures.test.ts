import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from '../../../src/util/fs.js';
import type { NormalisedPuzzleFile } from '../../../src/puzzle/types.js';

/**
 * T56: no real crossword puzzle is committed to this repository in any form
 * (Ben's no-distribution policy, superseding A3/B47 - see
 * docs/decisions/2026-09-03-spec-review.md's dated addendum). This replaces
 * T48's fixtures.test.ts, which asserted properties of the four real,
 * pre-1965 NYT `.xd` fixtures T56 deleted from `puzzles/fixtures/`.
 *
 * This file instead owns two checks: that nothing under `puzzles/` exists on
 * disk (the deletion is exact, not partial), and that the two synthetic
 * fixtures - the only puzzles this repository ever commits - still satisfy
 * the B42 loader post-condition (no clue leaks any slot's solution).
 *
 * The first check is a filesystem walk, not a call to the `git` binary:
 * `src/util/git.ts`'s own doc comment records that the container this suite
 * runs in has no git binary, and never invokes one for exactly that reason.
 * A filesystem check is the environment-safe equivalent here: combined with
 * `.gitignore`'s unconditional `puzzles/**` (T56 removed the only re-include
 * lines it had), nothing can be newly added under `puzzles/` without `git
 * add -f`, and this test proves nothing is there to have been tracked in the
 * first place. `git ls-files puzzles` printing nothing is the acceptance
 * criterion the orchestrator checks directly against the commit.
 *
 * The synthetic B42 property is also covered by the frozen
 * `test/contract/schemas.test.ts`; restating it here is deliberate, matching
 * the plan's deliverable text for this task, and cheap insurance should that
 * contract test ever narrow its own coverage.
 */

const ROOT = repoRoot();
const SYNTHETIC_FIXTURES = ['synthetic-5x5', 'synthetic-7x7'] as const;

/** Every regular file under `dir`, recursively. */
function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) out.push(...listFilesRecursive(full));
    else if (stats.isFile()) out.push(full);
  }
  return out;
}

function readSyntheticFixture(name: string): NormalisedPuzzleFile {
  const raw = readFileSync(join(ROOT, 'test/fixtures/puzzles', `${name}.json`), 'utf8');
  return JSON.parse(raw) as NormalisedPuzzleFile;
}

/** B42: no `Slot.clue` may contain any slot's solution as a substring. */
function expectNoSolutionLeak(puzzle: NormalisedPuzzleFile): void {
  expect(puzzle.slots.length).toBeGreaterThan(0);
  const answers = puzzle.slots.map((slot) =>
    slot.cells.map(([row, col]) => puzzle.solution[row]?.[col] ?? '').join(''),
  );
  for (const answer of answers) expect(answer.length).toBeGreaterThan(0);

  const leaks: string[] = [];
  for (const slot of puzzle.slots) {
    const stripped = slot.clue.toUpperCase().replace(/[^A-Z]/g, '');
    for (const answer of answers) {
      if (stripped.includes(answer.toUpperCase())) leaks.push(`${slot.id} carries ${answer}`);
    }
  }
  expect(leaks).toEqual([]);
}

describe('T56: no real puzzles in the repository; synthetic-only fixtures', () => {
  it('acceptance 1: puzzles/ holds no file (nothing there for git to track)', () => {
    const puzzlesDir = join(ROOT, 'puzzles');
    if (!existsSync(puzzlesDir)) return; // fully deleted: strongest possible pass
    expect(listFilesRecursive(puzzlesDir)).toEqual([]);
  });

  for (const name of SYNTHETIC_FIXTURES) {
    it(`${name}: still satisfies the B42 no-leak post-condition`, () => {
      expectNoSolutionLeak(readSyntheticFixture(name));
    });
  }
});
