import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * T57. `sets/mixed-30.json` is the bench set every escalation-policy and
 * batch-size decision in docs/spec.md's "Strategy profiles" section is run
 * against (B36: `{ name, puzzles: [{ id, stratum }] }`). Nothing in the
 * loader (`src/cli/bench.ts`) enforces its 30/20/10 shape or its
 * id/stratum-only keys at parse time - an extra key or a skewed split would
 * silently change what a bench run measures - so this contract test pins
 * the shape directly against the file on disk rather than through any
 * loader code path, per this task's Reads-only access to that file.
 *
 * It also pins the no-real-puzzles-committed policy (2026-09-04 addendum to
 * docs/decisions/2026-09-03-spec-review.md, superseding A3/B47): no entry's
 * id may start with a real-publisher prefix such as `nyt-`, which would
 * identify a specific real puzzle even though the puzzle itself is not
 * committed.
 */

const SETS_PATH = new URL('../../sets/mixed-30.json', import.meta.url);
const MIXED_12_PATH = new URL('../../sets/mixed-12.json', import.meta.url);

interface RawSetEntry {
  id?: unknown;
  stratum?: unknown;
}

interface RawSetFile {
  name?: unknown;
  note?: unknown;
  puzzles?: unknown;
}

function loadSetAt(path: URL): RawSetFile {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as RawSetFile;
}

function loadSet(): RawSetFile {
  return loadSetAt(SETS_PATH);
}

/** A real-publisher id prefix look like the four deleted xd fixtures used: `nyt-1955-06-06`. */
const REAL_PUBLISHER_PREFIXES = ['nyt-'];

describe('sets/mixed-30.json (B36, T57)', () => {
  const set = loadSet();

  it('is an object with a puzzles array', () => {
    expect(set).toBeTypeOf('object');
    expect(Array.isArray(set.puzzles)).toBe(true);
  });

  const puzzles = set.puzzles as RawSetEntry[];

  it('has exactly 30 entries', () => {
    expect(puzzles).toHaveLength(30);
  });

  it('splits 20 american and 10 cryptic', () => {
    const american = puzzles.filter((entry) => entry.stratum === 'american');
    const cryptic = puzzles.filter((entry) => entry.stratum === 'cryptic');
    expect(american).toHaveLength(20);
    expect(cryptic).toHaveLength(10);
  });

  it('has only american or cryptic strata, nothing else', () => {
    for (const entry of puzzles) {
      expect(entry.stratum === 'american' || entry.stratum === 'cryptic').toBe(true);
    }
  });

  it('gives every entry a non-empty string id', () => {
    for (const entry of puzzles) {
      expect(typeof entry.id).toBe('string');
      expect((entry.id as string).length).toBeGreaterThan(0);
    }
  });

  it('has only id and stratum keys on every entry', () => {
    for (const entry of puzzles) {
      expect(Object.keys(entry).sort()).toEqual(['id', 'stratum']);
    }
  });

  it('has no duplicate ids', () => {
    const ids = puzzles.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no id starting with a real-publisher prefix', () => {
    for (const entry of puzzles) {
      const id = entry.id as string;
      for (const prefix of REAL_PUBLISHER_PREFIXES) {
        expect(id.startsWith(prefix)).toBe(false);
      }
    }
  });
});

/**
 * T60. `sets/mixed-12.json` is the first real (non-placeholder) bench set:
 * 8 pre-1965 NYT dailies from the xd corpus plus 4 Guardian cryptics. Unlike
 * `mixed-30.json` above, its ids deliberately do name real, publicly
 * fetchable puzzles (`xd-nyt...`, `guardian-cryptic-...`) - the
 * no-distribution policy is about not committing puzzle *content*, and this
 * file commits only an id list, no puzzle bytes - so the real-publisher-
 * prefix check above does not apply here.
 */
describe('sets/mixed-12.json (B36, T60)', () => {
  const set = loadSetAt(MIXED_12_PATH);

  it('is an object with a puzzles array', () => {
    expect(set).toBeTypeOf('object');
    expect(Array.isArray(set.puzzles)).toBe(true);
  });

  const puzzles = set.puzzles as RawSetEntry[];

  it('has exactly 12 entries', () => {
    expect(puzzles).toHaveLength(12);
  });

  it('splits 8 american and 4 cryptic', () => {
    const american = puzzles.filter((entry) => entry.stratum === 'american');
    const cryptic = puzzles.filter((entry) => entry.stratum === 'cryptic');
    expect(american).toHaveLength(8);
    expect(cryptic).toHaveLength(4);
  });

  it('has only american or cryptic strata, nothing else', () => {
    for (const entry of puzzles) {
      expect(entry.stratum === 'american' || entry.stratum === 'cryptic').toBe(true);
    }
  });

  it('gives every entry a non-empty string id', () => {
    for (const entry of puzzles) {
      expect(typeof entry.id).toBe('string');
      expect((entry.id as string).length).toBeGreaterThan(0);
    }
  });

  it('has only id and stratum keys on every entry', () => {
    for (const entry of puzzles) {
      expect(Object.keys(entry).sort()).toEqual(['id', 'stratum']);
    }
  });

  it('has no duplicate ids', () => {
    const ids = puzzles.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
