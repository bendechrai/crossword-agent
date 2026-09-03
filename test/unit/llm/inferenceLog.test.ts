import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openInferenceLog } from '../../../src/llm/inferenceLog.js';
import type { InferenceLogRecord } from '../../../src/llm/types.js';
import { log } from '../../../src/util/log.js';

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crossword-inference-log-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Every field an `InferenceLogRecord` needs, so a test only overrides what it cares about. */
function makeRecord(overrides: Partial<InferenceLogRecord> = {}): InferenceLogRecord {
  return {
    id: 'rec-1',
    ts: '2026-09-02T12:00:00.000Z',
    runId: 'run-1',
    puzzleId: 'puzzle-1',
    slotId: '1A',
    purpose: 'seed',
    promptKind: 'seed',
    tier: 1,
    model: 'nvidia/Nemotron-3_5-Lightning',
    promptVersion: '1',
    cacheKey: 'abc123',
    cacheHit: false,
    batchSize: 1,
    batchIndex: 0,
    sampleIndex: 0,
    request: {
      messages: [{ role: 'user', content: 'clue text' }],
      temperature: 0.7,
      maxTokens: 200,
    },
    rawResponse: '{"clue_understood":0.8,"candidates":[]}',
    parsed: { clue_understood: 0.8, candidates: [{ answer: 'ANIMAL', confidence: 0.6 }] },
    parseError: null,
    httpStatus: 200,
    responseHeaders: { 'content-type': 'application/json' },
    attempt: 0,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    usdBilled: 0.0001,
    usdCounterfactual: 0.0001,
    latencyMs: 250,
    error: null,
    ...overrides,
  };
}

function fixedClock(startIso: string): { now: () => Date; advanceHours: (hours: number) => void } {
  let current = new Date(startIso);
  return {
    now: () => current,
    advanceHours: (hours: number) => {
      current = new Date(current.getTime() + hours * 60 * 60 * 1000);
    },
  };
}

