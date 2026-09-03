import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { repoRoot } from '../../../src/util/fs.js';
import { log } from '../../../src/util/log.js';
import {
  downloadWordList,
  openWordList,
  parseWordList,
  WORDLIST_SOURCE_URL,
} from '../../../src/validate/wordlist.js';

const THIS_FILE = fileURLToPath(new URL(import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL('../../fixtures/wordlist.txt', import.meta.url));

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crossword-wordlist-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('openWordList against the committed fixture', () => {
  const list = openWordList(FIXTURE_PATH);

  it('reports loaded: true', () => {
    expect(list.loaded).toBe(true);
  });

  it('has("ALIEN") is true and has("ZZZZZ") is false (acceptance 1)', () => {
    expect(list.has('ALIEN')).toBe(true);
    expect(list.has('ZZZZZ')).toBe(false);
  });

  it('normalises the lookup word first, so a lowercase or accented spelling still resolves (B35 decision: has("FIANCEE") works)', () => {
    expect(list.has('FIANCEE')).toBe(true);
    expect(list.has('fiancee')).toBe(true);
    // é is accented e (fiancée); NFD-decompose + strip combining
    // marks (T6's normaliseAnswer, reused here) reduces it to plain FIANCEE.
    expect(list.has('fiancée')).toBe(true);
  });

  it('score is in [0,1], and the higher-scored of two fixture words compares greater (acceptance 2)', () => {
    // Fixture: ALIEN;90 -> 0.9, FIANCE;50 -> 0.5.
    const alien = list.score('ALIEN');
    const fiance = list.score('FIANCE');
    expect(alien).toBeGreaterThanOrEqual(0);
    expect(alien).toBeLessThanOrEqual(1);
    expect(alien).toBeCloseTo(0.9, 6);
    expect(fiance).toBeCloseTo(0.5, 6);
    expect(alien).toBeGreaterThan(fiance);
  });

  it('score is 0 for a word absent from the list', () => {
    expect(list.score('ZZZZZ')).toBe(0);
  });

  it('match("A?I?N", 10) returns only matching words, at most 10, sorted by descending score (acceptance 3)', () => {
    // The fixture deliberately carries 17 five-letter A?I?N matches (see its
    // header comment) spanning four score tiers, so the cap and the sort
    // both get exercised in one call.
    const matches = list.match('A?I?N', 10);

    expect(matches).toHaveLength(10);
    for (const word of matches) {
      expect(word).toMatch(/^A[A-Z]I[A-Z]N$/);
    }
    const scores = matches.map((w) => list.score(w));
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1] as number);
    }
    // Exact order: descending score, ties broken by the fixture's
    // alphabetical file order (a stable sort over an alphabetically-loaded
    // map preserves it) - pinned here so a regression in either the sort or
    // the tie-break shows up as a concrete diff.
    expect(matches).toEqual([
      'ALIEN',
      'ALIGN',
      'ASIAN',
      'AVIAN',
      'ANION',
      'AMIIN',
      'AMIEN',
      'AMION',
      'ARIAN',
      'ASIGN',
    ]);
  });

  it('a limit smaller than the match count still returns only the top-scored words', () => {
    const matches = list.match('A?I?N', 3);
    expect(matches).toEqual(['ALIEN', 'ALIGN', 'ASIAN']);
  });

  it('match on a length with no fixture entries returns [] (acceptance 4)', () => {
    // The fixture's header records that every 2-letter entry was deliberately
    // excluded so this length has no hits.
    expect(list.match('??', 10)).toEqual([]);
  });

  it('match on a pattern with no matches at a present length also returns []', () => {
    expect(list.match('ZZ?ZZ', 10)).toEqual([]);
  });

  it('a limit of 0 (or negative) returns [] without consulting the index', () => {
    expect(list.match('A?I?N', 0)).toEqual([]);
    expect(list.match('A?I?N', -1)).toEqual([]);
  });
});

