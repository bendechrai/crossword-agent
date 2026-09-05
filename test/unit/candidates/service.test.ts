import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openCandidateCache, type CacheEntry } from '../../../src/candidates/cache.js';
import {
  createCandidateService,
  type CandidateServiceDeps,
} from '../../../src/candidates/service.js';
import type { CandidateRequest } from '../../../src/candidates/types.js';
import { CliError, ExitCode } from '../../../src/cli/exit.js';
import type { EmittedEvent } from '../../../src/events/types.js';
import { resetRegistryForTests } from '../../../src/llm/rateLimiter.js';
import type { InferenceLog, InferenceLogRecord } from '../../../src/llm/types.js';
import { ProfileObject, type Profile } from '../../../src/profiles/schema.js';
import { batchedBody, singleBody, stubTransport, type StubTransport } from '../../helpers/stubTransport.js';

// T69: tracks ProfileObject's tier1 default (deepseek-ai/DeepSeek-V4-Flash-0731).
const TIER1_MODEL = 'deepseek-ai/DeepSeek-V4-Flash-0731';

let cacheDir: string;

beforeEach(() => {
  resetRegistryForTests();
  cacheDir = mkdtempSync(join(tmpdir(), 'xw-t34-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

function profile(overrides: Record<string, unknown> = {}): Profile {
  return ProfileObject.parse({ name: 't34', ...overrides });
}

function request(overrides: Partial<CandidateRequest> = {}): CandidateRequest {
  return {
    slotId: '1A',
    clue: 'Chaos and destruction',
    length: 5,
    pattern: '?????',
    style: 'american',
    rejected: [],
    tier: 1,
    purpose: 'seed',
    n: 3,
    samples: 1,
    sampleIndex: 0,
    ...overrides,
  };
}

interface Harness {
  service: ReturnType<typeof createCandidateService>;
  transport: StubTransport;
  events: EmittedEvent[];
  records: InferenceLogRecord[];
  deps: CandidateServiceDeps;
}

function harness(
  transport: StubTransport,
  overrides: Partial<CandidateServiceDeps> = {},
): Harness {
  const events: EmittedEvent[] = [];
  const records: InferenceLogRecord[] = [];
  const inferenceLog: InferenceLog = {
    write(record) {
      records.push(record);
    },
    close() {
      // nothing to flush
    },
  };
  const deps: CandidateServiceDeps = {
    transport,
    cache: openCandidateCache({ cacheDir }),
    inferenceLog,
    profile: profile(),
    emit: (event) => {
      events.push(event);
    },
    runId: 'run-1',
    puzzleId: 'puz-1',
    offline: false,
    offlineLenient: false,
    ...overrides,
  };
  return { service: createCandidateService(deps), transport, events, records, deps };
}

function eventsOfType<T extends EmittedEvent['type']>(
  events: EmittedEvent[],
  type: T,
): Array<Extract<EmittedEvent, { type: T }>> {
  return events.filter((e): e is Extract<EmittedEvent, { type: T }> => e.type === type);
}

/** Every `<first2>/<sha1>.json` entry written under the temp cache directory. */
function cacheEntries(): CacheEntry[] {
  const out: CacheEntry[] = [];
  for (const shard of readdirSync(cacheDir)) {
    const shardDir = join(cacheDir, shard);
    if (!statSync(shardDir).isDirectory()) continue;
    for (const name of readdirSync(shardDir)) {
      out.push(JSON.parse(readFileSync(join(shardDir, name), 'utf8')) as CacheEntry);
    }
  }
  return out;
}

describe('acceptance 1: cold call, then a hit', () => {
  it('calls the transport once, validates and calibrates, and serves the second call from cache', async () => {
    const transport = stubTransport(
      singleBody([
        ['havoc', 0.82],
        ['Ruins', 0.34],
      ]),
    );
    const h = harness(transport);

    const first = await h.service.getCandidates(request());

    expect(transport.callCount).toBe(1);
    expect(first.cacheHit).toBe(false);
    expect(first.candidates.map((c) => c.answer)).toEqual(['HAVOC', 'RUINS']);
    // T13 rank calibration: score = 1 / (2 + rank).
    expect(first.candidates.map((c) => c.score)).toEqual([1 / 2, 1 / 3]);
    expect(first.candidates.every((c) => c.fromCache)).toBe(false);
    expect(first.clueUnderstood).toBe(0.9);

    const second = await h.service.getCandidates(request());

    expect(transport.callCount).toBe(1);
    expect(second.cacheHit).toBe(true);
    expect(second.candidates.every((c) => c.fromCache)).toBe(true);
    expect(second.candidates.map((c) => c.answer)).toEqual(['HAVOC', 'RUINS']);
    expect(second.candidates.map((c) => c.score)).toEqual([1 / 2, 1 / 3]);
  });

  it('emits cache:lookup for both calls and slot:ask carrying the routed prompt kind', async () => {
    const transport = stubTransport(singleBody([['HAVOC', 0.8]]));
    const h = harness(transport);

    await h.service.getCandidates(request());
    await h.service.getCandidates(request());

    const lookups = eventsOfType(h.events, 'cache:lookup');
    expect(lookups.map((e) => e.hit)).toEqual([false, true]);
    expect(lookups[0]?.key).toBe(lookups[1]?.key);
    expect(lookups.every((e) => e.slotId === '1A')).toBe(true);

    const asks = eventsOfType(h.events, 'slot:ask');
    expect(asks).toHaveLength(2);
    expect(asks[0]).toMatchObject({
      slotId: '1A',
      clue: 'Chaos and destruction',
      length: 5,
      pattern: '?????',
      tier: 1,
      purpose: 'seed',
      promptKind: 'seed',
      batchIndex: null,
    });
  });

  it('writes an inference record with cacheHit true, a null request and a counterfactual cost on the hit', async () => {
    const transport = stubTransport(singleBody([['HAVOC', 0.8]]));
    const h = harness(transport);

    await h.service.getCandidates(request());
    await h.service.getCandidates(request());

    expect(h.records).toHaveLength(2);
    const cold = h.records[0];
    const hit = h.records[1];
    expect(cold?.cacheHit).toBe(false);
    expect(cold?.model).toBe(TIER1_MODEL);
    expect(cold?.runId).toBe('run-1');
    expect(cold?.puzzleId).toBe('puz-1');
    expect(cold?.rawResponse).not.toBeNull();
    expect(cold?.usdBilled).toBeGreaterThan(0);

    expect(hit?.cacheHit).toBe(true);
    expect(hit?.request).toBeNull();
    expect(hit?.rawResponse).toBeNull();
    expect(hit?.batchIndex).toBeNull();
    expect(hit?.usdBilled).toBe(0);
    expect(hit?.usdCounterfactual).toBe(cold?.usdCounterfactual);
    expect(hit?.usage).toEqual(cold?.usage);
    expect(hit?.parsed?.candidates).toEqual([{ answer: 'HAVOC', confidence: 0.8 }]);
  });
});

describe('acceptance 2: negative results are cached', () => {
  it('caches a response with zero valid candidates and serves the second call from cache', async () => {
    // Every answer is the wrong length, so validation leaves nothing.
    const transport = stubTransport(
      singleBody([
        ['TOOLONGBYFAR', 0.9],
        ['NO', 0.4],
      ]),
    );
    const h = harness(transport);

    const first = await h.service.getCandidates(request());
    expect(first.candidates).toEqual([]);
    expect(transport.callCount).toBe(1);

    const second = await h.service.getCandidates(request());
    expect(second.cacheHit).toBe(true);
    expect(second.candidates).toEqual([]);
    expect(transport.callCount).toBe(1);

    const entries = cacheEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.response.candidates).toHaveLength(2);
  });
});

describe('acceptance 3: parse failure and the temperature-0 retry', () => {
  it('retries once at temperature 0 and returns the retry result', async () => {
    const transport = stubTransport('I am afraid I cannot help with that.', singleBody([['HAVOC', 0.8]]));
    const h = harness(transport);

    const result = await h.service.getCandidates(request());

    expect(transport.callCount).toBe(2);
    expect(transport.calls[0]?.temperature).toBe(0.2);
    expect(transport.calls[1]?.temperature).toBe(0);
    expect(result.candidates.map((c) => c.answer)).toEqual(['HAVOC']);
    expect(h.service.parseFailures('1A')).toBe(1);
  });

  it('stores the retry under a different cache key from the first attempt', async () => {
    const transport = stubTransport('not json', singleBody([['HAVOC', 0.8]]));
    const h = harness(transport);

    await h.service.getCandidates(request());

    const lookups = eventsOfType(h.events, 'cache:lookup');
    expect(lookups).toHaveLength(2);
    expect(lookups[0]?.key).not.toBe(lookups[1]?.key);
    // Only the successful attempt is cached; a parse failure has no response to store.
    const entries = cacheEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.key).toBe(lookups[1]?.key);
  });

  it('returns zero candidates and records parseFailures: 2 after two parse failures', async () => {
    const transport = stubTransport('sorry', 'still sorry');
    const h = harness(transport);

    const result = await h.service.getCandidates(request());

    expect(transport.callCount).toBe(2);
    expect(result.candidates).toEqual([]);
    expect(result.cacheHit).toBe(false);
    expect(h.service.parseFailures('1A')).toBe(2);
    expect(cacheEntries()).toHaveLength(0);
    expect(h.records.map((r) => r.attempt)).toEqual([0, 1]);
    expect(h.records.every((r) => r.parseError !== null)).toBe(true);
  });
});

describe('acceptance 4: batched seeding (B3)', () => {
  const reqs = [
    request({ slotId: '1A', clue: 'Chaos and destruction' }),
    request({ slotId: '2D', clue: 'Former partner', length: 2, pattern: '??' }),
    request({ slotId: '3A', clue: 'Feline pet', length: 3, pattern: '???' }),
  ];

  it('issues one transport call and writes three entries under three keys, each with batchSize 3', async () => {
    const transport = stubTransport(
      batchedBody([
        ['1A', [['HAVOC', 0.8]]],
        ['2D', [['EX', 0.7]]],
        ['3A', [['CAT', 0.9]]],
      ]),
    );
    const h = harness(transport, { profile: profile({ batchSize: 3 }) });

    const results = await h.service.getCandidatesBatch(reqs);

    expect(transport.callCount).toBe(1);
    expect([...results.keys()].sort()).toEqual(['1A', '2D', '3A']);
    expect(results.get('1A')?.candidates.map((c) => c.answer)).toEqual(['HAVOC']);
    expect(results.get('2D')?.candidates.map((c) => c.answer)).toEqual(['EX']);
    expect(results.get('3A')?.candidates.map((c) => c.answer)).toEqual(['CAT']);

    const entries = cacheEntries();
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((e) => e.key)).size).toBe(3);
    expect(entries.every((e) => e.batchSize === 3)).toBe(true);
    expect(entries.map((e) => e.clue).sort()).toEqual([
      'Chaos and destruction',
      'Feline pet',
      'Former partner',
    ]);

    const asks = eventsOfType(h.events, 'slot:ask');
    expect(asks.map((e) => e.batchIndex)).toEqual([0, 1, 2]);
    expect(h.records.map((r) => r.batchIndex)).toEqual([0, 1, 2]);
    expect(h.records.every((r) => r.batchSize === 3)).toBe(true);
  });

  it('re-uses the batch cache entries on a second identical batch', async () => {
    const transport = stubTransport(
      batchedBody([
        ['1A', [['HAVOC', 0.8]]],
        ['2D', [['EX', 0.7]]],
        ['3A', [['CAT', 0.9]]],
      ]),
    );
    const h = harness(transport, { profile: profile({ batchSize: 3 }) });

    await h.service.getCandidatesBatch(reqs);
    const second = await h.service.getCandidatesBatch(reqs);

    expect(transport.callCount).toBe(1);
    expect([...second.values()].every((r) => r.cacheHit)).toBe(true);
  });
});

