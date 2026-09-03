import { notImplemented } from '../util/errors.js';
import type { CandidateRequest, PromptKind } from '../candidates/types.js';
import type { LlmMessage } from './types.js';

/**
 * Frozen at "1" for all of v1. T31 is the single owner of this constant, and a
 * bump lands with the regenerated cache and snapshots in one commit (B49).
 */
export const PROMPT_VERSION = '1';

export interface RenderOptions {
  /** True when the model has no structured-output mode: inline the schema (B9). */
  inlineSchema: boolean;
}

export interface RenderedPrompt {
  promptKind: PromptKind;
  messages: LlmMessage[];
}

/** T31: one clue. `constrained` is rendered for both re-ask and repair. */
export function renderPrompt(
  _req: CandidateRequest,
  _kind: PromptKind,
  _opts: RenderOptions,
): RenderedPrompt {
  return notImplemented('src/llm/prompts.ts');
}

/** The batched seed form (B3): `{ clues: [...] }` in, `{ results: [...] }` back. */
export function renderBatchedSeedPrompt(
  _reqs: ReadonlyArray<CandidateRequest>,
  _opts: RenderOptions,
): RenderedPrompt {
  return notImplemented('src/llm/prompts.ts');
}
