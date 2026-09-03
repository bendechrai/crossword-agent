import { notImplemented } from '../util/errors.js';
import type { CandidateRequest } from '../candidates/types.js';
import type { Profile } from '../profiles/schema.js';
import type { LlmRequest } from './types.js';

/**
 * The provider parameter that turns reasoning off (or down to minimal) for a
 * `reasoning`-capable model on a seed call (B41). The exact name is discovered
 * by T49 against the live API; until then this placeholder is what the router
 * emits, and the unit test pins the conditions rather than the name.
 *
 * TODO(T49): replace with the parameter Nebius actually accepts.
 */
export const REASONING_OFF_PARAM = 'reasoning_effort';

export interface RoutedRequest {
  request: LlmRequest;
  model: string;
  /** True when the schema has to go in the prompt instead of `response_format`. */
  inlineSchema: boolean;
}

/**
 * T32 (B9): maps `req.tier` to the profile's model id and picks the transport
 * form by advertised capability, never by model name.
 */
export function route(_req: CandidateRequest, _profile: Profile): RoutedRequest {
  return notImplemented('src/llm/tierRouter.ts');
}
