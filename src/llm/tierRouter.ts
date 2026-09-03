import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CandidateRequest } from '../candidates/types.js';
import type { Profile } from '../profiles/schema.js';
import { repoRoot } from '../util/fs.js';
import { log } from '../util/log.js';
import { capabilitiesOf } from './pricing.js';
import { getLimiter } from './rateLimiter.js';
import type { LlmRequest } from './types.js';

/**
 * The provider parameter that turns reasoning off (or down to minimal) for a
 * `reasoning`-capable model on a seed call (B41). The exact name is discovered
 * by T49 against the live API; until then this placeholder is what the router
 * emits, and the unit test pins the conditions rather than the name.
 *
 * TODO(T49): replace with the parameter Nebius actually accepts, and with
 * whatever value it expects - `true` below is a placeholder that only proves
 * the branch fired, not a guess at real wire semantics.
 */
export const REASONING_OFF_PARAM = 'reasoning_effort';

export interface RoutedRequest {
  request: LlmRequest;
  model: string;
  /** True when the schema has to go in the prompt instead of `response_format`. */
  inlineSchema: boolean;
}

export interface RouteOptions {
  /**
   * `xw solve --seed <n>` (B38). Forwarded to the provider only when the
   * catalogue advertises `seed` for the routed model; otherwise dropped.
   * Not part of `CandidateRequest` or `Profile` (neither carries it), so it
   * is threaded in here as an optional extra argument.
   */
  seed?: number;
}

/**
 * Only the parts of `schemas/candidate-response.schema.json` this module
 * needs to embed verbatim in `response_format.json_schema` (spec: "Candidate
 * service" step 2). Read once and memoised, same pattern as `llm/parser.ts`.
 */
let cachedCandidateResponseSchema: unknown;

function candidateResponseSchema(): unknown {
  if (cachedCandidateResponseSchema === undefined) {
    const path = join(repoRoot(), 'schemas', 'candidate-response.schema.json');
    cachedCandidateResponseSchema = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  }
  return cachedCandidateResponseSchema;
}

/**
 * `profile.sampling.topP` maps to the catalogue's `top_p` parameter name
 * (B22). `temperature` and `maxTokens` are required fields on `LlmRequest`
 * (every model needs some form of both), so there is nothing to gate there;
 * `topP` is the one optional sampling field a model can lack support for.
 */
const TOP_P_PARAM_NAME = 'top_p';

/**
 * T32 (B9): maps `req.tier` to the profile's model id and picks the transport
 * form by advertised capability, never by model name.
 */
export function route(req: CandidateRequest, profile: Profile, opts: RouteOptions = {}): RoutedRequest {
  const model = req.tier === 1 ? profile.tier1 : profile.tier2;
  const capabilities = capabilitiesOf(model);

  // `getLimiter` (T9) is a process-wide singleton keyed by model id, and it
  // ignores its `opts` on every call after the first for that model. This
  // call must therefore be the one that creates it with this tier's final
  // `maxConcurrency`, or a later caller touching the same model first would
  // permanently fix the wrong concurrency ceiling for it.
  getLimiter(model, {
    rpsFraction: profile.rateLimit.rpsFraction,
    maxConcurrency: req.tier === 1 ? profile.rateLimit.maxConcurrencyTier1 : profile.rateLimit.maxConcurrencyTier2,
  });

  const supportedSampling = new Set(capabilities.supportedSamplingParameters);

  let topP = profile.sampling.topP;
  if (topP !== undefined && !supportedSampling.has(TOP_P_PARAM_NAME)) {
    log.debug(
      `tierRouter: dropping unsupported sampling parameter "${TOP_P_PARAM_NAME}" for model "${model}"`,
    );
    topP = undefined;
  }

  const extra: Record<string, unknown> = {};
  // B41: reasoning-off is sent only for `purpose: 'seed'`, never for reask,
  // escalate or repair, where reasoning may help.
  if (capabilities.supportsReasoning && req.purpose === 'seed') {
    extra[REASONING_OFF_PARAM] = true;
  }
  // B38: `--seed` reaches the provider only when the catalogue advertises it.
  if (capabilities.supportsSeed && opts.seed !== undefined) {
    extra['seed'] = opts.seed;
  }

  const inlineSchema = !capabilities.supportsStructuredOutputs;

  const request: LlmRequest = {
    model,
    // Rendered from `req` by `llm/prompts.ts` (T31); out of scope for this
    // router (Deliverable: "the prompts themselves (T31)"). The candidate
    // service (T34, which reads both modules) fills this in before the
    // request reaches the transport.
    messages: [],
    temperature: profile.sampling.temperature,
    maxTokens: profile.sampling.maxTokens,
    ...(topP !== undefined ? { topP } : {}),
    ...(inlineSchema
      ? {}
      : { responseFormat: { type: 'json_schema', json_schema: candidateResponseSchema() } }),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };

  return { request, model, inlineSchema };
}
