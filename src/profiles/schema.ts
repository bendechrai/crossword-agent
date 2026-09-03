import { z } from 'zod';

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
  tier1: z.string().default('nvidia/Nemotron-3_5-Lightning'),
  tier2: z.string().default('deepseek-ai/DeepSeek-V4-Pro'),
  candidatesPerAsk: z.number().int().min(1).max(25).default(10),
  calibration: z.enum(['rank', 'votes', 'blend']).default('rank'),
  samples: z.number().int().min(1).max(5).default(1),
  batchSize: z.number().int().min(1).max(8).default(1),
  reasksPerSlot: z.number().int().min(0).default(2),
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
  // Frozen at "1" for all of v1 (B23). Only T31 owns a bump, and a bump lands
  // with the regenerated cache in the same commit (B49).
  promptVersion: z.string().default('1'),
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
