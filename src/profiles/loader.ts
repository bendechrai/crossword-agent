import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { usageError } from '../cli/exit.js';
import { pathKind } from '../config.js';
import type { AppConfig } from '../config.js';
import { builtinNames, getBuiltin } from './builtins.js';
import { PROFILE_SOURCE_BUILTIN, ProfileSchema } from './schema.js';
import type { Profile, ProfileInput, ProfileSource } from './schema.js';

export interface ResolveProfileOptions {
  /** A built-in name or a path to a profile file; `baseline` by default. */
  profile?: string;
  config?: AppConfig;
  /** Explicit CLI flags, the highest precedence layer (B26). */
  overrides?: Partial<ProfileInput>;
}

export interface ResolvedProfile {
  profile: Profile;
  /** 'builtin', or the profile file path (B12). */
  source: ProfileSource;
}

/**
 * Top-level `Profile` keys that are themselves option groups (all use
 * `.prefault({})` in `src/profiles/schema.ts`). Named explicitly, mirroring
 * that (frozen) file, rather than introspected from the zod schema, so this
 * list can't drift silently if the zod object's internal representation ever
 * changes shape.
 */
const NESTED_GROUP_KEYS: readonly string[] = [
  'sampling',
  'escalation',
  'search',
  'repair',
  'budget',
  'rateLimit',
];

/**
 * Every key each nested option group accepts (mirroring the frozen
 * `src/profiles/schema.ts`), hand-listed for the same reason as
 * `PROFILE_FILE_KEYS` below: these groups are not `.strict()` zod objects
 * (they use `.prefault({})`), so an unrecognised key inside one (a typo such
 * as `search.maxBactracks`) would otherwise be silently dropped by zod
 * instead of surfacing as the usage error the T23 decision requires.
 */
const NESTED_GROUP_ALLOWED_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  sampling: new Set(['temperature', 'topP', 'maxTokens']),
  escalation: new Set(['policy', 'clueUnderstoodThreshold', 'maxTier2CallsPerPuzzle', 'escalationsPerSlot']),
  search: new Set(['ordering', 'ldsLimitStart', 'ldsLimitMax', 'maxBacktracks']),
  repair: new Set(['enabled', 'maxCalls', 'maxEditDistance']),
  budget: new Set(['usd', 'tokens', 'wallMs']),
  rateLimit: new Set(['rpsFraction', 'maxConcurrencyTier1', 'maxConcurrencyTier2']),
};

/**
 * Every key `ProfileObject` (src/profiles/schema.ts) accepts, plus `extends`,
 * which is a profile-*file*-only instruction consumed here and never passed
 * through to the schema. Kept as an explicit list for the same reason as
 * `NESTED_GROUP_KEYS` above.
 */