describe('chunking a batch larger than batchSize', () => {
  it('splits 3 requests into a batch of 2 and a single, keying each by its own chunk size', async () => {
    const reqs = [
      request({ slotId: '1A', clue: 'Chaos and destruction' }),
      request({ slotId: '2D', clue: 'Former partner', length: 2, pattern: '??' }),
      request({ slotId: '3A', clue: 'Feline pet', length: 3, pattern: '???' }),
    ];
    const transport = stubTransport(
      batchedBody([
        ['1A', [['HAVOC', 0.8]]],
        ['2D', [['EX', 0.7]]],
      ]),
      singleBody([['CAT', 0.9]]),
    );
    const h = harness(transport, { profile: profile({ batchSize: 2 }) });

    const results = await h.service.getCandidatesBatch(reqs);

    expect(transport.callCount).toBe(2);
    expect(results.size).toBe(3);
    const bySlot = new Map(cacheEntries().map((e) => [e.clue, e.batchSize]));
    expect(bySlot.get('Chaos and destruction')).toBe(2);
    expect(bySlot.get('Former partner')).toBe(2);
    expect(bySlot.get('Feline pet')).toBe(1);
    // The trailing chunk of one takes the single-clue path, so it has no index.
    expect(eventsOfType(h.events, 'slot:ask').map((e) => e.batchIndex)).toEqual([0, 1, null]);
  });
});

