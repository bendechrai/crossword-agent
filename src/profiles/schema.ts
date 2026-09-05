import { z } from 'zod';

import { PAIRED_PROMPT_VERSION } from '../llm/prompts.js';

/**
 * The raw object schema, exported separately from the refined one so that
 * profile resolution (T23) can take partials of it. `ProfileSchema` is what
 * everything else validates against.
 *
 * Nested groups use `.prefault({})` rather than the spec's `.default({})`:
 * under zod 4 a `.default()` must be the fully populated output object, while
 * `.prefault()` feeds `{}` through the group's own field defaults, which is
 * the behaviour the spec is describing.
 */
export const ProfileObject = z.object({
  name: z.string(),
  // T69: the puzzle-level bench (docs/benches/model-comparison.md) found
  // deepseek-ai/DeepSeek-V4-Flash-0731 beats the prior default
  // (nvidia/Nemotron-3_5-Lightning) on letters accuracy on the american
  // stratum (0.80 vs 0.58) at about half the cost per puzzle, winning 24
  // of 24 paired repeats; see also docs/benches/recall-screen.md. The old
  // model stays selectable by writing tier1 explicitly in a profile file.
  tier1: z.string().default('deepseek-ai/DeepSeek-V4-Flash-0731'),
  tier2: z.string().default('deepseek-ai/DeepSeek-V4-Pro'),
  candidatesPerAsk: z.number().int().min(1).max(25).default(10),
  calibration: z.enum(['rank', 'votes', 'blend']).default('rank'),
  samples: z.number().int().min(1).max(5).default(1),
  batchSize: z.number().int().min(1).max(8).default(1),
  reasksPerSlot: z.number().int().min(0).default(2),
  /**
   * T71. How many constrained-template requests (re-ask, repair, escalate)
   * the candidate service makes per slot, whose accepted answers are then
   * merged by vote (`candidates/service.ts`). 1 is one request, which is
   * every profile's behaviour before T71. Seed asks are never sampled here:
   * `samples` above, with `calibration: 'votes'`, is the seed-pass knob
   * (M6, T53).
   *
   * Optional rather than `.default(1)`, like `reasoning` below and for the
   * same reason: see the note on that field.
   */
  constrainedSamples: z.number().int().min(1).max(5).optional(),
  /**
   * T71. Reasoning on the constrained and escalate templates, which is the
   * one place the literature expects it to pay: CrossWordBench (2025, see
   * docs/crossword-algorithms.md) reports that reasoning models improve as
   * more crossing letters are supplied while non-reasoning models do not, so
   * a re-ask carrying fixed letters is exactly the call worth thinking
   * about - and a seed ask, which lists ten answers for an empty pattern,
   * is not (T49/T58 measured chain-of-thought there spending the whole
   * completion budget before emitting any JSON).
   *
   * `constrainedEffort: 'none'` is off, which is every profile's behaviour
   * before T71: the router keeps sending the reasoning-*off* value on the
   * calls that already got it and nothing on the calls that did not.
   * Anything else is sent as `reasoning_effort` on those calls (through the
   * same per-model override table, `llm/tierRouter.ts`) and raises that
   * call's `max_tokens` to `constrainedMaxTokens`, because a model that
   * thinks needs room to think and still emit the JSON.
   *
   * This group and `constrainedSamples` are the only two optional members of
   * a `Profile`, deliberately. `schemas/run-record.schema.json` closes the
   * run record's profile object with `additionalProperties: false`, and
   * `test/contract/schemas.test.ts` types a complete `Profile` literal;
   * both are frozen contracts, so a field every resolved profile carried
   * would break them. Absent therefore means "the documented default", and
   * `reasoningOf()` / `constrainedSamplesOf()` below are the single place
   * that substitution happens - no caller reads either field directly.
   */
  reasoning: z
    .object({
      constrainedEffort: z.enum(['none', 'low', 'medium', 'high']).default('none'),
      constrainedMaxTokens: z.number().int().min(64).max(32_768).default(2048),
    })
    .optional(),
  sampling: z
    .object({
      temperature: z.number().min(0).max(2).default(0.2),
      topP: z.number().min(0).max(1).optional(),
      maxTokens: z.number().int().min(64).max(4096).default(512),
    })
    .prefault({}),
  escalation: z
    .object({
      policy: z.enum(['reask-first', 'eager', 'patient']).default('reask-first'),
      clueUnderstoodThreshold: z.number().default(0.4),
      maxTier2CallsPerPuzzle: z.number().int().default(15),
      escalationsPerSlot: z.number().int().default(1),
    })
    .prefault({}),
  search: z
    .object({
      ordering: z.enum(['margin', 'mrv']).default('margin'),
      ldsLimitStart: z.number().int().default(0),
      ldsLimitMax: z.number().int().default(3),
      maxBacktracks: z.number().int().default(200),
    })
    .prefault({}),
  repair: z
    .object({
      enabled: z.boolean().default(true),
      maxCalls: z.number().int().default(30),
      maxEditDistance: z.number().int().min(1).max(2).default(2),
    })
    .prefault({}),
  budget: z
    .object({
      usd: z.number().default(0.5),
      tokens: z.number().int().default(2_000_000),
      wallMs: z.number().default(900_000),
    })
    .prefault({}),
  rateLimit: z
    .object({
      rpsFraction: z.number().default(0.9),
      maxConcurrencyTier1: z.number().int().default(8),
      maxConcurrencyTier2: z.number().int().default(16),
    })
    .prefault({}),
  // The B23 cache key and the inference log both read this field, so it must
  // track the prompt bytes. `llm/prompts.ts` owns both version strings (B49)
  // and a bump lands with the regenerated cache in the same commit; nothing
  // else may spell a version out. The default is `PAIRED_PROMPT_VERSION`
  // rather than `PROMPT_VERSION` (T66): a paired measurement found the
  // newer prompt a net accuracy loss, so what a bare profile name resolves
  // to reverted to the older one; the newer value stays selectable via
  // `baseline-pv3` or by setting this field explicitly.
  promptVersion: z.string().default(PAIRED_PROMPT_VERSION),
});

