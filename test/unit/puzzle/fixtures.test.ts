import { existsSync, readFileSync } from 'node:fs';
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
 * This file instead owns two checks: that the deleted fixture directory
 * (`puzzles/fixtures/`) is gone and that `.gitignore` unconditionally
 * ignores everything else under `puzzles/`, and that the two synthetic
 * fixtures - the only puzzles this repository ever commits - still satisfy
 * the B42 loader post-condition (no clue leaks any slot's solution).
 *
 * The first check deliberately does NOT walk all of `puzzles/`: that
 * directory is also where `xw fetch` writes locally fetched puzzles
 * (src/util/fs.ts's `resolvePuzzlesDir`, src/cli/fetch.ts), which are
 * gitignored and never committed but legitimately present on a
 * contributor's or CI's disk (e.g. from running the CLI against a real
 * source). A recursive walk asserting zero files there would fail outside
 * a pristine checkout even though nothing is tracked. The property this
 * task actually needs - nothing under `puzzles/` can be tracked by git - is
 * instead proven the environment-safe way, without the `git` binary
 * (`src/util/git.ts`'s own doc comment records that the container this
 * suite runs in has none): `puzzles/fixtures/` (the only place real
 * fixtures ever lived) must not exist on disk at all, and `.gitignore` must
 * contain an unconditional `puzzles/**` line and no `!puzzles`-prefixed
 * re-include line - so nothing under `puzzles/` can be newly added without
 * `git add -f`. `git ls-files puzzles` printing nothing is the acceptance
 * criterion the orchestrator checks directly against the commit.
 *
 * The synthetic B42 property is also covered by the frozen
 * `test/contract/schemas.test.ts`; restating it here is deliberate, matching
 * the plan's deliverable text for this task, and cheap insurance should that
 * contract test ever narrow its own coverage.
 */

const ROOT = repoRoot();
const SYNTHETIC_FIXTURES = ['synthetic-5x5', 'synthetic-7x7'] as const;

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
  it('acceptance 1: puzzles/fixtures/ (the former real-puzzle directory) is gone', () => {
    expect(existsSync(join(ROOT, 'puzzles/fixtures'))).toBe(false);
  });

  it('acceptance 1: .gitignore ignores all of puzzles/ unconditionally, with no re-include', () => {
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    const lines = gitignore.split(/\r?\n/);
    expect(lines).toContain('puzzles/**');
    const reincludes = lines.filter((line) => line.trimStart().startsWith('!puzzles'));
    expect(reincludes).toEqual([]);
  });

  for (const name of SYNTHETIC_FIXTURES) {
    it(`${name}: still satisfies the B42 no-leak post-condition`, () => {
      expectNoSolutionLeak(readSyntheticFixture(name));
    });
  }
});
