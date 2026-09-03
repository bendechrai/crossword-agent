import type { LlmRequest, LlmResult, LlmTransport, TokenUsage } from '../../src/llm/types.js';

/**
 * T34's test seam (B51): a scripted `LlmTransport` that never opens a socket.
 *
 * A reply is a raw body string, a partial `LlmResult` shape, or a function of
 * the request (so a test can answer differently depending on, say, the
 * temperature the service retried at). Replies are consumed in order; a call
 * made after the script runs out rejects, so a test asserting "the transport is
 * invoked zero times" fails loudly rather than silently receiving a repeat.
 */
export interface StubReplyShape {
  text: string;
  usage?: Partial<TokenUsage>;
  httpStatus?: number;
  headers?: Record<string, string>;
  latencyMs?: number;
}

export type StubReply = string | StubReplyShape | ((req: LlmRequest) => string | StubReplyShape);

export interface StubTransport extends LlmTransport {
  /** Every request the service handed over, in order. */
  readonly calls: LlmRequest[];
  readonly callCount: number;
  /** Appends more scripted replies to the queue. */
  push(...replies: StubReply[]): void;
}

const DEFAULT_USAGE: TokenUsage = {
  promptTokens: 100,
  completionTokens: 20,
  totalTokens: 120,
};

function shapeOf(reply: StubReply, req: LlmRequest): StubReplyShape {
  const resolved = typeof reply === 'function' ? reply(req) : reply;
  return typeof resolved === 'string' ? { text: resolved } : resolved;
}

export function stubTransport(...replies: StubReply[]): StubTransport {
  const queue: StubReply[] = [...replies];
  const calls: LlmRequest[] = [];

  return {
    calls,
    get callCount(): number {
      return calls.length;
    },
    push(...more: StubReply[]): void {
      queue.push(...more);
    },
    complete(req: LlmRequest): Promise<LlmResult> {
      calls.push(req);
      const next = queue.shift();
      if (next === undefined) {
        return Promise.reject(
          new Error(
            `stubTransport: unscripted call ${String(calls.length)} to model ${req.model}`,
          ),
        );
      }
      const shape = shapeOf(next, req);
      return Promise.resolve({
        text: shape.text,
        usage: { ...DEFAULT_USAGE, ...shape.usage },
        httpStatus: shape.httpStatus ?? 200,
        headers: shape.headers ?? {},
        latencyMs: shape.latencyMs ?? 7,
      });
    },
  };
}

/** The single-clue wire body: `{ clue_understood, candidates: [...] }`. */
export function singleBody(
  answers: ReadonlyArray<[string, number]>,
  clueUnderstood = 0.9,
  notes?: string,
): string {
  return JSON.stringify({
    clue_understood: clueUnderstood,
    candidates: answers.map(([answer, confidence]) => ({ answer, confidence })),
    ...(notes === undefined ? {} : { notes }),
  });
}

/** The batched wire body: `{ results: [{ id, clue_understood, candidates }] }`. */
export function batchedBody(
  byId: ReadonlyArray<[string, ReadonlyArray<[string, number]>]>,
  clueUnderstood = 0.9,
): string {
  return JSON.stringify({
    results: byId.map(([id, answers]) => ({
      id,
      clue_understood: clueUnderstood,
      candidates: answers.map(([answer, confidence]) => ({ answer, confidence })),
    })),
  });
}
