import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from '../util/fs.js';
import type { ModelCapabilities, ModelLimits, ModelPricing } from './types.js';

/**
 * The shape of one entry in `models.json`, trimmed to the fields this module
 * reads. `tsconfig.json` has `resolveJsonModule: false`, so the catalogue is
 * read with `readFileSync` + `JSON.parse` rather than imported.
 */
interface RawModelEntry {
  id: string;
  pricing: {
    prompt: string;
    completion: string;
    request: string;
  };
  per_request_limits: {
    requests_per_minute: number;
    tokens_per_minute: number;
    burst_ratio: number;
  };
  supported_features: string[];
  supported_sampling_parameters: string[];
}

interface RawCatalogue {
  data: RawModelEntry[];
}

/** One parsed, ready-to-use catalogue row (T8's deliverable: a `Map<string, ModelEntry>`). */
export interface ModelEntry {
  id: string;
  pricing: ModelPricing;
  limits: ModelLimits;
  capabilities: ModelCapabilities;
}

/** Memoised per path, so repeated calls (and repeated `entryFor` lookups) never re-read the file. */
const catalogueCache = new Map<string, Map<string, ModelEntry>>();

function defaultCataloguePath(): string {
  return join(repoRoot(), 'models.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads and shapes `models.json` (or a substitute catalogue, such as the
 * `test/fixtures/models.min.json` fixture) into the map every other
 * function in this module looks up. Capability flags are derived generically
 * from `supported_features` (B9, B38) - never from the model id - so a new
 * model family needs no code change here.
 */
function parseCatalogue(path: string): Map<string, ModelEntry> {
  const text = readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
    throw new Error(`malformed model catalogue at ${path}: expected a { data: [...] } object`);
  }
  const raw = parsed as unknown as RawCatalogue;

  const entries = new Map<string, ModelEntry>();
  for (const model of raw.data) {
    const features = new Set(model.supported_features);
    entries.set(model.id, {
      id: model.id,
      pricing: {
        prompt: model.pricing.prompt,
        completion: model.pricing.completion,
        request: model.pricing.request,
      },
      limits: {
        requestsPerMinute: model.per_request_limits.requests_per_minute,
        tokensPerMinute: model.per_request_limits.tokens_per_minute,
        burstRatio: model.per_request_limits.burst_ratio,
      },
      capabilities: {
        supportsStructuredOutputs: features.has('structured_outputs'),
        supportsReasoning: features.has('reasoning'),
        supportsSeed: features.has('seed'),
        supportedSamplingParameters: [...model.supported_sampling_parameters],
      },
    });
  }
  return entries;
}

/**
 * Loads a model catalogue into a `Map<string, ModelEntry>`, memoised per
 * path so the file is parsed once no matter how many times it is asked for.
 * Defaults to the repo-root `models.json`; tests inject an alternate path
 * (e.g. `test/fixtures/models.min.json`) so they do not break when
 * `models.json` is refreshed.
 */
export function loadPricing(path: string = defaultCataloguePath()): Map<string, ModelEntry> {
  const cached = catalogueCache.get(path);
  if (cached !== undefined) return cached;
  const loaded = parseCatalogue(path);
  catalogueCache.set(path, loaded);
  return loaded;
}

function entryFor(model: string, path?: string): ModelEntry {
  const catalogue = loadPricing(path);
  const entry = catalogue.get(model);
  if (entry === undefined) {
    throw new Error(`unknown model id (absent from the catalogue): "${model}"`);
  }
  return entry;
}

/** T8: loads `models.json` once. A missing model id is a startup error. */
export function priceOf(model: string, path?: string): ModelPricing {
  return entryFor(model, path).pricing;
}

/** Drives transport selection by capability, never by model name (B9). */
export function capabilitiesOf(model: string, path?: string): ModelCapabilities {
  return entryFor(model, path).capabilities;
}

export function limitsOf(model: string, path?: string): ModelLimits {
  return entryFor(model, path).limits;
}

export interface UsdInput {
  model: string;
  promptTokens: number;
  completionTokens: number;
  calls: number;
  /** Test-only override; production callers omit this and get the real catalogue. */
  path?: string;
}

/**
 * B29. Integer token counts in, USD out, computed once at write time:
 * `Math.round(1e9 * (prompt * p.prompt + completion * p.completion + calls * p.request)) / 1e9`.
 * Reasoning tokens are billed as completion tokens by the caller before this
 * is called (they are accumulated into `completionTokens`), and logged
 * separately in `TokenUsage.reasoningTokens`.
 */
export function usdFor(input: UsdInput): number {
  const p = priceOf(input.model, input.path);
  const raw =
    input.promptTokens * Number(p.prompt) +
    input.completionTokens * Number(p.completion) +
    input.calls * Number(p.request);
  return Math.round(1e9 * raw) / 1e9;
}
