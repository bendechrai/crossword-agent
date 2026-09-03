import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExitCode, isCliError } from '../../../src/cli/exit.js';
import { fetchCommand } from '../../../src/cli/fetch.js';
import type { FetchOptions, GlobalOptions } from '../../../src/cli/options.js';
import { readIndex } from '../../../src/puzzle/library.js';
import type { PuzzleExt } from '../../../src/puzzle/types.js';
import { registerSource } from '../../../src/sources/registry.js';
import type { PuzzleRef, SourceAdapter, SourceListOptions } from '../../../src/sources/types.js';

const GLOBAL: GlobalOptions = { color: false };

function options(overrides: Partial<FetchOptions> = {}): FetchOptions {
  return { limit: 1, out: 'puzzles/', ...overrides };
}

function fixtureUrl(relative: string): URL {
  return new URL(`../../fixtures/${relative}`, import.meta.url);
}

function readFixtureBytes(relative: string): Buffer {
  return readFileSync(fixtureUrl(relative));
}

/** A well-formed, schema-clean puzzle: `@xwordly/xword-parser` handles `.ipuz`. */
const IPUZ_BYTES = readFixtureBytes('puzzles/synthetic-5x5.ipuz');
/** A second well-formed, schema-clean puzzle: the generic `.json` (guardian) adapter. */
const GUARDIAN_JSON_BYTES = readFixtureBytes('guardian/cryptic-sample.json');

interface StubEntry {
  ref: PuzzleRef;
  bytes: Buffer;
}

/**
 * A minimal `SourceAdapter` whose `list`/`download` are driven entirely by
 * the fixture entries handed to it, so each test controls exactly what
 * `fetchCommand` sees without touching the network or the real source
 * adapters. `normalise` is never called by `fetchCommand` (T29 dispatches
 * through `puzzle/loader.ts` instead, per T22/T27's own adapters) so it just
 * rejects if something unexpectedly reaches it.
 */
function stubSource(id: string, entries: StubEntry[]): SourceAdapter {
  return {
    id,
    list: (_opts: SourceListOptions) => Promise.resolve(entries.map((e) => e.ref)),
    download: (ref: PuzzleRef) => {
      const entry = entries.find((e) => e.ref.id === ref.id);
      if (entry === undefined) return Promise.reject(new Error(`stub source has no bytes for "${ref.id}"`));
      return Promise.resolve({ bytes: entry.bytes, ext: ref.ext });
    },
    normalise: () => Promise.reject(new Error(`${id}: normalise() should never be called by fetchCommand`)),
  };
}

function ref(id: string, ext: PuzzleExt, overrides: Partial<PuzzleRef> = {}): PuzzleRef {
  return { id, source: 'stub', url: `https://example.test/${id}.${ext}`, ext, ...overrides };
}

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crossword-cli-fetch-'));
  temps.push(dir);
  return dir;
}

let logLines: string[];
let errorLines: string[];

