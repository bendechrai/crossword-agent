import { notImplemented } from '../util/errors.js';
import type { AppConfig } from '../config.js';
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
 * T23 (B26). Precedence, lowest to highest: zod defaults < named built-in <
 * profile file (a full profile, or one with `"extends": "<builtin>"`) <
 * `--config` values < explicit CLI flags.
 */
export function resolveProfile(_opts: ResolveProfileOptions): Promise<ResolvedProfile> {
  return notImplemented('src/profiles/loader.ts');
}
