import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';

import type { CandidateResponse } from '../candidates/types.js';
import { repoRoot } from '../util/fs.js';

export interface ParseOptions {
  batchSize: number;
  /** Slot ids expected back; a batched response is realigned by these. */
  expectedIds: string[];
}

export interface ParseFailure {
  /** null when the whole response was unusable. */
  id: string | null;
  error: string;
}

export interface ParseWarning {
  /** null when the warning is not attributable to one clue. */
  id: string | null;
  warning: string;
}

export interface ParseOutcome {
  byId: Map<string, CandidateResponse>;
  failures: ParseFailure[];
  /** Recoverable oddities (a defaulted `clue_understood`, say): not failures. */
  warnings: ParseWarning[];
  /** The substring that was actually parsed, for the inference log. */
  rawUsed: string;
}

/** Only the parts of schemas/candidate-response.schema.json this module needs. */
interface CandidateResponseSchemaFile {
  $schema: string;
  $defs: Record<string, unknown>;
}

/** A model's `reasoning_content`, with the comma that separated it (B41). */
const REASONING_CONTENT =
  /(,)?\s*"reasoning_content"\s*:\s*(?:"(?:\\[\s\S]|[^"\\])*"|null)\s*(,)?/g;
const THINK_BLOCK = /<think\b[^>]*>[\s\S]*?<\/think\s*>/gi;
/** A reasoning block the model never closed: everything after it is thinking. */
const DANGLING_THINK_OPEN = /<think\b[^>]*>[\s\S]*$/i;
/** Providers that emit only the closing tag: everything before it is thinking. */
const ORPHAN_THINK_CLOSE = /^[\s\S]*<\/think\s*>/i;
const CODE_FENCE = /```[a-zA-Z0-9_+-]*/g;

function buildValidators() {
  const path = join(repoRoot(), 'schemas', 'candidate-response.schema.json');
  const schema = JSON.parse(readFileSync(path, 'utf8')) as CandidateResponseSchemaFile;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const compileRef = (ref: string) =>
    ajv.compile({ $schema: schema.$schema, $defs: schema.$defs, $ref: ref });
  return {
    ajv,
    single: compileRef('#/$defs/single'),
    batchedResult: compileRef('#/$defs/batchedResult'),
  };
}

let validators: ReturnType<typeof buildValidators> | null = null;

/** Compiled once per process, on first use, so importing this module is cheap. */
function schemaValidators(): ReturnType<typeof buildValidators> {
  validators ??= buildValidators();
  return validators;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * B41, in order: drop `<think>` blocks and any `reasoning_content` field, then
 * drop code fences, leaving text whose last balanced object is the answer.
 */
function stripNonAnswerText(raw: string): string {
  let text = raw.replace(THINK_BLOCK, '\n');
  text = text.replace(DANGLING_THINK_OPEN, '\n');
  if (/<\/think\s*>/i.test(text)) text = text.replace(ORPHAN_THINK_CLOSE, '\n');
  text = text.replace(
    REASONING_CONTENT,
    // Keep one comma only when the field sat between two other properties.
    (_match: string, before: string | undefined, after: string | undefined) =>
      before !== undefined && after !== undefined ? ',' : '',
  );
  return text.replace(CODE_FENCE, '');
}

interface ScanResult {
  /** The last balanced top-level object, or null when there is none. */
  text: string | null;
  error: string;
}

/**
 * A brace counter that respects string literals and escapes, not a regex.
 * Quotes are only significant inside an object, so prose punctuation around
 * the answer cannot open a phantom string. The LAST complete top-level object
 * wins (B41): a reasoning-capable model often emits a draft before its answer.
 */
function findLastBalancedObject(text: string): ScanResult {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  let lastStart = -1;
  let lastEnd = -1;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (depth > 0 && ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        lastStart = start;
        lastEnd = i + 1;
      }
    }
  }

  if (lastEnd > 0) return { text: text.slice(lastStart, lastEnd), error: '' };
  if (depth > 0) {
    return {
      text: null,
      error: `unbalanced brace: ${depth} unclosed "{" (the outermost at offset ${start}); the response looks truncated`,
    };
  }
  return { text: null, error: 'no JSON object found in the response' };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `clue_understood` is a routing signal, not an answer, so its absence costs a
 * warning and a default of 0 rather than the whole element.
 */
function withDefaultedUnderstood(
  record: Record<string, unknown>,
  id: string | null,
  warnings: ParseWarning[],
): Record<string, unknown> {
  if (record['clue_understood'] !== undefined) return record;
  warnings.push({ id, warning: 'clue_understood missing; defaulted to 0' });
  return { ...record, clue_understood: 0 };
}

/** Post-validation narrowing: ajv has already proved the shape. */
function toResponse(record: Record<string, unknown>): CandidateResponse {
  const response: CandidateResponse = {
    clue_understood: record['clue_understood'] as number,
    candidates: record['candidates'] as Array<{ answer: string; confidence: number }>,
  };
  const notes = record['notes'];
  if (typeof notes === 'string') response.notes = notes;
  return response;
}

function parseSingle(
  parsed: Record<string, unknown>,
  expectedIds: string[],
  outcome: ParseOutcome,
): void {
  const id = expectedIds[0] ?? null;
  if (id === null || expectedIds.length > 1) {
    outcome.failures.push({
      id: null,
      error: `expected a batched response with "results" for ${expectedIds.length} clues, got the single-clue form`,
    });
    return;
  }
  const { ajv, single } = schemaValidators();
  const record = withDefaultedUnderstood(parsed, id, outcome.warnings);
  if (!single(record)) {
    outcome.failures.push({ id, error: ajv.errorsText(single.errors, { dataVar: 'response' }) });
    return;
  }
  outcome.byId.set(id, toResponse(record));
}

function parseBatched(
  results: unknown[],
  expectedIds: string[],
  outcome: ParseOutcome,
): void {
  const { ajv, batchedResult } = schemaValidators();
  const expected = new Set(expectedIds);

  results.forEach((element, index) => {
    const where = `results[${index}]`;
    if (!isRecord(element)) {
      outcome.failures.push({ id: null, error: `${where} is not an object` });
      return;
    }
    const rawId = element['id'];
    const id = typeof rawId === 'string' && rawId.length > 0 ? rawId : null;
    if (id === null) {
      outcome.failures.push({ id: null, error: `${where} has no usable "id"` });
      return;
    }
    const record = withDefaultedUnderstood(element, id, outcome.warnings);
    if (!batchedResult(record)) {
      outcome.failures.push({
        id,
        error: `${where}: ${ajv.errorsText(batchedResult.errors, { dataVar: 'result' })}`,
      });
      return;
    }
    // An id nobody asked for is reported, never silently dropped, so the batch
    // bench can count it.
    if (!expected.has(id)) {
      outcome.failures.push({ id, error: 'unexpected id' });
      return;
    }
    if (outcome.byId.has(id)) {
      outcome.failures.push({ id, error: 'duplicate id' });
      return;
    }
    outcome.byId.set(id, toResponse(record));
  });

  for (const id of expectedIds) {
    if (outcome.byId.has(id)) continue;
    if (outcome.failures.some((failure) => failure.id === id)) continue;
    outcome.failures.push({ id, error: 'missing' });
  }
}

/**
 * T11. Order of operations: strip `reasoning_content` and any `<think>` block
 * (B41), strip code fences, take the LAST balanced JSON object, then
 * ajv-validate. A batched response is validated element by element and
 * realigned by `id`, never by position.
 *
 * Never throws, never retries and never touches the network: a retry at
 * temperature 0 is the candidate service's decision (T34), and normalising the
 * answers is T6's job, so answers come back exactly as the model wrote them.
 */
export function parseCandidateResponse(raw: string, opts: ParseOptions): ParseOutcome {
  const outcome: ParseOutcome = {
    byId: new Map<string, CandidateResponse>(),
    failures: [],
    warnings: [],
    rawUsed: '',
  };

  const scan = findLastBalancedObject(stripNonAnswerText(raw));
  if (scan.text === null) {
    outcome.failures.push({ id: null, error: scan.error });
    return outcome;
  }
  outcome.rawUsed = scan.text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(scan.text) as unknown;
  } catch (error) {
    outcome.failures.push({ id: null, error: `invalid JSON: ${messageOf(error)}` });
    return outcome;
  }

  if (!isRecord(parsed)) {
    outcome.failures.push({ id: null, error: 'the parsed value is not a JSON object' });
    return outcome;
  }

  const results = parsed['results'];
  if (Array.isArray(results)) {
    parseBatched(results as unknown[], opts.expectedIds, outcome);
  } else {
    parseSingle(parsed, opts.expectedIds, outcome);
  }
  return outcome;
}
