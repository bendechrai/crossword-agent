import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmittedEvent } from '../../../src/events/types.js';
import { createNebiusTransport } from '../../../src/llm/client.js';
import { openInferenceLog } from '../../../src/llm/inferenceLog.js';
import { getLimiter, resetRegistryForTests } from '../../../src/llm/rateLimiter.js';
import type { InferenceLog, InferenceLogRecord, LlmRequest } from '../../../src/llm/types.js';
import { ExitCode, isCliError } from '../../../src/cli/exit.js';
import { startStubHttpServer, type StubHttpServer } from '../../helpers/stubHttpServer.js';

// A real catalogue entry (test/unit/llm/pricing.test.ts uses the same one) so
// getLimiter/usdFor need no mocking: 600 RPM / 400,000 TPM, well above what
// these tests ever ask for in a burst.
const MODEL = 'nvidia/Nemotron-3_5-Lightning';
const FAKE_API_KEY = 'sk-test-fake-do-not-log-1234567890';

function makeRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: MODEL,
    messages: [{ role: 'user', content: 'six letter word for mammal' }],
    temperature: 0.2,
    maxTokens: 200,
    ...overrides,
  };
}

function successBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    choices: [{ message: { content: 'MAMMAL' } }],
    usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 },
    ...overrides,
  };
}

function fakeLog(): InferenceLog & { records: InferenceLogRecord[] } {
  const records: InferenceLogRecord[] = [];
  return {
    records,
    write: (record) => records.push(record),
    close: () => {},
  };
}

let server: StubHttpServer | undefined;
const tempDirs: string[] = [];

beforeEach(() => {
  resetRegistryForTests();
});

afterEach(async () => {
  vi.useRealTimers();
  if (server !== undefined) {
    await server.close();
    server = undefined;
  }
  resetRegistryForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('createNebiusTransport: happy path', () => {
  it('returns text, usage and httpStatus 200, and writes one attempt:0 record (acceptance 1)', async () => {
    server = await startStubHttpServer([{ status: 200, body: successBody() }]);
    const log = fakeLog();
    const transport = createNebiusTransport({
      apiKey: FAKE_API_KEY,
      baseUrl: server.url,
      inferenceLog: log,
    });

    const result = await transport.complete(makeRequest());

    expect(result.text).toBe('MAMMAL');
    expect(result.usage).toEqual({ promptTokens: 40, completionTokens: 6, totalTokens: 46 });
    expect(result.httpStatus).toBe(200);

    expect(log.records).toHaveLength(1);
    expect(log.records[0]?.attempt).toBe(0);
    expect(log.records[0]?.model).toBe(MODEL);
    expect(log.records[0]?.cacheHit).toBe(false);
  });

  it('measures latencyMs around the fetch only, and it is greater than 0 (acceptance 8)', async () => {
    server = await startStubHttpServer([{ status: 200, body: successBody() }]);
    const log = fakeLog();
    const transport = createNebiusTransport({
      apiKey: FAKE_API_KEY,
      baseUrl: server.url,
      inferenceLog: log,
    });

    const result = await transport.complete(makeRequest());

    expect(result.latencyMs).toBeGreaterThan(0);
    expect(log.records[0]?.latencyMs).toBeGreaterThan(0);
  });
});

/**
 * A `sleep` substitute that resolves instantly (so a retry test never
 * actually waits out a real backoff) while recording every requested delay,
 * so the test can still assert on the millisecond values the transport
 * computed. This stands in for vitest's fake timers: this suite mixes real
 * sockets (the stub HTTP server) with retry backoff, and advancing a fake
 * clock races the real, non-fake I/O the fetch to that server depends on -
 * there is no `await` that reliably lands between "the retry's `setTimeout`
 * call has been made" and "the fake clock has been advanced past it". An
 * injected sleep sidesteps the race entirely: it is a plain synchronous
 * substitution, not a clock the test has to chase.
 */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

describe('createNebiusTransport: 429 retry-after', () => {
  it('honours retry-after (1000ms), writes two records, and observes 429 (acceptance 2)', async () => {
    server = await startStubHttpServer([
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 200, body: successBody() },
    ]);
    const log = fakeLog();
    const limiter = getLimiter(MODEL);
    const observeSpy = vi.spyOn(limiter, 'observe');
    const emitted: EmittedEvent[] = [];
    const { sleep, delays } = recordingSleep();
    const transport = createNebiusTransport({
      apiKey: FAKE_API_KEY,
      baseUrl: server.url,
      inferenceLog: log,
      emit: (e) => emitted.push(e),
      sleep,
    });

    const result = await transport.complete(makeRequest());

    expect(result.httpStatus).toBe(200);
    expect(log.records).toHaveLength(2);
    expect(log.records.map((r) => r.attempt)).toEqual([0, 1]);
    expect(observeSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 429 }));
    expect(delays).toEqual([1000]);
    expect(emitted).toContainEqual(
      expect.objectContaining({ type: 'rate:limited', status: 429, retryAfterMs: 1000, attempt: 0 }),
    );
  });
});