describe('openWordList: the null object when the file is absent', () => {
  it('returns false/0/[] for everything and logs exactly one warning across 100 calls (acceptance 5)', () => {
    const missingPath = join(tempDir(), 'does-not-exist.txt');
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const list = openWordList(missingPath);
    expect(list.loaded).toBe(false);

    for (let i = 0; i < 100; i += 1) {
      expect(list.has('ALIEN')).toBe(false);
      expect(list.score('ALIEN')).toBe(0);
      expect(list.match('A?I?N', 10)).toEqual([]);
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('warns only once even across several openWordList calls for the same missing path', () => {
    const missingPath = join(tempDir(), 'still-missing.txt');
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

    openWordList(missingPath);
    openWordList(missingPath);
    openWordList(missingPath);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('falls back to the null object with no path argument when the default data/wordlist file is absent', () => {
    const defaultPath = join(repoRoot(), 'data/wordlist/collaborative.txt');
    // data/ is gitignored; a prior local `npm run wordlist:fetch` could
    // leave a real file there, so this assertion only applies when it does
    // not (the repository state every fresh checkout and preflight starts
    // from).
    if (existsSync(defaultPath)) return;

    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const list = openWordList();
    expect(list.loaded).toBe(false);
    warnSpy.mockRestore();
  });
});

describe('parseWordList', () => {
  it('skips a line with a malformed score and counts it in `skipped` (acceptance 6)', () => {
    const text = [
      'GOOD;80',
      'BADSCORE;notanumber',
      'TOOHIGH;150',
      'NEGATIVE;-5',
      'ALSOFINE;10',
    ].join('\n');

    const { entries, skipped } = parseWordList(text);

    expect(entries.get('GOOD')).toBeCloseTo(0.8, 6);
    expect(entries.get('ALSOFINE')).toBeCloseTo(0.1, 6);
    expect(entries.has('BADSCORE')).toBe(false);
    expect(entries.has('TOOHIGH')).toBe(false);
    expect(entries.has('NEGATIVE')).toBe(false);
    expect(skipped).toBe(3);
  });

  it('skips a line with no ";" separator and counts it', () => {
    const { entries, skipped } = parseWordList('GOOD;80\nNOSEPARATOR\n');
    expect(entries.has('GOOD')).toBe(true);
    expect(skipped).toBe(1);
  });

  it('skips a line whose word normalises to nothing or non-letters and counts it', () => {
    const { entries, skipped } = parseWordList('GOOD;80\n123;50\n;90\n');
    expect(entries.size).toBe(1);
    expect(skipped).toBe(2);
  });

  it('ignores blank lines and "#" comment lines without counting them as skipped', () => {
    const text = '# provenance header\n\nWORD;50\n   \n# another comment\nOTHER;10\n';
    const { entries, skipped } = parseWordList(text);
    expect(entries.get('WORD')).toBeCloseTo(0.5, 6);
    expect(entries.get('OTHER')).toBeCloseTo(0.1, 6);
    expect(skipped).toBe(0);
  });

  it('normalises the word half the same way T6 normalises candidate answers (accents, case)', () => {
    const { entries } = parseWordList('fiancée;90\n');
    expect(entries.get('FIANCEE')).toBeCloseTo(0.9, 6);
  });

  it('keeps the higher score when the same normalised word appears twice', () => {
    const { entries } = parseWordList('ALIEN;40\nALIEN;90\n');
    expect(entries.get('ALIEN')).toBeCloseTo(0.9, 6);
  });
});

describe('downloadWordList (the injectable network logic scripts/wordlist-fetch.ts wraps)', () => {
  beforeEach(() => {
    // Belt and braces, matching the sources/guardian.test.ts convention:
    // every call in this describe block passes its own `fetch` explicitly,
    // so the real network should never be reached even by a mistake.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('a test tried to reach the real network via globalThis.fetch');
    });
  });

  it('fetches WORDLIST_SOURCE_URL, writes the body to targetPath, and reports its byte length', async () => {
    const dir = tempDir();
    const targetPath = join(dir, 'collaborative.txt');
    const body = 'ALIEN;90\nFIANCEE;90\n';
    const fetchImpl = vi.fn((input: unknown) => {
      expect(String(input)).toBe(WORDLIST_SOURCE_URL);
      return Promise.resolve(new Response(body, { status: 200 }));
    });

    const result = await downloadWordList({
      targetPath,
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ path: targetPath, bytes: Buffer.byteLength(body, 'utf8') });
    expect(existsSync(targetPath)).toBe(true);
    expect(readFileSync(targetPath, 'utf8')).toBe(body);
  });

  it('respects an overridden url', async () => {
    const dir = tempDir();
    const targetPath = join(dir, 'collaborative.txt');
    const customUrl = 'https://example.invalid/custom-wordlist.dict';
    const fetchImpl = vi.fn((input: unknown) => {
      expect(String(input)).toBe(customUrl);
      return Promise.resolve(new Response('X;1\n', { status: 200 }));
    });

    await downloadWordList({
      url: customUrl,
      targetPath,
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws on a non-ok response and never writes a file', async () => {
    const dir = tempDir();
    const targetPath = join(dir, 'collaborative.txt');
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('server error', { status: 500 })));

    await expect(
      downloadWordList({ targetPath, fetch: fetchImpl as unknown as typeof globalThis.fetch }),
    ).rejects.toThrow(/download failed/);
    expect(existsSync(targetPath)).toBe(false);
  });
});

describe('scripts/wordlist-fetch.ts is never imported by a test (acceptance 7)', () => {
  it('no test file references the wordlist-fetch script module', () => {
    const testRoot = fileURLToPath(new URL('../../', import.meta.url));
    // An import-like reference: `from '...wordlist-fetch(.js|.ts)?'` or a
    // dynamic `import('...wordlist-fetch(.js|.ts)?')`. This file's own
    // prose (this describe block's title, these comments) mentions the
    // script by name without ever importing it, and is excluded from the
    // scan below so it cannot flag itself.
    const IMPORT_LIKE_RE =
      /(?:from\s+['"][^'"]*wordlist-fetch(?:\.[jt]s)?['"]|import\(\s*['"][^'"]*wordlist-fetch(?:\.[jt]s)?['"]\s*\))/;

    const offenders: string[] = [];
    function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.test.ts') || full === THIS_FILE) continue;
        const text = readFileSync(full, 'utf8');
        if (IMPORT_LIKE_RE.test(text)) offenders.push(full);
      }
    }
    walk(testRoot);

    expect(offenders).toEqual([]);
  });
});
