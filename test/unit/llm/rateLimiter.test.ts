import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelLimits } from '../../../src/llm/types.js';

vi.mock('../../../src/llm/pricing.js', () => ({
  limitsOf: vi.fn(),
}));

// Imported after the mock so the module under test picks up the mocked
// `limitsOf`; per-test return values are set with `mockLimits`.
import { limitsOf } from '../../../src/llm/pricing.js';
import {
  getLimiter,
  parseRateLimitHeaders,
  resetRegistryForTests,
} from '../../../src/llm/rateLimiter.js';

function mockLimits(limits: ModelLimits): void {
  vi.mocked(limitsOf).mockReturnValue(limits);
}

// Flushes the microtask queue enough times for a chain of `acquire().then()`
// callbacks resolved synchronously (inside the Promise executor) to run.
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  resetRegistryForTests();
  vi.mocked(limitsOf).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getLimiter: the rps token bucket', () => {
  it('lets 20 acquire() calls complete in two 1-second windows, 10 in each, on the fake clock', async () => {
    mockLimits({ requestsPerMinute: 600, tokensPerMinute: 10_000_000, burstRatio: 1 });
    const limiter = getLimiter('rps-model', { rpsFraction: 1, maxConcurrency: 100 });

    const order: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      void limiter.acquire(1).then(() => order.push(i));
    }
    await flushMicrotasks();

    // Window 1 [0, 1000ms): the full burst of 10 grants immediately.
    expect(order.length).toBe(10);

    await vi.advanceTimersByTimeAsync(1000);

    // Window 2 [1000, 2000ms): the remaining 10 have all been released by
    // the 1-second mark, refilling at 10 rps.
    expect(order.length).toBe(20);
  });

  it('releases queued callers strictly in arrival order (FIFO)', async () => {
    mockLimits({ requestsPerMinute: 60, tokensPerMinute: 10_000_000, burstRatio: 1 });
    const limiter = getLimiter('fifo-model', { rpsFraction: 1, maxConcurrency: 100 });

    const order: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      void limiter.acquire(1).then(() => order.push(i));
    }
    await flushMicrotasks();
    expect(order).toEqual([0]);

    await vi.advanceTimersByTimeAsync(4000);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('getLimiter: the maxConcurrency gate', () => {
  it('with 20 acquires outstanding and none released, caps inFlight at maxConcurrency and queues the rest', async () => {
    mockLimits({ requestsPerMinute: 6_000_000, tokensPerMinute: 1_000_000_000, burstRatio: 1 });
    const limiter = getLimiter('conc-model', { rpsFraction: 1, maxConcurrency: 8 });

    for (let i = 0; i < 20; i += 1) {
      void limiter.acquire(1);
    }
    await flushMicrotasks();

    const snap = limiter.snapshot();
    expect(snap.inFlight).toBe(8);
    expect(snap.queued).toBe(12);
  });

  it('releases a queued caller once observe() frees a concurrency slot', async () => {
    mockLimits({ requestsPerMinute: 6_000_000, tokensPerMinute: 1_000_000_000, burstRatio: 1 });
    const limiter = getLimiter('conc-release-model', { rpsFraction: 1, maxConcurrency: 1 });

    let secondDone = false;
    void limiter.acquire(1);
    void limiter.acquire(1).then(() => {
      secondDone = true;
    });
    await flushMicrotasks();
    expect(secondDone).toBe(false);
    expect(limiter.snapshot().inFlight).toBe(1);
    expect(limiter.snapshot().queued).toBe(1);

    limiter.observe({ status: 200 });
    await flushMicrotasks();

    expect(secondDone).toBe(true);
    expect(limiter.snapshot().inFlight).toBe(1);
    expect(limiter.snapshot().queued).toBe(0);
  });
});

describe('observe(): AIMD', () => {
  it('halves rps on a 429, flooring at 1 after repeated 429s and never going below', () => {
    mockLimits({ requestsPerMinute: 480, tokensPerMinute: 1_000_000_000, burstRatio: 1 });
    const limiter = getLimiter('aimd-floor-model', { rpsFraction: 1 });
    expect(limiter.snapshot().rps).toBe(8);

    limiter.observe({ status: 429 });
    expect(limiter.snapshot().rps).toBe(4);
    limiter.observe({ status: 429 });
    expect(limiter.snapshot().rps).toBe(2);
    limiter.observe({ status: 429 });
    expect(limiter.snapshot().rps).toBe(1);
    limiter.observe({ status: 429 });
    expect(limiter.snapshot().rps).toBe(1);
  });

  it('adds 0.5 rps per 10s of no further 429, capping at the ceiling', async () => {
    mockLimits({ requestsPerMinute: 300, tokensPerMinute: 1_000_000_000, burstRatio: 1 });
    const emit = vi.fn();
    const limiter = getLimiter('aimd-recover-model', { rpsFraction: 1, emit });

    limiter.observe({ status: 429 });
    expect(limiter.snapshot().rps).toBe(2.5);
    expect(emit).toHaveBeenCalledWith({
      type: 'rate:adjusted',
      model: 'aimd-recover-model',
      rps: 2.5,
      reason: '429',
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(limiter.snapshot().rps).toBe(3);
    expect(emit).toHaveBeenCalledWith({
      type: 'rate:adjusted',
      model: 'aimd-recover-model',
      rps: 3,
      reason: 'recovery',
    });

    // (5 - 3) / 0.5 = 4 more 10s steps reaches the ceiling of 5.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(limiter.snapshot().rps).toBe(5);

    const callsAtCeiling = emit.mock.calls.length;
    await vi.advanceTimersByTimeAsync(50_000);
    expect(limiter.snapshot().rps).toBe(5);
    // No further "recovery" adjustments fire once at the ceiling.
    expect(emit.mock.calls.length).toBe(callsAtCeiling);
  });

  it('never falls below the floor across a burst of consecutive 429s', () => {
    mockLimits({ requestsPerMinute: 60, tokensPerMinute: 1_000_000_000, burstRatio: 1 });
    const limiter = getLimiter('aimd-burst-model', { rpsFraction: 1 });
    for (let i = 0; i < 10; i += 1) {
      limiter.observe({ status: 429 });
    }
    expect(limiter.snapshot().rps).toBe(1);
  });
});

describe('the tokens-per-minute bucket', () => {
  it('blocks acquire() when estimatedTokens would exceed the remaining TPM allowance, and releases once the window refills it', async () => {
    mockLimits({ requestsPerMinute: 1_000_000_000, tokensPerMinute: 600, burstRatio: 1 });
    const limiter = getLimiter('tpm-model', { rpsFraction: 1, maxConcurrency: 10 });

    let firstDone = false;
    let secondDone = false;
    void limiter.acquire(500).then(() => {
      firstDone = true;
    });
    void limiter.acquire(500).then(() => {
      secondDone = true;
    });
    await flushMicrotasks();

    expect(firstDone).toBe(true);
    expect(secondDone).toBe(false);

    // 600 tokens/min = 0.01 tokens/ms; 400 more tokens needed = 40,000ms.
    await vi.advanceTimersByTimeAsync(39_999);
    expect(secondDone).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(secondDone).toBe(true);
  });
});

describe('parseRateLimitHeaders', () => {
  it('returns {} for an empty header object', () => {
    expect(parseRateLimitHeaders({})).toEqual({});
  });

  it('treats a missing header as undefined, never 0', () => {
    const result = parseRateLimitHeaders({ 'x-ratelimit-remaining-requests': '0' });
    expect(result.remainingRequests).toBe(0);
    expect(result.remainingTokens).toBeUndefined();
    expect('remainingTokens' in result).toBe(false);
  });

  it('maps the seven OpenAI-compatible headers it can act on', () => {
    const result = parseRateLimitHeaders({
      'x-ratelimit-limit-requests': '600',
      'x-ratelimit-remaining-requests': '599',
      'x-ratelimit-reset-requests': '1s',
      'x-ratelimit-limit-tokens': '400000',
      'x-ratelimit-remaining-tokens': '399000',
      'x-ratelimit-reset-tokens': '60ms',
      'retry-after': '2',
    });
    expect(result).toEqual({
      remainingRequests: 599,
      resetRequestsMs: 1000,
      remainingTokens: 399000,
      resetTokensMs: 60,
      retryAfterMs: 2000,
    });
  });

  it('accepts a plain millisecond integer for the reset headers, not just duration strings', () => {
    const result = parseRateLimitHeaders({
      'x-ratelimit-reset-requests': '1500',
      'x-ratelimit-reset-tokens': '250',
    });
    expect(result.resetRequestsMs).toBe(1500);
    expect(result.resetTokensMs).toBe(250);
  });

  it('parses retry-after: "2" (seconds) to 2000ms', () => {
    expect(parseRateLimitHeaders({ 'retry-after': '2' }).retryAfterMs).toBe(2000);
  });

  it('parses retry-after as an HTTP-date to a positive number of ms', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const future = new Date('2026-01-01T00:00:05.000Z').toUTCString();
    const result = parseRateLimitHeaders({ 'retry-after': future });
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeCloseTo(5000, -2);
  });

  it('combines with an HTTP status to build the full RateLimitSignal observe() expects', () => {
    mockLimits({ requestsPerMinute: 480, tokensPerMinute: 1_000_000_000, burstRatio: 1 });
    const limiter = getLimiter('combo-model', { rpsFraction: 1 });
    const before = limiter.snapshot().rps;

    limiter.observe({ status: 429, ...parseRateLimitHeaders({ 'retry-after': '1' }) });

    expect(limiter.snapshot().rps).toBe(before / 2);
    expect(limiter.snapshot().lastSignal?.retryAfterMs).toBe(1000);
  });
});

describe('getLimiter: the registry', () => {
  it('returns the same instance for repeated calls with the same model id, and a different one for a different model', () => {
    mockLimits({ requestsPerMinute: 600, tokensPerMinute: 1_000_000_000, burstRatio: 1 });
    const a1 = getLimiter('m');
    const a2 = getLimiter('m');
    const b = getLimiter('n');
    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);
  });
});
