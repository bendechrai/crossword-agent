import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CandidateRequest } from '../candidates/types.js';
import { reasoningOf, type Profile, type ReasoningEffort } from '../profiles/schema.js';
import { repoRoot } from '../util/fs.js';
import { log } from '../util/log.js';
import { capabilitiesOf } from './pricing.js';
import { promptKindFor } from './prompts.js';
import { getLimiter } from './rateLimiter.js';
import type { LlmRequest } from './types.js';

/**
 * The provider parameter that turns reasoning off for a `reasoning`-capable
 * model (B41 as amended by T58 - see `route` below for the gate), discovered
 * against the live Nebius API by T49
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

/**
 * T68 (docs/plan.md "Router: per-model reasoning-off value with a fallback
 * for providers that reject none"): `REASONING_OFF_VALUE` ("none") is not
 * universally accepted. `openai/gpt-oss-120b` uses OpenAI's Harmony response
 * format, whose reasoning levels are `low` | `medium` | `high` only - there
 * is no `none` - so Nebius rejects `{"reasoning_effort":"none"}` for it with
 * `HTTP 400: Harmony does not support reasoning_effort='none'`. Keyed by
 * model id (never inferred from the id string, per B9's "by capability, not
 * by model name" rule elsewhere in this file - the value here is looked up,
 * not pattern-matched); a model absent from this table gets
 * `REASONING_OFF_VALUE`. See `reasoningOffValueFor` below and
 * `src/llm/client.ts`'s 400 retry path, which is the runtime fallback for a
 * Harmony-format model that is not yet listed here.
 */
const REASONING_OFF_VALUE_OVERRIDES: Readonly<Record<string, string>> = {
  'openai/gpt-oss-120b': 'low',
};

/**
 * The reasoning-off value to send for `model`: the per-model override when
 * one is known, otherwise `REASONING_OFF_VALUE` ("none").
 */
export function reasoningOffValueFor(model: string): string {
  return REASONING_OFF_VALUE_OVERRIDES[model] ?? REASONING_OFF_VALUE;
}

/**
 * The `reasoning_effort` value to send for `model` when the profile asks for
 * `requested` (T71).
 *
 * `'none'` means "reasoning off", so it goes through
 * `reasoningOffValueFor`'s per-model override table - that table exists
 * precisely because `"none"` is the value some providers reject. Every other
 * value is passed through unchanged: `low`, `medium` and `high` are the three
 * levels OpenAI's Harmony format defines and are accepted by every
 * reasoning-capable model in the catalogue, so an override would only be
 * substituting one valid request for another.
 */
export function reasoningEffortFor(model: string, requested: ReasoningEffort): string {
  return requested === 'none' ? reasoningOffValueFor(model) : requested;
}

/**
 * Whether `req` renders the constrained or escalate template - a re-ask, a
 * repair ask or an escalation - rather than the seed template. Derived from
 * `promptKindFor` rather than from a second list of purposes, so the router
 * and `llm/prompts.ts` can never disagree about what a "constrained call" is.
 */
function isConstrainedCall(req: CandidateRequest): boolean {
  return promptKindFor(req.purpose) !== 'seed';
}

export interface RoutedRequest {
  request: LlmRequest;
  model: string;
  /** True when the schema has to go in the prompt instead of `response_format`. */
  inlineSchema: boolean;
  /**
   * The reasoning effort this request asks the model to spend, when the
   * profile's `reasoning.constrainedEffort` engaged for it (T71), and `null`
   * on every other call - including a call carrying the reasoning-*off*
   * value, which is what the router has always sent and so is not a new
   * cache-key input.
   *
   * `candidates/service.ts` folds a non-null value into the B23 cache key:
   * two efforts are two different answers to the same question, and
   * `max_tokens` (already a key field) does not separate them on its own,
   * since `reasoning.constrainedMaxTokens` is one number for every effort.
   */
  constrainedReasoningEffort: string | null;
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
 * Whether this request gets the reasoning-off parameter, for a model that
 * advertises `reasoning` at all (the capability check is the caller's).
 *
 * B41 originally gated this on `purpose === 'seed'` alone, on the reasoning
 * that chain-of-thought buys nothing when listing ten six-letter answers but
 * might help a re-ask or an escalation. T58 supersedes that clause **for tier
 * 1**, because the measurement says the opposite: T50's live inference log
 * (docs/build-notes/wave-4.md, "T50 determinism fix") shows 2034 of 2039
 * tier-1 `repair` records and 74 of 74 tier-1 `reask` records with reasoning
 * on spending the entire `sampling.maxTokens` budget on chain-of-thought
 * (`reasoningTokens: 512`, `completionTokens: 1024`) and emitting no JSON at
 * all, so `llm/parser.ts` failed with "no JSON object found" on essentially
 * every one of them. A non-seed tier-1 call with reasoning left on is not a
 * better answer, it is no answer: the re-ask and repair phases were dead on
 * tier 1, and (since `candidates/service.ts` never caches a parse failure)
 * those keys could never enter the committed cache either.
 *
 * Tier 2 keeps B41's original gate. Tier 2 is the escalation model, it is
 * reached only for the clues tier 1 could not settle, its
 * `structured_outputs` mode constrains the answer shape independently of
 * reasoning, and nothing has been measured there that would justify turning
 * its reasoning off - T58's deliverable is scoped to tier 1 for exactly that
 * reason. A tier-2 *seed* call (only reachable through a profile that puts
 * the escalation model in the seed role) keeps the parameter, since that is
 * the case B41 measured.
 */
function reasoningOffApplies(req: CandidateRequest): boolean {
  return req.tier === 1 || req.purpose === 'seed';
}

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

  // T71: a constrained call (re-ask, repair, escalate) under a profile that
  // asks for reasoning on those calls is the one case where the parameter
  // carries a real effort rather than the off value, and the one case where
  // the token budget moves: `sampling.maxTokens` is sized for a seed ask's
  // JSON, and a model that thinks needs room for both. Gated on the model
  // advertising `reasoning` like every other use of the parameter (B9), so a
  // non-reasoning model gets neither the parameter nor the raised budget.
  const reasoning = reasoningOf(profile);
  const constrainedReasoning =
    capabilities.supportsReasoning &&
    reasoning.constrainedEffort !== 'none' &&
    isConstrainedCall(req)
      ? reasoningEffortFor(model, reasoning.constrainedEffort)
      : null;

  const extra: Record<string, unknown> = {};
  if (constrainedReasoning !== null) {
    extra[REASONING_OFF_PARAM] = constrainedReasoning;
  } else if (capabilities.supportsReasoning && reasoningOffApplies(req)) {
    extra[REASONING_OFF_PARAM] = reasoningOffValueFor(model);
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
    maxTokens:
      constrainedReasoning === null ? profile.sampling.maxTokens : reasoning.constrainedMaxTokens,
    ...(topP !== undefined ? { topP } : {}),
    ...(inlineSchema ? {} : { responseFormat: candidateResponseFormat() }),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };

  return { request, model, inlineSchema, constrainedReasoningEffort: constrainedReasoning };
}
