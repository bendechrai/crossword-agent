import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { regexFromPattern } from '../grid/pattern.js';
import { atomicWriteFile, repoRoot } from '../util/fs.js';
import { warnOnce } from '../util/log.js';
import { normaliseAnswer } from './normalise.js';
import type { WordList } from './types.js';

/**
 * T43 (B35). Loads `data/wordlist/collaborative.txt` in `word;score` form.
 * When the file is absent this returns a null object - `has` always false,
 * `score` always 0, `match` always empty - which disables the repair word-list
 * gate and leaves empty slots blank, with a one-time warning.
 */

const CHARSET_RE = /^[A-Z]+$/;

export interface ParsedWordList {
  /** Normalised `A-Z` word -> score in `[0,1]`. Later duplicate lines for the
   * same word keep the higher score. */
  entries: Map<string, number>;
  /** Count of lines that failed to parse: bad charset, missing `;`, or a
   * score that is not an integer in `[0,100]`. */
  skipped: number;
}

/**
 * Parses the `word;score` text form (score: an integer `0`-`100`, normalised
 * here to `[0,1]` - decision: "scores are the list's own 0-100 integers
 * normalised to [0,1]"). Blank lines and lines starting with `#` (the
 * fixture's provenance header) are ignored and not counted as skipped. The
 * word half is run through T6's `normaliseAnswer` so load-time and
 * lookup-time normalisation can never disagree (decision).
 *
 * Exported (beyond the `WordList` interface T43 owns no other public shape
 * for) so the malformed-score acceptance case can be asserted directly
 * against the `skipped` count without threading it through the null object.
 */
export function parseWordList(text: string): ParsedWordList {
  const entries = new Map<string, number>();
  let skipped = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const sep = line.indexOf(';');
    if (sep === -1) {
      skipped += 1;
      continue;
    }

    const word = normaliseAnswer(line.slice(0, sep));
    if (!CHARSET_RE.test(word)) {
      skipped += 1;
      continue;
    }

    const rawScore = line.slice(sep + 1).trim();
    if (!/^\d+$/.test(rawScore)) {
      skipped += 1;
      continue;
    }
    const scoreInt = Number.parseInt(rawScore, 10);
    if (scoreInt > 100) {
      skipped += 1;
      continue;
    }

    const normalisedScore = scoreInt / 100;
    const existing = entries.get(word);
    if (existing === undefined || normalisedScore > existing) {
      entries.set(word, normalisedScore);
    }
  }

  return { entries, skipped };
}

/** `has`/`score`/`match` all false/0/empty; `loaded: false` lets callers warn once and disable their gates. */
const NULL_WORD_LIST: WordList = Object.freeze({
  loaded: false,
  has: () => false,
  score: () => 0,
  match: () => [],
});

class LoadedWordList implements WordList {
  readonly loaded = true;
  private readonly scores: ReadonlyMap<string, number>;
  /** Words bucketed by length, each bucket sorted by descending score once
   * at load (decision: "the index is built once at load"), so `match` is a
   * single forward scan per call rather than a sort. */
  private readonly byLength: ReadonlyMap<number, readonly string[]>;

  constructor(scores: ReadonlyMap<string, number>) {
    this.scores = scores;
    const byLength = new Map<number, string[]>();
    for (const word of scores.keys()) {
      const bucket = byLength.get(word.length);
      if (bucket === undefined) {
        byLength.set(word.length, [word]);
      } else {
        bucket.push(word);
      }
    }
    for (const bucket of byLength.values()) {
      bucket.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
    }
    this.byLength = byLength;
  }

  has(w: string): boolean {
    return this.scores.has(normaliseAnswer(w));
  }

  score(w: string): number {
    return this.scores.get(normaliseAnswer(w)) ?? 0;
  }

  match(pattern: string, limit: number): string[] {
    if (limit <= 0) return [];
    const bucket = this.byLength.get(pattern.length);
    if (bucket === undefined) return [];
    const re = regexFromPattern(pattern);
    const out: string[] = [];
    for (const word of bucket) {
      if (re.test(word)) {
        out.push(word);
        if (out.length >= limit) break;
      }
    }
    return out;
  }
}

function defaultWordListPath(): string {
  return join(repoRoot(), 'data/wordlist/collaborative.txt');
}

export function openWordList(path?: string): WordList {
  const resolvedPath = path ?? defaultWordListPath();

  if (!existsSync(resolvedPath)) {
    warnOnce(
      `wordlist-missing:${resolvedPath}`,
      `word list not found at ${resolvedPath}; run "npm run wordlist:fetch" or pass a fixture path - word-list gates are disabled until then`,
    );
    return NULL_WORD_LIST;
  }

  const text = readFileSync(resolvedPath, 'utf8');
  const { entries } = parseWordList(text);
  return new LoadedWordList(entries);
}

/**
 * Where `npm run wordlist:fetch` downloads from by default: the Crossword
 * Nexus collaborative word list (MIT), `word;score` form, one entry per line.
 */
export const WORDLIST_SOURCE_URL =
  'https://raw.githubusercontent.com/Crossword-Nexus/collaborative-word-list/main/xwordlist.dict';

export interface DownloadWordListOptions {
  url?: string;
  /** Defaults to `data/wordlist/collaborative.txt` under the repo root. */
  targetPath?: string;
  fetch?: typeof globalThis.fetch;
}

export interface DownloadWordListResult {
  path: string;
  bytes: number;
}

/**
 * The downloader `scripts/wordlist-fetch.ts` calls. Lives here rather than in
 * the script itself so it can take an injected `fetch` and be exercised by a
 * unit test without the script module - the only thing in this task that
 * touches the network - ever being imported by a test (acceptance 7).
 */
export async function downloadWordList(
  opts: DownloadWordListOptions = {},
): Promise<DownloadWordListResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const url = opts.url ?? WORDLIST_SOURCE_URL;
  const targetPath = opts.targetPath ?? defaultWordListPath();

  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`word list download failed: HTTP ${String(res.status)} for ${url}`);
  }
  const text = await res.text();
  await atomicWriteFile(targetPath, text);
  return { path: targetPath, bytes: Buffer.byteLength(text, 'utf8') };
}