describe('acceptance 5: a batched response missing one id', () => {
  it('re-asks exactly that clue singly and leaves the others alone', async () => {
    const reqs = [
      request({ slotId: '1A', clue: 'Chaos and destruction' }),
      request({ slotId: '2D', clue: 'Former partner', length: 2, pattern: '??' }),
      request({ slotId: '3A', clue: 'Feline pet', length: 3, pattern: '???' }),
    ];
    const transport = stubTransport(
      batchedBody([
        ['1A', [['HAVOC', 0.8]]],
        ['3A', [['CAT', 0.9]]],
      ]),
      singleBody([['EX', 0.7]]),
    );
    const h = harness(transport, { profile: profile({ batchSize: 3 }) });

    const results = await h.service.getCandidatesBatch(reqs);

    expect(transport.callCount).toBe(2);
    // The clue block is the user message; the system message carries the
    // worked example, which quotes an unrelated clue of its own.
    const reaskText = transport.calls[1]?.messages.at(-1)?.content ?? '';
    expect(reaskText).toContain('Former partner');
    expect(reaskText).not.toContain('Chaos and destruction');
    expect(reaskText).not.toContain('Feline pet');

    expect(results.get('2D')?.candidates.map((c) => c.answer)).toEqual(['EX']);
    expect(results.get('1A')?.candidates.map((c) => c.answer)).toEqual(['HAVOC']);
    expect(results.get('3A')?.candidates.map((c) => c.answer)).toEqual(['CAT']);
    expect(h.service.parseFailures('2D')).toBe(1);
    expect(h.service.parseFailures('1A')).toBe(0);
  });

  it('serves the chunk from cache on a later online run and re-asks nothing', async () => {
    const reqs = [
      request({ slotId: '1A', clue: 'Chaos and destruction' }),
      request({ slotId: '2D', clue: 'Former partner', length: 2, pattern: '??' }),
      request({ slotId: '3A', clue: 'Feline pet', length: 3, pattern: '???' }),
    ];
    const first = harness(
      stubTransport(
        batchedBody([
          ['1A', [['HAVOC', 0.8]]],
          ['3A', [['CAT', 0.9]]],
        ]),
        singleBody([['EX', 0.7]]),
      ),
      { profile: profile({ batchSize: 3 }) },
    );
    await first.service.getCandidatesBatch(reqs);
    expect(first.transport.callCount).toBe(2);
    // 1A and 3A under batch-3 keys, 2D under the batch-1 key of its re-ask.
    expect(cacheEntries()).toHaveLength(3);

    // The chunk is now only partly cached under its batch-3 keys. A second
    // online run must serve the two hits and re-ask only 2D, which its own
    // batch-1 entry answers: the transport is never called, so an unscripted
    // stub is the assertion.
    const second = harness(stubTransport(), { profile: profile({ batchSize: 3 }) });
    const results = await second.service.getCandidatesBatch(reqs);

    expect(second.transport.callCount).toBe(0);
    expect(results.get('1A')?.candidates.map((c) => c.answer)).toEqual(['HAVOC']);
    expect(results.get('2D')?.candidates.map((c) => c.answer)).toEqual(['EX']);
    expect(results.get('3A')?.candidates.map((c) => c.answer)).toEqual(['CAT']);
    expect([...results.values()].every((r) => r.cacheHit)).toBe(true);
    expect(second.records.every((r) => r.cacheHit)).toBe(true);
    // A hit has no position within a batch it never asked for, so
    // `report --by batchIndex` never counts a replay as a positional sample.
    expect(second.records.every((r) => r.batchIndex === null)).toBe(true);
    // Nothing was rewritten: the same three entries, unchanged.
    expect(cacheEntries()).toHaveLength(3);
  });

  it('re-asks only the missing clue when a chunk is partly cached online', async () => {
    const reqs = [
      request({ slotId: '1A', clue: 'Chaos and destruction' }),
      request({ slotId: '2D', clue: 'Former partner', length: 2, pattern: '??' }),
      request({ slotId: '3A', clue: 'Feline pet', length: 3, pattern: '???' }),
    ];
    // A first run caches 1A and 3A under batch-3 keys but drops 2D entirely,
    // by making its single re-ask unparseable twice.
    const first = harness(
      stubTransport(
        batchedBody([
          ['1A', [['HAVOC', 0.8]]],
          ['3A', [['CAT', 0.9]]],
        ]),
        'not json at all',
        'still not json',
      ),
      { profile: profile({ batchSize: 3 }) },
    );
    await first.service.getCandidatesBatch(reqs);
    expect(cacheEntries()).toHaveLength(2);

    const second = harness(stubTransport(singleBody([['EX', 0.7]])), {
      profile: profile({ batchSize: 3 }),
    });
    const results = await second.service.getCandidatesBatch(reqs);

    // Exactly one call, for 2D alone, and it does not quote the cached clues.
    expect(second.transport.callCount).toBe(1);
    const askText = second.transport.calls[0]?.messages.at(-1)?.content ?? '';
    expect(askText).toContain('Former partner');
    expect(askText).not.toContain('Chaos and destruction');
    expect(askText).not.toContain('Feline pet');

    expect(results.get('1A')?.cacheHit).toBe(true);
    expect(results.get('3A')?.cacheHit).toBe(true);
    expect(results.get('2D')?.cacheHit).toBe(false);
    expect(results.get('2D')?.candidates.map((c) => c.answer)).toEqual(['EX']);
    // The hits keep their answers and their records say so.
    const hitRecords = second.records.filter((r) => r.slotId !== '2D');
    expect(hitRecords.every((r) => r.cacheHit)).toBe(true);
    expect(hitRecords.every((r) => r.batchIndex === null)).toBe(true);
    // The cold re-ask is a single call, so it carries no index either.
    expect(second.records.filter((r) => r.slotId === '2D')).toHaveLength(1);
    expect(second.records.find((r) => r.slotId === '2D')?.batchIndex).toBeNull();
    // The two batch-3 entries survive; 2D adds one batch-1 entry.
    const entries = cacheEntries();
    expect(entries).toHaveLength(3);
    expect(
      entries.filter((e) => e.clue !== 'Former partner').every((e) => e.batchSize === 3),
    ).toBe(true);
    expect(entries.find((e) => e.clue === 'Former partner')?.batchSize).toBe(1);
  });
});