beforeEach(() => {
  logLines = [];
  errorLines = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    logLines.push(String(line));
  });
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    errorLines.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('fetchCommand', () => {
  it('downloads, writes and indexes every ref from a stub adapter (acceptance 1)', async () => {
    const dir = tempDir();
    const entries: StubEntry[] = [
      { ref: ref('puzzle-one', 'ipuz'), bytes: IPUZ_BYTES },
      { ref: ref('puzzle-two', 'json'), bytes: GUARDIAN_JSON_BYTES },
    ];
    registerSource(stubSource('stub-1', entries));

    await fetchCommand('stub-1', options({ out: dir, limit: 2 }), GLOBAL);

    expect(existsSync(join(dir, 'stub', 'puzzle-one.ipuz'))).toBe(true);
    expect(existsSync(join(dir, 'stub', 'puzzle-one.json'))).toBe(true);
    expect(existsSync(join(dir, 'stub', 'puzzle-two.json'))).toBe(true);

    const rows = await readIndex({ puzzlesDir: dir });
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('puzzle-one')?.files).toEqual({
      original: join(dir, 'stub', 'puzzle-one.ipuz'),
      normalised: join(dir, 'stub', 'puzzle-one.json'),
    });
    expect(byId.get('puzzle-two')?.files).toEqual({
      original: join(dir, 'stub', 'puzzle-two.json'),
      normalised: join(dir, 'stub', 'puzzle-two.json'),
    });
    expect(byId.get('puzzle-one')?.parsedBy).toBe('@xwordly/xword-parser');
    expect(byId.get('puzzle-two')?.parsedBy).toBe('guardian-json');
    expect(byId.get('puzzle-one')?.bestLetterAccuracy).toBeNull();
    expect(byId.get('puzzle-one')?.lastRunAt).toBeNull();
  });

  it('prints one "fetched" line per puzzle matching the spec format exactly (acceptance 2)', async () => {
    const dir = tempDir();
    registerSource(stubSource('stub-2', [{ ref: ref('puzzle-one', 'ipuz'), bytes: IPUZ_BYTES }]));

    await fetchCommand('stub-2', options({ out: dir }), GLOBAL);

    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toMatch(/^fetched \S+ {2}\d+x\d+ {2}\w+ {2}\d+ slots$/);
    expect(logLines[0]).toBe('fetched puzzle-one  5x5  unknown  11 slots');
  });

  it('exits 3 naming the source when the adapter returns zero refs (acceptance 3)', async () => {
    const dir = tempDir();
    registerSource(stubSource('stub-empty', []));

    await expect(fetchCommand('stub-empty', options({ out: dir }), GLOBAL)).rejects.toSatisfy((e: unknown) => {
      expect(isCliError(e)).toBe(true);
      if (!isCliError(e)) return false;
      expect(e.code).toBe(ExitCode.NOT_FOUND);
      expect(e.message).toContain('stub-empty');
      return true;
    });
  });

  it('a parse failure on one ref prints an error line, still writes the other puzzle fully, and exits 3 (acceptance 4)', async () => {
    const dir = tempDir();
    const badBytes = Buffer.from('not valid ipuz json at all', 'utf8');
    const entries: StubEntry[] = [
      { ref: ref('bad-one', 'ipuz'), bytes: badBytes },
      { ref: ref('good-one', 'ipuz'), bytes: IPUZ_BYTES },
    ];
    registerSource(stubSource('stub-partial', entries));

    await expect(fetchCommand('stub-partial', options({ out: dir, limit: 2 }), GLOBAL)).rejects.toSatisfy(
      (e: unknown) => {
        expect(isCliError(e)).toBe(true);
        if (!isCliError(e)) return false;
        expect(e.code).toBe(ExitCode.NOT_FOUND);
        return true;
      },
    );

    // The original bytes for the failing ref are on disk even though it
    // never parsed - a parse bug never loses the download.
    expect(existsSync(join(dir, 'stub', 'bad-one.ipuz'))).toBe(true);
    expect(existsSync(join(dir, 'stub', 'bad-one.json'))).toBe(false);

    // The other puzzle in the same batch is fully written: original,
    // normalised and indexed.
    expect(existsSync(join(dir, 'stub', 'good-one.ipuz'))).toBe(true);
    expect(existsSync(join(dir, 'stub', 'good-one.json'))).toBe(true);
    const rows = await readIndex({ puzzlesDir: dir });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('good-one');

    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain('bad-one');
  });

  it('--out writes puzzles and the index under the given directory (acceptance 5)', async () => {
    const dir = tempDir();
    registerSource(stubSource('stub-out', [{ ref: ref('puzzle-one', 'ipuz'), bytes: IPUZ_BYTES }]));

    await fetchCommand('stub-out', options({ out: dir }), GLOBAL);

    expect(existsSync(join(dir, 'stub', 'puzzle-one.ipuz'))).toBe(true);
    expect(existsSync(join(dir, 'index.json'))).toBe(true);
  });

  it('never special-cases a puzzles/fixtures/ path (acceptance 6)', () => {
    const source = readFileSync(fileURLToPath(new URL('../../../src/cli/fetch.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/puzzles\/fixtures/);
  });

  it('passes --series/--date/--from/--to/--limit/--path through to list()', async () => {
    const dir = tempDir();
    let seen: SourceListOptions | undefined;
    const adapter: SourceAdapter = {
      id: 'stub-flags',
      list: (opts) => {
        seen = opts;
        return Promise.resolve([ref('puzzle-one', 'ipuz')]);
      },
      download: () => Promise.resolve({ bytes: IPUZ_BYTES, ext: 'ipuz' }),
      normalise: () => Promise.reject(new Error('unused')),
    };
    registerSource(adapter);

    await fetchCommand(
      'stub-flags',
      options({
        out: dir,
        series: 'cryptic',
        date: '2026-01-01',
        from: '2026-01-01',
        to: '2026-01-31',
        limit: 5,
        path: '/some/path.zip',
      }),
      GLOBAL,
    );

    expect(seen).toEqual({
      series: 'cryptic',
      date: '2026-01-01',
      from: '2026-01-01',
      to: '2026-01-31',
      limit: 5,
      path: '/some/path.zip',
    });
  });
});