describe('createNebiusTransport: 429 without retry-after', () => {
  it('backs off from 500ms with full jitter from the injected PRNG (acceptance 3)', async () => {
    server = await startStubHttpServer([{ status: 429 }, { status: 200, body: successBody() }]);
    const log = fakeLog();
    const { sleep, delays } = recordingSleep();
    const transport = createNebiusTransport({
      apiKey: FAKE_API_KEY,
      baseUrl: server.url,
      inferenceLog: log,
      random: () => 0.4,
      sleep,
    });

    const result = await transport.complete(makeRequest());

    expect(result.httpStatus).toBe(200);
    expect(delays).toHaveLength(1);
    // random()=0.4, base 500ms, attempt 0: 0.4 * 500 = 200ms, which must land in [0, 500].
    expect(delays[0]).toBeGreaterThanOrEqual(0);
    expect(delays[0]).toBeLessThanOrEqual(500);
    expect(delays[0]).toBe(200);
  });
});

describe('createNebiusTransport: retries exhausted', () => {
  it('six consecutive 429s throw CliError code 5 (PROVIDER) and write six records (acceptance 4)', async () => {
    server = await startStubHttpServer([{ status: 429 }]); // repeats for every request
    const log = fakeLog();
    const { sleep } = recordingSleep();
    const transport = createNebiusTransport({
      apiKey: FAKE_API_KEY,
      baseUrl: server.url,
      inferenceLog: log,
      random: () => 0,
      sleep,
    });

    let caught: unknown;
    try {
      await transport.complete(makeRequest());
    } catch (err) {
      caught = err;
    }

    expect(isCliError(caught)).toBe(true);
    expect((caught as { code: ExitCode }).code).toBe(ExitCode.PROVIDER);
    expect(log.records).toHaveLength(6);
    expect(log.records.map((r) => r.attempt)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('createNebiusTransport: 5xx', () => {
  it('retries a 500 without changing the limiter rate (acceptance 5)', async () => {
    server = await startStubHttpServer([{ status: 500 }, { status: 200, body: successBody() }]);
    const log = fakeLog();
    const limiter = getLimiter(MODEL);
    const before = limiter.snapshot().rps;
    const observeSpy = vi.spyOn(limiter, 'observe');
    const { sleep } = recordingSleep();
    const transport = createNebiusTransport({
      apiKey: FAKE_API_KEY,
      baseUrl: server.url,
      inferenceLog: log,
      random: () => 0,
      sleep,
    });

    const result = await transport.complete(makeRequest());

    expect(result.httpStatus).toBe(200);
    expect(observeSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 500 }));
    expect(limiter.snapshot().rps).toBe(before);
  });
});

describe('createNebiusTransport: header capture and redaction', () => {
  it('captures response headers verbatim, and never logs the authorization request header (acceptance 6)', async () => {
    server = await startStubHttpServer([
      { status: 200, headers: { 'x-ratelimit-remaining-requests': '599' }, body: successBody() },
    ]);
    const log = fakeLog();
    const transport = createNebiusTransport({
      apiKey: FAKE_API_KEY,
      baseUrl: server.url,
      inferenceLog: log,
    });

    await transport.complete(makeRequest());

    expect(server.requests).toHaveLength(1);
    const sentAuth = server.requests[0]?.headers['authorization'];
    expect(sentAuth).toBe(`Bearer ${FAKE_API_KEY}`);

    const record = log.records[0];
    expect(record?.responseHeaders['x-ratelimit-remaining-requests']).toBe('599');
    expect(record?.responseHeaders['authorization']).toBeUndefined();
    expect(Object.keys(record?.responseHeaders ?? {})).not.toContain('authorization');
  });
});

describe('createNebiusTransport: the API key never reaches the log file', () => {
  it('writes no occurrence of the key anywhere in the written log (acceptance 7)', async () => {
    server = await startStubHttpServer([{ status: 200, body: successBody() }]);
    const dir = mkdtempSync(join(tmpdir(), 'crossword-nebius-client-'));
    tempDirs.push(dir);
    const realLog = openInferenceLog({ dir });
    const transport = createNebiusTransport({
      apiKey: FAKE_API_KEY,
      baseUrl: server.url,
      inferenceLog: realLog,
    });

    await transport.complete(makeRequest());
    realLog.close();

    const today = new Date().toISOString().slice(0, 10);
    const contents = readFileSync(join(dir, `${today}.jsonl`), 'utf8');
    expect(contents).not.toContain(FAKE_API_KEY);
    expect(contents.length).toBeGreaterThan(0);
  });
});

describe('createNebiusTransport: missing NEBIUS_API_KEY', () => {
  it('throws a CliError naming the .env hint, never an opaque 401', () => {
    const log = fakeLog();
    let caught: unknown;
    try {
      createNebiusTransport({ baseUrl: 'http://127.0.0.1:1', inferenceLog: log, env: {} });
    } catch (err) {
      caught = err;
    }

    expect(isCliError(caught)).toBe(true);
    expect((caught as { hint?: string }).hint).toBe('cp .env.example .env');
    expect((caught as Error).message).not.toContain('401');
  });
});
