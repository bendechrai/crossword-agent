import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ExitCode, isCliError } from '../../../src/cli/exit.js';
import { createFileSource } from '../../../src/sources/file.js';
import type { FetchLike, PuzzleRef } from '../../../src/sources/types.js';

const FIXTURE_PATH = 'test/fixtures/sources/local-sample.xd';

describe('file source: list', () => {
  it('returns exactly one ref for a local path (T22 acceptance 1)', async () => {
    const source = createFileSource();
    const refs = await source.list({ path: FIXTURE_PATH });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      id: 'local-sample',
      ext: 'xd',
      source: 'file',
    });
  });

  it('sanitises a basename containing spaces into the id and keeps the original name in title (acceptance 6)', async () => {
    const source = createFileSource();
    const refs = await source.list({ path: 'some/dir/my puzzle name.ipuz' });
    expect(refs).toHaveLength(1);
    const [ref] = refs as [PuzzleRef];
    expect(ref.id).toBe('my-puzzle-name');
    expect(ref.id).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(ref.title).toBe('my puzzle name.ipuz');
    expect(ref.ext).toBe('ipuz');
  });

  it('rejects an unsupported extension with a usage error naming the accepted set (acceptance 5)', async () => {
    const source = createFileSource();
    await expect(source.list({ path: 'puzzles/notes.txt' })).rejects.toSatisfy((e: unknown) => {
      if (!isCliError(e)) return false;
      expect(e.code).toBe(ExitCode.USAGE);
      expect(e.message).toContain('puz');
      expect(e.message).toContain('ipuz');
      expect(e.message).toContain('jpz');
      expect(e.message).toContain('xd');
      expect(e.message).toContain('json');
      return true;
    });
  });

  it('rejects a URL with no recognisable extension as a usage error, not a guess', async () => {
    const source = createFileSource();
    await expect(source.list({ path: 'https://example.com/puzzles/latest' })).rejects.toSatisfy(
      (e: unknown) => isCliError(e) && e.code === ExitCode.USAGE,
    );
  });

  it('rejects when no path or URL is given', async () => {
    const source = createFileSource();
    await expect(source.list({})).rejects.toSatisfy(
      (e: unknown) => isCliError(e) && e.code === ExitCode.USAGE,
    );
  });

  it('derives id, ext and title from an http(s) URL', async () => {
    const source = createFileSource();
    const refs = await source.list({ path: 'https://example.com/archive/2024/sample.puz' });
    expect(refs[0]).toMatchObject({ id: 'sample', ext: 'puz', source: 'file', title: 'sample.puz' });
    expect(refs[0]?.url).toBe('https://example.com/archive/2024/sample.puz');
  });
});

describe('file source: download', () => {
  it('reads a local file byte-identical to the fixture (acceptance 2)', async () => {
    const source = createFileSource();
    const [ref] = await source.list({ path: FIXTURE_PATH });
    const result = await source.download(ref as PuzzleRef);
    const expected = await readFile(join(process.cwd(), FIXTURE_PATH));
    expect(Buffer.compare(result.bytes, expected)).toBe(0);
    expect(result.ext).toBe('xd');
  });

  it('calls the injected fetch exactly once with the url and returns its bytes (acceptance 3)', async () => {
    const url = 'https://example.com/sample.puz';
    const body = Buffer.from('PUZ-FIXTURE-BYTES');
    const fetchStub = vi.fn<FetchLike>(() => Promise.resolve(new Response(body, { status: 200 })));
    const source = createFileSource({ fetch: fetchStub });
    const [ref] = await source.list({ path: url });
    const result = await source.download(ref as PuzzleRef);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledWith(url);
    expect(Buffer.compare(result.bytes, body)).toBe(0);
  });

  it('turns a 404 from the injected fetch into a CliError with code 3 (acceptance 4)', async () => {
    const fetchStub = vi.fn<FetchLike>(() => Promise.resolve(new Response(null, { status: 404 })));
    const source = createFileSource({ fetch: fetchStub });
    const [ref] = await source.list({ path: 'https://example.com/missing.puz' });
    await expect(source.download(ref as PuzzleRef)).rejects.toSatisfy(
      (e: unknown) => isCliError(e) && e.code === ExitCode.NOT_FOUND,
    );
  });

  it('turns a missing local file into a CliError with code 3', async () => {
    const source = createFileSource();
    const ref: PuzzleRef = {
      id: 'nope',
      source: 'file',
      url: 'test/fixtures/sources/does-not-exist.xd',
      ext: 'xd',
    };
    await expect(source.download(ref)).rejects.toSatisfy(
      (e: unknown) => isCliError(e) && e.code === ExitCode.NOT_FOUND,
    );
  });
});

describe('file source: id', () => {
  it('is registered as "file"', () => {
    expect(createFileSource().id).toBe('file');
  });
});