describe('openInferenceLog', () => {
  it('writes three records to a temp dir as one file with three lines, each round-tripping (acceptance 1)', () => {
    const dir = tempDir();
    const clock = fixedClock('2026-09-02T10:00:00.000Z');
    const sink = openInferenceLog({ dir, now: clock.now });

    const records = [makeRecord({ id: 'a' }), makeRecord({ id: 'b' }), makeRecord({ id: 'c' })];
    for (const record of records) sink.write(record);
    sink.close();

    const files = readdirSync(dir);
    expect(files).toEqual(['2026-09-02.jsonl']);

    const lines = readFileSync(join(dir, '2026-09-02.jsonl'), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l) as InferenceLogRecord)).toEqual(records);
  });

  it('rolls to a new file when the injected clock crosses UTC midnight, leaving the first file untouched (acceptance 2)', () => {
    const dir = tempDir();
    const clock = fixedClock('2026-09-02T23:59:00.000Z');
    const sink = openInferenceLog({ dir, now: clock.now });

    sink.write(makeRecord({ id: 'before-midnight' }));
    clock.advanceHours(1); // now 2026-09-03T00:59:00.000Z
    sink.write(makeRecord({ id: 'after-midnight' }));
    sink.close();

    expect(readdirSync(dir).sort()).toEqual(['2026-09-02.jsonl', '2026-09-03.jsonl']);

    const firstFile = readFileSync(join(dir, '2026-09-02.jsonl'), 'utf8').trimEnd().split('\n');
    expect(firstFile).toHaveLength(1);
    expect((JSON.parse(firstFile[0] as string) as InferenceLogRecord).id).toBe('before-midnight');

    const secondFile = readFileSync(join(dir, '2026-09-03.jsonl'), 'utf8').trimEnd().split('\n');
    expect(secondFile).toHaveLength(1);
    expect((JSON.parse(secondFile[0] as string) as InferenceLogRecord).id).toBe('after-midnight');
  });

  it('enabled: false writes no file at all and creates no directory (acceptance 3)', () => {
    const parent = tempDir();
    const dir = join(parent, 'inference');
    const sink = openInferenceLog({ dir, enabled: false });

    sink.write(makeRecord());
    sink.close();

    expect(existsSync(dir)).toBe(false);
  });

  it('a directory that cannot be created causes write() to never throw and to log exactly one warning across ten writes (acceptance 5)', () => {
    // A regular file stands in for a directory component, so `mkdir` fails
    // with ENOTDIR regardless of the process's uid (unlike a chmod-based
    // read-only directory, which root - the preflight container's user -
    // would simply ignore).
    const parent = tempDir();
    const blocker = join(parent, 'not-a-directory');
    writeFileSync(blocker, 'x');
    const dir = join(blocker, 'inference');

    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const sink = openInferenceLog({ dir });

    for (let i = 0; i < 10; i += 1) {
      expect(() => sink.write(makeRecord({ id: `rec-${i}` }))).not.toThrow();
    }
    expect(() => sink.close()).not.toThrow();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(dir)).toBe(false);
  });

  it('two records with the same id but different attempt both appear, in order (acceptance 6)', () => {
    const dir = tempDir();
    const sink = openInferenceLog({ dir, now: () => new Date('2026-09-02T10:00:00.000Z') });

    sink.write(makeRecord({ id: 'same-id', attempt: 0 }));
    sink.write(makeRecord({ id: 'same-id', attempt: 1 }));
    sink.close();

    const lines = readFileSync(join(dir, '2026-09-02.jsonl'), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l) as InferenceLogRecord);
    expect(parsed.map((r) => r.attempt)).toEqual([0, 1]);
    expect(parsed.every((r) => r.id === 'same-id')).toBe(true);
  });

  it('writes a record whose responseHeaders contains authorization verbatim - no runtime redaction (acceptance 4a)', () => {
    const dir = tempDir();
    const sink = openInferenceLog({ dir, now: () => new Date('2026-09-02T10:00:00.000Z') });

    const record = makeRecord({
      id: 'has-response-auth-header',
      // `authorization` here is the *server's* response header (e.g. a proxy
      // echoing it back), which is legitimately loggable - only *request*
      // headers are excluded, and by construction (acceptance 4b), not by a
      // runtime filter in write().
      responseHeaders: { 'content-type': 'application/json', authorization: 'Bearer server-echoed-value' },
    });
    sink.write(record);
    sink.close();

    const line = readFileSync(join(dir, '2026-09-02.jsonl'), 'utf8').trimEnd();
    expect(JSON.parse(line) as InferenceLogRecord).toEqual(record);
  });

  it('a record that fails to serialise (circular reference) warns once, naming the record id, and never throws', () => {
    const dir = tempDir();
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const sink = openInferenceLog({ dir, now: () => new Date('2026-09-02T10:00:00.000Z') });

    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const record: InferenceLogRecord = {
      ...makeRecord({ id: 'circular-record' }),
      // Force a circular reference into the record to exercise the
      // serialisation-failure path; the real type never allows this.
      parsed: circular as unknown as InferenceLogRecord['parsed'],
    };

    expect(() => sink.write(record)).not.toThrow();
    sink.close();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('circular-record');
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('redaction (type-level)', () => {
  it('has no parameter for request headers on the record request shape (acceptance 4b)', () => {
    // Type-only assertion: `InferenceLogRecord.request` has no `headers`
    // field, so a caller building one cannot smuggle an authorization header
    // into the log even by mistake - redaction is structural, not a runtime
    // filter. This fails `npm run typecheck` (not `vitest run`) if the shape
    // ever grows one.
    function buildRequestPortion(
      request: NonNullable<InferenceLogRecord['request']>,
    ): NonNullable<InferenceLogRecord['request']> {
      return request;
    }

    const built = buildRequestPortion({
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0,
      maxTokens: 1,
      // @ts-expect-error request headers have no home on this shape.
      headers: { authorization: 'secret-token' },
    });

    expect(built.messages).toHaveLength(1);
  });
});