export const ProfileSchema = ProfileObject.refine(
  (p) => p.calibration !== 'votes' || (p.samples >= 3 && p.sampling.temperature === 0.7),
  { message: "calibration 'votes' requires samples >= 3 and sampling.temperature 0.7" },
);

export type Profile = z.infer<typeof ProfileObject>;

/** What a profile file may carry before defaults and inheritance are applied. */
export type ProfileInput = z.input<typeof ProfileObject>;

/**
 * Where a resolved profile came from (B12): the literal `"builtin"`, or the
 * path of the profile file it was read from.
 */
export type ProfileSource = string;

/** The one non-path value `ProfileSource` takes. */
export const PROFILE_SOURCE_BUILTIN = 'builtin';

/** The reasoning efforts a profile may ask for on a constrained call (T71). */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

/** What `profile.reasoning` means, with the defaults filled in. */
export interface ResolvedReasoning {
  constrainedEffort: ReasoningEffort;
  constrainedMaxTokens: number;
}

/**
 * The T71 defaults for an absent `reasoning` group: reasoning off on
 * constrained calls, which is every profile's behaviour before T71.
 */
export const DEFAULT_REASONING: ResolvedReasoning = {
  constrainedEffort: 'none',
  constrainedMaxTokens: 2048,
};

/** The T71 default for an absent `constrainedSamples`: one request, as before. */
export const DEFAULT_CONSTRAINED_SAMPLES = 1;

/**
 * `profile.reasoning` with the documented defaults applied. The field is
 * optional (see its doc comment), so this is the only shape a caller should
 * read it through.
 */
export function reasoningOf(profile: Profile): ResolvedReasoning {
  return profile.reasoning ?? DEFAULT_REASONING;
}

/** `profile.constrainedSamples` with the documented default applied. */
export function constrainedSamplesOf(profile: Profile): number {
  return profile.constrainedSamples ?? DEFAULT_CONSTRAINED_SAMPLES;
}