describe('acceptance 6: batching is seed-only (B3)', () => {
  it('throws when any request in the batch is not a seed', async () => {
    const h = harness(stubTransport());

    await expect(
      h.service.getCandidatesBatch([request({ purpose: 'reask' })]),
    ).rejects.toThrow(/seed/);
  });
});

describe('acceptance 7: offline (B6)', () => {
  it('throws a CliError with exit code 4 naming the cache key and the clue', async () => {
    const transport = stubTransport();
    const h = harness(transport, { offline: true });

    let thrown: unknown;
    try {
      await h.service.getCandidates(request());
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(CliError);
    const err = thrown as CliError;
    expect(err.code).toBe(ExitCode.OFFLINE_MISS);
    expect(err.message).toContain('Chaos and destruction');
    const key = eventsOfType(h.events, 'cache:lookup')[0]?.key ?? '';
    expect(key).toMatch(/^[0-9a-f]{40}$/);
    expect(err.message).toContain(key);
    expect(transport.callCount).toBe(0);
  });

  it('returns an empty candidate list and never throws with --offline-lenient', async () => {
    const transport = stubTransport();
    const h = harness(transport, { offline: true, offlineLenient: true });

    const result = await h.service.getCandidates(request());

    expect(result.candidates).toEqual([]);
    expect(result.cacheHit).toBe(false);
    expect(transport.callCount).toBe(0);
    const emitted = eventsOfType(h.events, 'slot:candidates');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.accepted).toEqual([]);
    expect(emitted[0]?.clueUnderstood).toBeNull();
  });

  it('serves the cached half of a batch and empties only the misses when lenient', async () => {
    const reqs = [
      request({ slotId: '1A', clue: 'Chaos and destruction' }),
      request({ slotId: '2D', clue: 'Former partner', length: 2, pattern: '??' }),
    ];
    // The warm batch omits 2D, so 2D is re-asked singly and lands under a
    // batchSize-1 key while 1A lands under the batchSize-2 one. A later batch
    // of the same two clues therefore hits for 1A and misses for 2D.
    const warm = harness(
      stubTransport(batchedBody([['1A', [['HAVOC', 0.8]]]]), singleBody([['EX', 0.7]])),
      { profile: profile({ batchSize: 2 }) },
    );
    await warm.service.getCandidatesBatch(reqs);

    const transport = stubTransport();
    const lenient = harness(transport, {
      profile: profile({ batchSize: 2 }),
      offline: true,
      offlineLenient: true,
    });
    const results = await lenient.service.getCandidatesBatch(reqs);

    expect(transport.callCount).toBe(0);
    expect(results.get('1A')?.cacheHit).toBe(true);
    expect(results.get('1A')?.candidates.map((c) => c.answer)).toEqual(['HAVOC']);
    expect(results.get('2D')?.cacheHit).toBe(false);
    expect(results.get('2D')?.candidates).toEqual([]);
    // The one record written is 1A's hit, and a hit carries no batch position.
    expect(lenient.records.map((r) => [r.slotId, r.cacheHit, r.batchIndex])).toEqual([
      ['1A', true, null],
    ]);
  });

  it('serves a cached key offline without touching the transport', async () => {
    const warm = harness(stubTransport(singleBody([['HAVOC', 0.8]])));
    await warm.service.getCandidates(request());

    const transport = stubTransport();
    const cold = harness(transport, { offline: true });
    const result = await cold.service.getCandidates(request());

    expect(result.cacheHit).toBe(true);
    expect(result.candidates.map((c) => c.answer)).toEqual(['HAVOC']);
    expect(transport.callCount).toBe(0);
  });
});

