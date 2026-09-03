import AdmZip from 'adm-zip';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ExitCode, isCliError } from '../../../src/cli/exit.js';
import { XD_DEFAULT_PATH, createXdSource } from '../../../src/sources/xd.js';
import type { PuzzleRef } from '../../../src/sources/types.js';

const DIR_PATH = 'test/fixtures/sources/xd-mini';
const ZIP_PATH = 'test/fixtures/sources/xd-mini.zip';

const OLD_FILE = join(DIR_PATH, '1963-05-01-old-puzzle.xd');
const NEWER_FILE = join(DIR_PATH, '1998-11-12-newer-puzzle.xd');

/** Strips `url` (which legitimately differs between the directory and zip cases) for comparison. */
function withoutUrl(refs: PuzzleRef[]): Array<Omit<PuzzleRef, 'url'>> {
  return refs.map(({ url: _url, ...rest }) => rest);
}

describe.each([
  ['directory', DIR_PATH],
  ['zip', ZIP_PATH],
])('xd source: list against a %s (T27 acceptance 1, 4)', (_label, path) => {
  it('returns 2 refs with source "xd" and ids prefixed "xd-" (acceptance 1)', async () => {
    const source = createXdSource();
    const refs = await source.list({ path, limit: 2 });
    expect(refs).toHaveLength(2);
    for (const ref of refs) {
      expect(ref.source).toBe('xd');
      expect(ref.id).toMatch(/^xd-/);
    }
  });

  it('filters to only the fixture entry within an inclusive date range (acceptance 4)', async () => {
    const source = createXdSource();
    const refs = await source.list({ path, from: '1963-01-01', to: '1963-12-31', limit: 10 });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ id: 'xd-1963-05-01-old-puzzle', date: '1963-05-01' });
  });

  it('defaults limit to 1', async () => {
    const source = createXdSource();
    const refs = await source.list({ path });
    expect(refs).toHaveLength(1);
  });
});

describe('xd source: directory and zip agree (acceptance 2)', () => {
  it('produce identical refs (aside from url) for the same corpus', async () => {
    const source = createXdSource();
    const dirRefs = await source.list({ path: DIR_PATH, limit: 10 });
    const zipRefs = await source.list({ path: ZIP_PATH, limit: 10 });
    expect(withoutUrl(zipRefs)).toEqual(withoutUrl(dirRefs));
  });
});

describe('xd source: download (acceptance 3)', () => {
  it('returns bytes byte-identical to the file on disk for the directory case', async () => {
    const source = createXdSource();
    const [ref] = await source.list({ path: DIR_PATH, from: '1963-01-01', to: '1963-12-31' });
    const result = await source.download(ref as PuzzleRef);
    const expected = readFileSync(OLD_FILE);
    expect(Buffer.compare(result.bytes, expected)).toBe(0);
    expect(result.ext).toBe('xd');
  });

  it('returns bytes byte-identical to the zip entry for the zip case', async () => {
    const source = createXdSource();
    const [ref] = await source.list({ path: ZIP_PATH, from: '1963-01-01', to: '1963-12-31' });
    const result = await source.download(ref as PuzzleRef);
    const expected = readFileSync(OLD_FILE);
    expect(Buffer.compare(result.bytes, expected)).toBe(0);
    expect(result.ext).toBe('xd');
  });

  it('reads zip entries lazily by name, not by expanding the whole archive to disk', async () => {
    const source = createXdSource();
    const [ref] = await source.list({ path: ZIP_PATH, from: '1998-01-01', to: '1998-12-31' });
    const result = await source.download(ref as PuzzleRef);
    const expected = readFileSync(NEWER_FILE);
    expect(Buffer.compare(result.bytes, expected)).toBe(0);
  });
});

describe('xd source: missing corpus (acceptance 5)', () => {
  it('a nonexistent --path produces a CliError code 3 naming the default path', async () => {
    const source = createXdSource();
    await expect(
      source.list({ path: 'test/fixtures/sources/does-not-exist-xd-corpus' }),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isCliError(e)) return false;
      expect(e.code).toBe(ExitCode.NOT_FOUND);
      expect(e.message).toContain(XD_DEFAULT_PATH);
      return true;
    });
  });
});

describe('xd source: zip with no .xd entries (acceptance 6)', () => {
  let tmpDir: string;
  let readmeOnlyZip: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'xd-source-test-'));
    readmeOnlyZip = join(tmpDir, 'readme-only.zip');
    const zip = new AdmZip();
    zip.addFile('README.md', Buffer.from('This corpus has no puzzles, just a README.\n'));
    zip.writeZip(readmeOnlyZip);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces a CliError code 3', async () => {
    const source = createXdSource();
    await expect(source.list({ path: readmeOnlyZip })).rejects.toSatisfy(
      (e: unknown) => isCliError(e) && e.code === ExitCode.NOT_FOUND,
    );
  });
});

describe('xd source: normalise', () => {
  it('rejects, pointing at src/puzzle/loader.ts', async () => {
    const source = createXdSource();
    await expect(
      source.normalise(Buffer.from(''), {
        id: 'xd-x',
        source: 'xd',
        url: 'x',
        ext: 'xd',
      }),
    ).rejects.toThrow(/puzzle\/loader\.ts/);
  });
});

describe('xd source: id', () => {
  it('is registered as "xd"', () => {
    expect(createXdSource().id).toBe('xd');
  });
});

describe('xd source: constructor default path', () => {
  it('uses the path passed to createXdSource when list() gets none', async () => {
    const source = createXdSource({ path: DIR_PATH });
    const refs = await source.list({ limit: 10 });
    expect(refs).toHaveLength(2);
  });
});
