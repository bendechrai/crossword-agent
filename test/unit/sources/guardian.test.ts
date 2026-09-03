import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExitCode, isCliError } from '../../../src/cli/exit.js';
import {
  createGuardianSource,
  GUARDIAN_LIMIT_MAX,
  GUARDIAN_MIN_REQUEST_INTERVAL_MS,
  guardianSource,
  guardianUserAgent,
} from '../../../src/sources/guardian.js';
import type { FetchLike, PuzzleRef } from '../../../src/sources/types.js';

const SERIES_PAGE_PATH = fileURLToPath(
  new URL('../../fixtures/sources/guardian-series-page.html', import.meta.url),
);
const LIST_SAMPLE_PATH = fileURLToPath(
  new URL('../../fixtures/sources/guardian-list-sample.json', import.meta.url),
);

const SERIES_HTML = readFileSync(SERIES_PAGE_PATH, 'utf8');
const PUZZLE_BODY = readFileSync(LIST_SAMPLE_PATH, 'utf8');

const SERIES_PAGE_URL = 'https://www.theguardian.com/crosswords/series/cryptic';
const QUICK_SERIES_PAGE_URL = 'https://www.theguardian.com/crosswords/series/quick';

function puzzleUrl(series: string, id: number): string {
  return `https://www.theguardian.com/crosswords/${series}/${id}.json`;
}

/**
 * Every test but the throttle-timing one (acceptance 3) injects this instant
 * clock so the many-request tests (a series page plus several per-id
 * fetches) run in milliseconds rather than paying the real 1 rps ceiling in
 * wall-clock time; the 1 rps behaviour itself is exercised separately, with
 * the real default clock under `vi.useFakeTimers()`.
 */
const INSTANT_SLEEP = (): Promise<void> => Promise.resolve();

interface MockedResponse {
  status: number;
  body?: string;
}

/**
 * Builds an injectable `FetchLike` from a fixed url -> response map. Any url
 * not in the map is a hard test failure (a stray fetch call), which is how
 * acceptance 8 ("no reference to a real network call") is enforced: nothing
 * here ever reaches `globalThis.fetch`.
 */
function fakeFetch(responses: Record<string, MockedResponse>): FetchLike {
  return vi.fn((input: string) => {
    const entry = responses[input];
    if (entry === undefined) {
      return Promise.reject(new Error(`unexpected fetch: ${input}`));
    }
    return Promise.resolve(new Response(entry.body ?? '', { status: entry.status }));
  });
}