describe('acceptance 8: peek is the run ledger (B43)', () => {
  it('returns the de-duplicated union of every candidate returned for the slot', async () => {
    const transport = stubTransport(
      singleBody([
        ['HAVOC', 0.8],
        ['RUINS', 0.4],
      ]),
      singleBody([
        ['HAVOC', 0.5],
        ['WRACK', 0.3],
      ]),
    );
    const h = harness(transport);

    await h.service.getCandidates(request());
    // A different rejection set is a different cache key, so this is a second
    // call for the same slot; the pattern stays open so nothing is filtered.
    await h.service.getCandidates(request({ rejected: [{ answer: 'NOPE', reason: 'crossed' }] }));

    expect(h.service.peek('1A').map((c) => c.answer).sort()).toEqual(['HAVOC', 'RUINS', 'WRACK']);
    expect(h.service.peek('9Z')).toEqual([]);
  });

  it('hands back copies, so a caller cannot corrupt the ledger', async () => {
    const h = harness(stubTransport(singleBody([['HAVOC', 0.8]])));
    await h.service.getCandidates(request());

    const first = h.service.peek('1A');
    first.pop();
    const firstCandidate = h.service.peek('1A')[0];
    expect(firstCandidate?.answer).toBe('HAVOC');
  });
});

describe('acceptance 9: candidate:reject carries a RejectReason', () => {
  it('emits exactly one reject per dropped candidate', async () => {
    const transport = stubTransport(
      singleBody([
        ['HAVOC', 0.9], // accepted
        ['HAVOC', 0.5], // duplicate
        ['TOOLONG', 0.4], // length
        ['HA-VOC', 0.3], // normalises to HAVOC, so also a duplicate
        ['H4V0C', 0.2], // charset
        ['RUINS', 0.1], // pattern
      ]),
    );
    const h = harness(transport);

    await h.service.getCandidates(request({ pattern: 'H????' }));

    const rejects = eventsOfType(h.events, 'candidate:reject');
    expect(rejects.map((r) => `${r.answer}:${r.reason}`)).toEqual([
      'TOOLONG:length',
      'H4V0C:charset',
      'RUINS:pattern',
      'HAVOC:duplicate',
      'HAVOC:duplicate',
    ]);
    expect(rejects.every((r) => r.slotId === '1A')).toBe(true);
  });

  it('emits a rejected-before reject for an answer in the slot rejection set', async () => {
    const transport = stubTransport(
      singleBody([
        ['HAVOC', 0.9],
        ['RUINS', 0.5],
      ]),
    );
    const h = harness(transport);

    const result = await h.service.getCandidates(
      request({ rejected: [{ answer: 'HAVOC', reason: 'crossed out' }] }),
    );

    expect(result.candidates.map((c) => c.answer)).toEqual(['RUINS']);
    const rejects = eventsOfType(h.events, 'candidate:reject');
    expect(rejects).toEqual([
      { type: 'candidate:reject', slotId: '1A', answer: 'HAVOC', reason: 'rejected-before' },
    ]);
  });
});

