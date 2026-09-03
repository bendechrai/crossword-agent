import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { notFoundError, usageError } from '../cli/exit.js';
import { parseGuardianPayload } from '../puzzle/adapters/guardian.js';
import type { PuzzleAdapterContext } from '../puzzle/adapters/index.js';
import type { PuzzleStyle, PuzzleWithSolution } from '../puzzle/types.js';
import { repoRoot } from '../util/fs.js';
import type {
  FetchLike,
  PuzzleRef,
  SourceAdapter,
  SourceDownload,
  SourceListOptions,
} from './types.js';

export interface GuardianSourceOptions {
  /** Injected so tests stay offline. */
  fetch?: FetchLike;
  /**
   * Injectable clock for the 1 rps ceiling (A2 decision: "an injectable
   * clock, independent of llm/rateLimiter"). Default is the real
   * `Date.now`/`setTimeout`; most tests inject an instant `sleep` so the
   * many-request tests do not each cost a second of wall-clock time, while
   * the throttle-timing test (acceptance 3) uses the real default under
   * `vi.useFakeTimers()`.
   */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Hard maximum for `--limit` on this source; above it is a usage error (A2). */
export const GUARDIAN_LIMIT_MAX = 20;

/** One request per second, independent of any other rate limiting (A2). */
export const GUARDIAN_MIN_REQUEST_INTERVAL_MS = 1000;

/** `--limit` defaults to 1 when the caller does not supply one (A2). */
export const GUARDIAN_DEFAULT_LIMIT = 1;

/**
 * Series -> style (spec: "Puzzle library and sources", `guardian` bullet).
 * Lives here, not in the puzzle adapter (T26), because only the source knows
 * which series a puzzle came from.
 */
const SERIES_STYLE: Readonly<Record<string, PuzzleStyle>> = {
  cryptic: 'cryptic',
  prize: 'cryptic',
  quiptic: 'cryptic',
  everyman: 'cryptic',
  weekend: 'cryptic',
  quick: 'quick',
  speedy: 'quick',
};

function styleForSeries(series: string): PuzzleStyle {
  return SERIES_STYLE[series] ?? 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Read once (A2 decision), not per request: the version never changes
 * within a process, and `package.json` is small.
 */
function readPackageVersion(): string {
  try {
    const path = join(repoRoot(), 'package.json');
    const pkg: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (isRecord(pkg) && typeof pkg['version'] === 'string') return pkg['version'];
  } catch {
    // Fall through to the placeholder below; a missing/unreadable
    // package.json should never crash the adapter over a header string.
  }
  return '0.0.0';
}

const PACKAGE_VERSION = readPackageVersion();

/** A2: descriptive User-Agent naming the project, its repo and its purpose. */
export function guardianUserAgent(version = PACKAGE_VERSION): string {
  return `crossword-agent/${version} (+https://github.com/bendechrai/crossword-agent; personal research)`;
}

function seriesPageUrl(series: string): string {
  return `https://www.theguardian.com/crosswords/series/${series}`;
}

function puzzleUrl(series: string, id: number): string {
  return `https://www.theguardian.com/crosswords/${series}/${id}.json`;
}

/**
 * Finds the highest puzzle id linked from a Guardian series page. The page
 * itself is not modelled beyond this: any anchor whose href matches
 * `/crosswords/<series>/<digits>` counts, and the largest digit run wins,
 * which is robust to the page's actual listing order.
 */
function latestIdFromSeriesPage(html: string, series: string): number | undefined {
  const escapedSeries = series.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`/crosswords/${escapedSeries}/(\\d+)`, 'g');
  let max: number | undefined;
  for (const match of html.matchAll(re)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && (max === undefined || value > max)) max = value;
  }
  return max;
}

/** A2: series -> style comes from the ref's own URL, so `normalise` needs no extra state. */
function seriesFromPuzzleUrl(url: string): string | undefined {
  const match = /\/crosswords\/([^/]+)\/\d+\.json$/.exec(url);
  return match?.[1];
}

function hasGuardianShape(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value['crossword'])) return false;
  return Array.isArray(value['crossword']['entries']);
}

interface ProbeResult {
  found: boolean;
  bodyText?: string;
}

/**
 * T28: the `guardian` `SourceAdapter`. `list` finds the latest id on the
 * series page and walks ids backwards, stopping at the first 404 or at
 * `limit`; `download` re-fetches a puzzle's JSON by ref; `normalise` hands
 * the bytes to `parseGuardianPayload` (T26) with the style recovered from
 * the ref's URL. Every request - the series page and every per-id probe or
 * download - goes through the same 1 rps gate (A2), independent of
 * `llm/rateLimiter`, which throttles model calls, not sources.
 */
