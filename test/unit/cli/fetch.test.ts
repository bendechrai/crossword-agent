import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExitCode, isCliError } from '../../../src/cli/exit.js';
import { fetchCommand } from '../../../src/cli/fetch.js';
import type { FetchOptions, GlobalOptions } from '../../../src/cli/options.js';
import { readIndex } from '../../../src/puzzle/library.js';
import type { PuzzleExt } from '../../../src/puzzle/types.js';
import { createGuardianSource } from '../../../src/sources/guardian.js';
import { registerSource, resetSources } from '../../../src/sources/registry.js';
import type { FetchLike, PuzzleRef, SourceAdapter, SourceListOptions } from '../../../src/sources/types.js';
import { createXdSource } from '../../../src/sources/xd.js';

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

/**
 * T60: `xw fetch` derives `style` (and passes through `date`) from the
 * source's own ref rather than always landing on `unknown`, for the two
 * source adapters registered so far. These tests exercise the *real*
 * `createGuardianSource`/`createXdSource` adapters (not the hand-rolled
 * stub above, whose `list`/`download` bypass ref-shape questions entirely),
 * with `fetch` injected so nothing reaches the network (per the guardian
 * source's own test suite convention).
 */
describe('fetchCommand: style/date passthrough from real source refs (T60)', () => {
  interface MockedResponse {
    status: number;
    body?: string;
  }

  function fakeFetch(responses: Record<string, MockedResponse>): FetchLike {
    return vi.fn((input: string) => {
      const entry = responses[input];
      if (entry === undefined) {
        return Promise.reject(new Error(`unexpected fetch: ${input}`));
      }
      return Promise.resolve(new Response(entry.body ?? '', { status: entry.status }));
    });
  }

  function guardianPuzzleUrl(series: string, id: number): string {
    return `https://www.theguardian.com/crosswords/${series}/${String(id)}.json`;
  }

  function guardianSeriesPageUrl(series: string): string {
    return `https://www.theguardian.com/crosswords/series/${series}`;
  }

  /** A minimal series page: one anchor naming `id` as the latest puzzle. */
  function guardianSeriesHtml(series: string, id: number): string {
    return `<a href="/crosswords/${series}/${String(id)}">Crossword No ${String(id)}</a>`;
  }

  const GUARDIAN_PAYLOAD = readFixtureBytes('sources/guardian-list-sample.json').toString('utf8');
  const INSTANT_SLEEP = (): Promise<void> => Promise.resolve();

  beforeEach(() => {
    // Belt and braces, matching src/sources/guardian.ts's own test suite:
    // every test below injects `fetch` explicitly, so this should never
    // fire, but it turns a silent fallthrough to the real network into a
    // hard failure if it ever did.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('a test tried to reach the real network via globalThis.fetch');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSources();
  });

  it('a Guardian cryptic-series fetch normalises to style cryptic (acceptance 1)', async () => {
    const dir = tempDir();
    const fetch = fakeFetch({
      [guardianSeriesPageUrl('cryptic')]: { status: 200, body: guardianSeriesHtml('cryptic', 30100) },
      [guardianPuzzleUrl('cryptic', 30100)]: { status: 200, body: GUARDIAN_PAYLOAD },
    });
    registerSource(createGuardianSource({ fetch, now: () => 0, sleep: INSTANT_SLEEP }));

    await fetchCommand('guardian', options({ out: dir, series: 'cryptic', limit: 1 }), GLOBAL);

    const rows = await readIndex({ puzzlesDir: dir });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('guardian-cryptic-30100');
    expect(rows[0]?.style).toBe('cryptic');
    // src/sources/guardian.ts's list() attaches no `date` to the refs it
    // returns (no per-puzzle date signal exists in v1) - the date
    // passthrough this task adds must not invent one, so it stays absent,
    // exactly as it was before this fix.
    expect(rows[0]?.date).toBeNull();

    const normalisedPath = join(dir, 'guardian', 'guardian-cryptic-30100.json');
    const written = JSON.parse(readFileSync(normalisedPath, 'utf8')) as { style?: string; date?: string };
    expect(written.style).toBe('cryptic');
    expect(written.date).toBeUndefined();
  });

  it('a Guardian quick-series fetch normalises to the mapped style quick (acceptance 2)', async () => {
    const dir = tempDir();
    const fetch = fakeFetch({
      [guardianSeriesPageUrl('quick')]: { status: 200, body: guardianSeriesHtml('quick', 15900) },
      [guardianPuzzleUrl('quick', 15900)]: { status: 200, body: GUARDIAN_PAYLOAD },
    });
    registerSource(createGuardianSource({ fetch, now: () => 0, sleep: INSTANT_SLEEP }));

    await fetchCommand('guardian', options({ out: dir, series: 'quick', limit: 1 }), GLOBAL);

    const rows = await readIndex({ puzzlesDir: dir });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('guardian-quick-15900');
    expect(rows[0]?.style).toBe('quick');
  });

  it('the xd path still yields style american and the date from the path (acceptance 3)', async () => {
    const dir = tempDir();
    // A self-contained, fully-clued `.xd` fixture written to its own temp
    // corpus dir, rather than reusing test/fixtures/sources/xd-mini/ (T27):
    // that fixture's grid has an unclued down run (no clue names the number
    // the numbering check computes for it), which is fine for T27's own
    // list()-only tests but fails the full round-trip through the real
    // xd-hand adapter this test exercises. Same grid as
    // test/fixtures/puzzles/synthetic-5x5.xd (T0), which every clue,
    // including the one xd-mini omits.
    const xdCorpusDir = tempDir();
    const xdText = [
      'Title: T60 xd style test',
      'Date: 1963-05-01',
      '',
      'OH#PI',
      'RAYON',
      'AVOID',
      'LOUSE',
      '#C#EX',
      '',
      'A1. Cry of surprise ~ OH',
      'A3. Greek letter of a famous ratio ~ PI',
      'A5. Synthetic silk-like fabric ~ RAYON',
      'A7. Steer clear of ~ AVOID',
      'A8. Small parasitic insect ~ LOUSE',
      'A9. Former partner ~ EX',
      '',
      'D1. Spoken rather than written ~ ORAL',
      'D2. Chaos and destruction ~ HAVOC',
      'D3. Calm self-assurance ~ POISE',
      'D4. Alphabetical list at the back of a book ~ INDEX',
      'D6. The person being addressed ~ YOU',
      '',
    ].join('\n');
    writeFileSync(join(xdCorpusDir, '1963-05-01-old-puzzle.xd'), xdText, 'utf8');
    registerSource(createXdSource({ path: xdCorpusDir }));

    await fetchCommand('xd', options({ out: dir, limit: 1 }), GLOBAL);

    const rows = await readIndex({ puzzlesDir: dir });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.style).toBe('american');
    expect(rows[0]?.date).toBe('1963-05-01');
  });
});
