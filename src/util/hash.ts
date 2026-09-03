import { createHash } from 'node:crypto';

import type { CrossingContextEntry, PromptKind, RejectedAnswer } from '../candidates/types.js';
import type { PuzzleStyle } from '../puzzle/types.js';

/**
 * Every field that can change the bytes of the prompt or the sampling
 * parameters, and nothing else (B23). Policy fields - escalation policy,
 * ordering, LDS limits, budgets - stay out, because they never change the text
 * sent to the model, which is what makes two profiles share a cache.
 *
 * The declaration order below is B23's order.
 */
export interface CacheKeyInput {
  model: string;
  promptVersion: string;
  promptKind: PromptKind;
  clue: string;
  enumeration?: string;
  length: number;
  pattern: string;
  style: PuzzleStyle;
  title?: string;
  n: number;
  samples: number;
  sampleIndex: number;
  batchSize: number;
  /** Sorted before hashing, so ordering never changes the key. */
  rejected: ReadonlyArray<RejectedAnswer>;
  /** Normalised, or null when absent. */
  crossingContext?: ReadonlyArray<CrossingContextEntry> | null;
  temperature: number;
  topP?: number;
  maxTokens: number;
}

/**
 * JSON with recursively sorted object keys, no incidental whitespace, and
 * `undefined` fields dropped. Canonical because a joined string has a
 * separator-collision problem that this does not.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value)) ?? 'null';
}

function canonicalise(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value === undefined ? null : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => (v === undefined ? null : canonicalise(v)));
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const v = source[key];
    if (v === undefined) continue;
    out[key] = canonicalise(v);
  }
  return out;
}

export function sha1(s: string): string {
  return createHash('sha1').update(s, 'utf8').digest('hex');
}

/** Rejections sorted by answer then reason, so the caller's order is irrelevant. */
function normaliseRejected(rejected: ReadonlyArray<RejectedAnswer>): RejectedAnswer[] {
  return [...rejected]
    .map((r) => ({ answer: r.answer, reason: r.reason }))
    .sort((a, b) => (a.answer === b.answer ? cmp(a.reason, b.reason) : cmp(a.answer, b.answer)));
}

/** Crossing context sorted by slot id, reduced to the four fields it carries. */
function normaliseCrossingContext(
  entries: ReadonlyArray<CrossingContextEntry> | null | undefined,
): CrossingContextEntry[] | null {
  if (entries === null || entries === undefined) return null;
  return [...entries]
    .map((e) => ({ slotId: e.slotId, clue: e.clue, fill: e.fill, confidence: e.confidence }))
    .sort((a, b) => cmp(a.slotId, b.slotId));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The B23 cache key: `sha1(canonicalJson({ ...prompt-visible fields }))`. */
export function cacheKey(input: CacheKeyInput): string {
  return sha1(canonicalJson(cacheKeyFields(input)));
}

/**
 * The object that gets hashed. A disk cache entry stores it as `keyFields`, so
 * a cache file is self-describing.
 */
export function cacheKeyFields(input: CacheKeyInput): Record<string, unknown> {
  return {
    model: input.model,
    promptVersion: input.promptVersion,
    promptKind: input.promptKind,
    clue: input.clue,
    enumeration: input.enumeration,
    length: input.length,
    pattern: input.pattern,
    style: input.style,
    title: input.title,
    n: input.n,
    samples: input.samples,
    sampleIndex: input.sampleIndex,
    batchSize: input.batchSize,
    rejected: normaliseRejected(input.rejected),
    crossingContext: normaliseCrossingContext(input.crossingContext),
    temperature: input.temperature,
    topP: input.topP,
    maxTokens: input.maxTokens,
  };
}