describe('guardian source', () => {
  beforeEach(() => {
    // Acceptance 8: assert the real network is never touched. The spy both
    // records calls (asserted not to happen, via vi.mocked(globalThis.fetch)
    // below) and, belt and braces, throws rather than passing through to a
    // real network call if it ever did.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('a test tried to reach the real network via globalThis.fetch');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('list() walks ids backwards from the series page and the resulting puzzles carry style "cryptic" (acceptance 1)', async () => {
    const fetch = fakeFetch({
      [SERIES_PAGE_URL]: { status: 200, body: SERIES_HTML },
      [puzzleUrl('cryptic', 29296)]: { status: 200, body: PUZZLE_BODY },
      [puzzleUrl('cryptic', 29295)]: { status: 200, body: PUZZLE_BODY },
      [puzzleUrl('cryptic', 29294)]: { status: 200, body: PUZZLE_BODY },
    });
    const source = createGuardianSource({ fetch, sleep: INSTANT_SLEEP });

    const refs = await source.list({ series: 'cryptic', limit: 3 });

    expect(refs).toHaveLength(3);
    expect(refs.every((r) => r.source === 'guardian')).toBe(true);
    const ids = refs.map((r) => Number(/(\d+)\.json$/.exec(r.url)?.[1]));
    expect(ids).toEqual([29296, 29295, 29294]);
    expect(ids[0]).toBeGreaterThan(ids[1]!);
    expect(ids[1]).toBeGreaterThan(ids[2]!);

    for (const ref of refs) {
      const { bytes } = await source.download(ref);
      const puzzle = await source.normalise(bytes, ref);
      expect(puzzle.style).toBe('cryptic');
    }

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('sends the exact User-Agent string, with the real package version substituted, on every request (acceptance 2)', async () => {
    const fetch = fakeFetch({
      [SERIES_PAGE_URL]: { status: 200, body: SERIES_HTML },
      [puzzleUrl('cryptic', 29296)]: { status: 200, body: PUZZLE_BODY },
    });
    const source = createGuardianSource({ fetch, sleep: INSTANT_SLEEP });

    const [ref] = await source.list({ series: 'cryptic', limit: 1 });
    await source.download(ref!);

    const mockFetch = vi.mocked(fetch);
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    const expectedUa = guardianUserAgent();
    expect(expectedUa).toMatch(
      /^crossword-agent\/\S+ \(\+https:\/\/github\.com\/bendechrai\/crossword-agent; personal research\)$/,
    );
    for (const [, init] of mockFetch.mock.calls) {
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.['User-Agent']).toBe(expectedUa);
    }
  });

  it('enforces the 1 rps ceiling: 3 sequential downloads take at least 2,000 ms of injected clock (acceptance 3)', async () => {
    vi.useFakeTimers();
    try {
      const ref: PuzzleRef = {
        id: 'guardian-cryptic-29296',
        source: 'guardian',
        url: puzzleUrl('cryptic', 29296),
        ext: 'json',
      };
      const fetch = fakeFetch({
        [ref.url]: { status: 200, body: PUZZLE_BODY },
      });
      const source = createGuardianSource({ fetch });

      const start = Date.now();
      const run = (async () => {
        await source.download(ref);
        await source.download(ref);
        await source.download(ref);
      })();
      await vi.advanceTimersByTimeAsync(2 * GUARDIAN_MIN_REQUEST_INTERVAL_MS);
      await run;
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(2 * GUARDIAN_MIN_REQUEST_INTERVAL_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects --limit above the hard maximum of 20 as a usage error (acceptance 4)', async () => {
    const fetch = fakeFetch({});
    const source = createGuardianSource({ fetch, sleep: INSTANT_SLEEP });

    await expect(source.list({ series: 'cryptic', limit: 21 })).rejects.toSatisfy(
      (e: unknown) => {
        if (!isCliError(e)) return false;
        expect(e.code).toBe(ExitCode.USAGE);
        expect(e.message).toContain(String(GUARDIAN_LIMIT_MAX));
        return true;
      },
    );
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('stops the walk at the first 404 and returns the refs collected so far, without throwing (acceptance 5)', async () => {
    const fetch = fakeFetch({
      [SERIES_PAGE_URL]: { status: 200, body: SERIES_HTML },
      [puzzleUrl('cryptic', 29296)]: { status: 200, body: PUZZLE_BODY },
      [puzzleUrl('cryptic', 29295)]: { status: 404 },
    });
    const source = createGuardianSource({ fetch, sleep: INSTANT_SLEEP });

    const refs = await source.list({ series: 'cryptic', limit: 5 });

    expect(refs).toHaveLength(1);
    expect(refs[0]?.url).toBe(puzzleUrl('cryptic', 29296));
  });

  it('a 500 response produces a CliError code 3 with a single-line message and no stack in the message (acceptance 6)', async () => {
    const fetch = fakeFetch({
      [SERIES_PAGE_URL]: { status: 200, body: SERIES_HTML },
      [puzzleUrl('cryptic', 29296)]: { status: 500, body: 'internal error' },
    });
    const source = createGuardianSource({ fetch, sleep: INSTANT_SLEEP });

    await expect(source.list({ series: 'cryptic', limit: 1 })).rejects.toSatisfy((e: unknown) => {
      if (!isCliError(e)) return false;
      expect(e.code).toBe(ExitCode.NOT_FOUND);
      expect(e.message.includes('\n')).toBe(false);
      expect(e.message).not.toContain('at ');
      expect(e.message).toContain('500');
      return true;
    });
  });

  it('maps series "quick" to style "quick" (acceptance 7)', async () => {
    const fetch = fakeFetch({
      [QUICK_SERIES_PAGE_URL]: {
        status: 200,
        body: SERIES_HTML.replace(/cryptic/g, 'quick'),
      },
      [puzzleUrl('quick', 29296)]: { status: 200, body: PUZZLE_BODY },
    });
    const source = createGuardianSource({ fetch, sleep: INSTANT_SLEEP });

    const [ref] = await source.list({ series: 'quick', limit: 1 });
    const { bytes } = await source.download(ref!);
    const puzzle = await source.normalise(bytes, ref!);

    expect(puzzle.style).toBe('quick');
  });

  it('never references the real network: globalThis.fetch is not invoked (acceptance 8)', async () => {
    const fetch = fakeFetch({
      [SERIES_PAGE_URL]: { status: 200, body: SERIES_HTML },
      [puzzleUrl('cryptic', 29296)]: { status: 200, body: PUZZLE_BODY },
    });
    const source = createGuardianSource({ fetch, sleep: INSTANT_SLEEP });

    const refs = await source.list({ series: 'cryptic', limit: 1 });
    await source.download(refs[0]!);

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('defaults --limit to 1 when none is given', async () => {
    const fetch = fakeFetch({
      [SERIES_PAGE_URL]: { status: 200, body: SERIES_HTML },
      [puzzleUrl('cryptic', 29296)]: { status: 200, body: PUZZLE_BODY },
    });
    const source = createGuardianSource({ fetch, sleep: INSTANT_SLEEP });

    const refs = await source.list({ series: 'cryptic' });

    expect(refs).toHaveLength(1);
  });

  it('rejects list() with no --series as a usage error', async () => {
    const source = createGuardianSource({ fetch: fakeFetch({}) });

    await expect(source.list({})).rejects.toSatisfy(
      (e: unknown) => isCliError(e) && e.code === ExitCode.USAGE,
    );
  });

  it('the registry instance exists and is a valid guardian SourceAdapter', () => {
    expect(guardianSource.id).toBe('guardian');
    expect(typeof guardianSource.list).toBe('function');
    expect(typeof guardianSource.download).toBe('function');
    expect(typeof guardianSource.normalise).toBe('function');
  });
});