const PROFILE_FILE_KEYS = new Set<string>([
  'name',
  'tier1',
  'tier2',
  'candidatesPerAsk',
  'calibration',
  'samples',
  'batchSize',
  'reasksPerSlot',
  'sampling',
  'escalation',
  'search',
  'repair',
  'budget',
  'rateLimit',
  'promptVersion',
  'extends',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Finds the first unrecognised key inside any nested option group of `raw`
 * (e.g. a typo `search.maxBactracks`), returning it as `"<group>.<key>"`, or
 * `undefined` when every nested group's keys are all recognised. Only
 * inspects groups whose value is a plain object; a group with a non-object
 * value is left for `ProfileSchema` to reject on its own terms.
 */
function firstNestedUnknownKey(raw: Record<string, unknown>): string | undefined {
  for (const group of NESTED_GROUP_KEYS) {
    const value = raw[group];
    if (!isPlainObject(value)) continue;
    const allowed = NESTED_GROUP_ALLOWED_KEYS[group];
    if (allowed === undefined) continue;
    const badKey = Object.keys(value).find((key) => !allowed.has(key));
    if (badKey !== undefined) return `${group}.${badKey}`;
  }
  return undefined;
}

/**
 * Overlays `patch` onto `base`. Nested option groups are merged one level
 * deep, so setting a single field of `search` (say) never resets the group's
 * other fields back to the zod defaults - it keeps whatever `base` already
 * had for them. Every other key is a plain override.
 */
function overlayProfile(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    // '__proto__' is never a `Profile` field, and a plain `out[key] = value`
    // for that key replaces the object's prototype instead of adding a field.
    // A profile file carrying it is already rejected above by
    // PROFILE_FILE_KEYS; skipping it here keeps that true for the `overrides`
    // layer as well, whatever shape a caller hands in.
    if (key === '__proto__') continue;
    if (NESTED_GROUP_KEYS.includes(key) && isPlainObject(value) && isPlainObject(out[key])) {
      // A field inside a nested-group patch set to `undefined` (e.g. an
      // absent CLI flag mapped straight into `overrides.sampling`) must not
      // clobber the base's value for that field - only keys the patch
      // actually defines should override, so `undefined` entries are
      // dropped from `value` before it is spread over the base group.
      const definedEntries = Object.fromEntries(
        Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
      );
      out[key] = { ...out[key], ...definedEntries };
    } else {
      out[key] = value;
    }
  }
  return out;
}

interface ProfileSpecResolution {
  input: Record<string, unknown>;
  source: ProfileSource;
}

/**
 * Resolves `spec` (a built-in name, or a path to a profile file) to a
 * profile-shaped input object plus its provenance. Layers "zod defaults <
 * named built-in < profile file" (B26): a built-in is already a complete
 * literal; a file with `"extends"` overlays its own fields onto that
 * built-in; a file without `extends` is handed to `ProfileSchema` as-is; zod
 * fills whatever field the file doesn't set.
 */
async function resolveProfileSpec(spec: string): Promise<ProfileSpecResolution> {
  if (builtinNames().includes(spec)) {
    return { input: getBuiltin(spec), source: PROFILE_SOURCE_BUILTIN };
  }

  const absPath = resolve(spec);
  if (pathKind(absPath) !== 'file') {
    // Absent, or present but not a regular file (a directory such as
    // `--profile ./profiles`): neither is a profile, and neither should reach
    // `readFile` and escape as a raw ENOENT/EISDIR.
    throw usageError(
      `unknown profile "${spec}"`,
      `expected a built-in (${builtinNames().join(', ')}) or an existing profile file`,
    );
  }

  // A regular file can still be unreadable (EACCES), or be replaced between
  // the check above and the read; that is a usage error, not a crash, and it
  // says why rather than claiming the profile is unknown.
  let text: string;
  try {
    text = await readFile(absPath, 'utf8');
  } catch (e) {
    throw usageError(`cannot read profile file ${absPath}: ${(e as Error).message}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw usageError(`invalid JSON in profile file ${absPath}: ${(e as Error).message}`);
  }
  if (!isPlainObject(raw)) {
    throw usageError(`profile file ${absPath} must contain a JSON object`);
  }

  const unknownKey = Object.keys(raw).find((key) => !PROFILE_FILE_KEYS.has(key));
  if (unknownKey !== undefined) {
    throw usageError(
      `unknown key "${unknownKey}" in profile file ${absPath}`,
      `allowed keys: ${[...PROFILE_FILE_KEYS].sort().join(', ')}`,
    );
  }

  const nestedUnknownKey = firstNestedUnknownKey(raw);
  if (nestedUnknownKey !== undefined) {
    throw usageError(
      `unknown key "${nestedUnknownKey}" in profile file ${absPath}`,
      'a typo inside a profile group is a usage error, not a silently ignored field',
    );
  }

  const { extends: extendsName, ...fileFields } = raw;
  if (extendsName === undefined) {
    return { input: fileFields, source: absPath };
  }
  if (typeof extendsName !== 'string') {
    throw usageError(`"extends" in profile file ${absPath} must be a string`);
  }
  if (!builtinNames().includes(extendsName)) {
    throw usageError(
      `profile file ${absPath} extends unknown built-in "${extendsName}"`,
      `known built-ins: ${builtinNames().join(', ')}`,
    );
  }

  // Resolved once, non-recursively: the extended built-in is a complete
  // literal, never itself a file, so there is no chain to walk.
  const extended = getBuiltin(extendsName);
  return { input: overlayProfile(extended, fileFields), source: absPath };
}

/**
 * T23 (B26). Precedence, lowest to highest: zod defaults < named built-in <
 * profile file (a full profile, or one with `"extends": "<builtin>"`) <
 * `--config` values < explicit CLI flags.
 *
 * `AppConfig` (B27) carries no field that overlaps a `Profile` field - its
 * only profile-relevant key is `defaultProfile`, a fallback identifier used
 * only when `opts.profile` itself is absent (an explicit `--profile` always
 * wins). Explicit CLI flags (`opts.overrides`) are the one layer that can
 * touch arbitrary `Profile` fields, and they are applied last, on top of
 * whichever built-in or file was resolved.
 */
export async function resolveProfile(opts: ResolveProfileOptions): Promise<ResolvedProfile> {
  const spec = opts.profile ?? opts.config?.defaultProfile ?? 'baseline';
  const { input, source } = await resolveProfileSpec(spec);

  const withOverrides = opts.overrides
    ? overlayProfile(input, opts.overrides)
    : input;

  let profile: Profile;
  try {
    profile = ProfileSchema.parse(withOverrides);
  } catch (e) {
    throw usageError(`invalid profile "${spec}": ${(e as Error).message}`);
  }

  return { profile, source };
}