describe('level-3 transport events', () => {
  it('emits llm:request, llm:response and llm:usage around a cold call', async () => {
    const transport = stubTransport(singleBody([['HAVOC', 0.8]]));
    const h = harness(transport);

    await h.service.getCandidates(request());

    expect(eventsOfType(h.events, 'llm:request')).toHaveLength(1);
    expect(eventsOfType(h.events, 'llm:response')).toHaveLength(1);
    const usage = eventsOfType(h.events, 'llm:usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]?.model).toBe(TIER1_MODEL);
    expect(usage[0]?.usdBilled).toBeGreaterThan(0);
    expect(usage[0]?.usdCounterfactual).toBe(usage[0]?.usdBilled);
    // T61 acceptance 1: a cold call is emitted once, and says so.
    expect(usage[0]?.cacheHit).toBe(false);
  });

  it('emits no request or response events on a cache hit, but does emit its usage', async () => {
    const transport = stubTransport(singleBody([['HAVOC', 0.8]]));
    const h = harness(transport);

    await h.service.getCandidates(request());
    const before = h.events.length;
    await h.service.getCandidates(request());

    const afterEvents = h.events.slice(before);
    expect(eventsOfType(afterEvents, 'llm:request')).toEqual([]);
    expect(eventsOfType(afterEvents, 'llm:response')).toEqual([]);
    expect(eventsOfType(afterEvents, 'llm:usage')).toHaveLength(1);
  });
});

/**
 * T61 acceptance 1 (B2). A cache hit spends nothing, but it is still a call
 * the strategy made: it reports the cached usage blob on the same `llm:usage`
 * event a cold call uses, with `usdBilled` 0, a real `usdCounterfactual` and
 * `cacheHit` true. Without it, a profile that inherited another profile's
 * cache reports near-zero cost and wins the bench on run order alone.
 */
describe('T61: cache hits are priced counterfactually on llm:usage', () => {
  it('emits the cached usage with cacheHit true on a hit, and cacheHit false on the cold call', async () => {
    const transport = stubTransport(singleBody([['HAVOC', 0.8]]));
    const h = harness(transport);

    await h.service.getCandidates(request());
    await h.service.getCandidates(request());

    expect(transport.callCount).toBe(1);
    const usage = eventsOfType(h.events, 'llm:usage');
    expect(usage).toHaveLength(2);

    const cold = usage[0];
    const hit = usage[1];
    expect(cold?.cacheHit).toBe(false);
    expect(hit?.cacheHit).toBe(true);

    // The hit carries the blob the cold call stored, so it prices the same.
    expect(hit?.usage).toEqual(cold?.usage);
    expect(hit?.model).toBe(TIER1_MODEL);
    expect(hit?.usdCounterfactual).toBe(cold?.usdCounterfactual);
    expect(hit?.usdCounterfactual).toBeGreaterThan(0);
    // Nothing left the account, and no provider was waited on.
    expect(hit?.usdBilled).toBe(0);
    expect(hit?.latencyMs).toBe(0);
  });

  it('emits one usage event per clue served from cache in a batched ask', async () => {
    const reqs = [
      request({ slotId: '1A', clue: 'Chaos and destruction' }),
      request({ slotId: '3A', clue: 'Calm self-assurance', length: 5, pattern: '?????' }),
    ];
    const body = batchedBody([
      ['1A', [['HAVOC', 0.9]]],
      ['3A', [['POISE', 0.9]]],
    ]);
    const cold = harness(stubTransport(body), { profile: profile({ batchSize: 2 }) });
    await cold.service.getCandidatesBatch(reqs);
    expect(eventsOfType(cold.events, 'llm:usage')).toHaveLength(1);

    // A second service over the same cache directory replays both clues.
    const warm = harness(stubTransport(), { profile: profile({ batchSize: 2 }) });
    await warm.service.getCandidatesBatch(reqs);

    const usage = eventsOfType(warm.events, 'llm:usage');
    expect(usage).toHaveLength(2);
    expect(usage.every((e) => e.cacheHit === true)).toBe(true);
    expect(usage.every((e) => e.usdBilled === 0)).toBe(true);
    // splitUsage divided the batch's tokens between the two clues, so the two
    // hits add back up to what the one cold call was priced at.
    const coldUsd = eventsOfType(cold.events, 'llm:usage')[0]?.usdCounterfactual ?? 0;
    const warmUsd = usage.reduce((sum, e) => sum + e.usdCounterfactual, 0);
    expect(warmUsd).toBeCloseTo(coldUsd, 9);
  });
});
