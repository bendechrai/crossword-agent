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
 * The provider parameter that turns reasoning off for a `reasoning`-capable
 * model on a seed call (B41), discovered against the live Nebius API by T49
 * (see docs/spikes/tier1-reliability.md section 1). Nebius's own request
 * validator confirms the accepted literal values on a 422 for a bad one:
 * `"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`; `"none"`
 * is the one T49 measured actually drives `reasoningTokens` to 0 (the others
 * either error, per REASONING_OFF_VALUE's neighbours, or leave reasoning on).
 */
export const REASONING_OFF_PARAM = 'reasoning_effort';

/**
 * The value that measurably disables reasoning for this parameter (T49): with
 * this applied, `reasoningTokens` dropped from 512 to 0 on the model under
 * test, and `completionTokens` (which reasoning tokens are folded into for
 * billing, B29) dropped from 1024 (the full sampling.maxTokens budget spent
 * on chain-of-thought, leaving no room for the JSON answer) to 73.
 */
export const REASONING_OFF_VALUE = 'none';

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
 * `schemas/candidate-response.schema.json`, read once and memoised (same
 * pattern as `llm/parser.ts`), for `response_format.json_schema` (spec:
 * "Candidate service" step 2).
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
 * The name `response_format.json_schema.name` (T49, docs/spikes/tier1-reliability.md
 * section 2): Nebius's request validator rejects the schema document sent
 * directly as `json_schema` (missing required field `name`), and accepts it
 * once wrapped as `{ name, schema, strict }`. Nothing in the spec or B9 names
 * this value; "candidate_response" is simply a stable, descriptive schema
 * name, not a value the provider assigns meaning to beyond "present".
 */
const RESPONSE_FORMAT_SCHEMA_NAME = 'candidate_response';

/**
 * `response_format.json_schema` in the wire shape Nebius actually accepts
 * (T49): `{ name, schema, strict }`, not the bare schema document. `strict`
 * is included because nothing in T49's spike suggested a reason to omit it
 * (a stricter server-side check of the model's own output, which only helps
 * `llm/parser.ts`'s job), and Nebius's validator raised no complaint about it.
 */
function candidateResponseFormat(): { type: 'json_schema'; json_schema: unknown } {
  return {
    type: 'json_schema',
    json_schema: {
      name: RESPONSE_FORMAT_SCHEMA_NAME,
      schema: candidateResponseSchema(),
      strict: true,
    },
  };
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
    extra[REASONING_OFF_PARAM] = REASONING_OFF_VALUE;
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
    ...(inlineSchema ? {} : { responseFormat: candidateResponseFormat() }),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };

  return { request, model, inlineSchema };
}
