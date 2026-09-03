import { notImplemented } from '../util/errors.js';
import type { ModelCapabilities, ModelLimits, ModelPricing } from './types.js';

export interface UsdInput {
  model: string;
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

/** T8: loads `models.json` once. A missing model id is a startup error. */
export function priceOf(_model: string): ModelPricing {
  return notImplemented('src/llm/pricing.ts');
}

/** Drives transport selection by capability, never by model name (B9). */
export function capabilitiesOf(_model: string): ModelCapabilities {
  return notImplemented('src/llm/pricing.ts');
}

export function limitsOf(_model: string): ModelLimits {
  return notImplemented('src/llm/pricing.ts');
}

/**
 * B29. Integer token counts in, USD out, computed once at write time:
 * `Math.round(1e9 * (prompt * p.prompt + completion * p.completion + calls * p.request)) / 1e9`.
 */
export function usdFor(_input: UsdInput): number {
  return notImplemented('src/llm/pricing.ts');
}