export function createGuardianSource(opts: GuardianSourceOptions = {}): SourceAdapter {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const userAgent = guardianUserAgent();

  // A2: a hard 1 rps ceiling, enforced here with the injectable clock above.
  let nextAllowedAtMs = 0;

  async function throttle(): Promise<void> {
    const current = now();
    const waitMs = nextAllowedAtMs - current;
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    nextAllowedAtMs = Math.max(current, nextAllowedAtMs) + GUARDIAN_MIN_REQUEST_INTERVAL_MS;
  }

  async function gatedGet(url: string): Promise<Response> {
    await throttle();
    return fetchImpl(url, { headers: { 'User-Agent': userAgent } });
  }

  async function fetchSeriesPage(series: string): Promise<string> {
    const url = seriesPageUrl(series);
    const res = await gatedGet(url);
    if (!res.ok) {
      throw notFoundError(`guardian series page request failed: HTTP ${res.status} for ${url}`);
    }
    return res.text();
  }

  /**
   * Fetches one candidate id's JSON. A 404 is reported (not thrown) so the
   * backward walk can stop cleanly; any other non-ok status, or a body that
   * is not the expected JSON shape, is a `CliError` (A2 decision: "never a
   * stack trace").
   */
  async function probeId(series: string, id: number): Promise<ProbeResult> {
    const url = puzzleUrl(series, id);
    const res = await gatedGet(url);
    if (res.status === 404) return { found: false };
    if (!res.ok) {
      throw notFoundError(`guardian puzzle request failed: HTTP ${res.status} for ${url}`);
    }
    const bodyText = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw notFoundError(`guardian puzzle response for ${url} is not valid JSON`);
    }
    if (!hasGuardianShape(parsed)) {
      throw notFoundError(`guardian puzzle response for ${url} is not the expected JSON shape`);
    }
    return { found: true, bodyText };
  }

  async function list(listOpts: SourceListOptions): Promise<PuzzleRef[]> {
    const series = listOpts.series;
    if (series === undefined || series.length === 0) {
      throw usageError('the guardian source needs a --series (e.g. cryptic, quick, prize)');
    }

    const limit = listOpts.limit ?? GUARDIAN_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) {
      throw usageError(`--limit must be a positive integer, got ${JSON.stringify(listOpts.limit)}`);
    }
    if (limit > GUARDIAN_LIMIT_MAX) {
      throw usageError(
        `--limit ${limit} exceeds the guardian source's maximum of ${GUARDIAN_LIMIT_MAX} ` +
          '(A2: personal-research volumes only)',
      );
    }

    const html = await fetchSeriesPage(series);
    const latest = latestIdFromSeriesPage(html, series);
    if (latest === undefined) {
      throw notFoundError(`no puzzle ids found on the guardian "${series}" series page`);
    }

    const refs: PuzzleRef[] = [];
    for (let id = latest; id >= 1 && refs.length < limit; id--) {
      const probe = await probeId(series, id);
      if (!probe.found) break;
      refs.push({
        id: `guardian-${series}-${id}`,
        source: 'guardian',
        url: puzzleUrl(series, id),
        ext: 'json',
      });
    }
    return refs;
  }

  async function download(ref: PuzzleRef): Promise<SourceDownload> {
    const res = await gatedGet(ref.url);
    if (!res.ok) {
      throw notFoundError(`guardian puzzle request failed: HTTP ${res.status} for ${ref.url}`);
    }
    const text = await res.text();
    return { bytes: Buffer.from(text, 'utf8'), ext: ref.ext };
  }

  function normalise(bytes: Buffer, ref: PuzzleRef): Promise<PuzzleWithSolution> {
    const series = seriesFromPuzzleUrl(ref.url);
    const style = series === undefined ? 'unknown' : styleForSeries(series);
    const payload: unknown = JSON.parse(bytes.toString('utf8'));
    const ctx: PuzzleAdapterContext = {
      id: ref.id,
      source: ref.source,
      origin: ref.url,
      ...(ref.date !== undefined ? { date: ref.date } : {}),
      ...(ref.title !== undefined ? { title: ref.title } : {}),
    };
    return Promise.resolve(parseGuardianPayload(payload, ctx, { style }));
  }

  return { id: 'guardian', list, download, normalise };
}

/** The instance the registry holds. */
export const guardianSource: SourceAdapter = createGuardianSource();
