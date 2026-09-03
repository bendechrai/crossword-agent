import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { z } from 'zod';

import { usageError } from './cli/exit.js';

/**
 * B27. No secrets live here - the API key comes from the environment only -
 * and the file is never read from `$HOME`, so a run inside the container and a
 * run on a colleague's machine resolve the same way. This module never
 * imports `node:os` (the acceptance test pins this by scanning the source
 * text of this file for Node's home-directory lookup function).
 */
export interface AppConfig {
  defaultProfile?: string;
  cacheDir?: string;
  runsDir?: string;
  puzzlesDir?: string;
  inferenceLogDir?: string;
  wordlistPath?: string;
  nebiusBaseUrl?: string;
}

export interface LoadConfigOptions {
  /** `--config <path>`. */
  path?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface LoadedConfig {
  config: AppConfig;
  /** The file it came from, or null when no config file was found. */
  path: string | null;
}

const DEFAULT_CONFIG_FILENAME = 'crossword.config.json';

/** Mirrors `AppConfig` above; kept as an explicit list rather than derived
 * from the zod schema so unknown-key detection never depends on a zod
 * object's internal shape representation. */
const CONFIG_KEYS = [
  'defaultProfile',
  'cacheDir',
  'runsDir',
  'puzzlesDir',
  'inferenceLogDir',
  'wordlistPath',
  'nebiusBaseUrl',
] as const;

/**
 * `.strict()` so a typo in a config file (e.g. `cachDir`) is a load-time
 * usage error rather than a silently ignored field.
 */
const ConfigSchema = z
  .object({
    defaultProfile: z.string().optional(),
    cacheDir: z.string().optional(),
    runsDir: z.string().optional(),
    puzzlesDir: z.string().optional(),
    inferenceLogDir: z.string().optional(),
    wordlistPath: z.string().optional(),
    nebiusBaseUrl: z.string().optional(),
  })
  .strict();

function firstUnrecognizedKey(raw: Record<string, unknown>): string | undefined {
  const known = new Set<string>(CONFIG_KEYS);
  return Object.keys(raw).find((key) => !known.has(key));
}

/**
 * T23 (B27): `--config <path>` > `$CROSSWORD_CONFIG` > `./crossword.config.json`
 * > absent. A path given explicitly (via `opts.path` or `$CROSSWORD_CONFIG`)
 * that does not exist is a usage error; the implicit default path is allowed
 * to be absent, in which case the config is `{}` and `path` is `null`.
 */
export async function loadConfig(opts: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  let candidate: string;
  let explicit: boolean;
  const envPath = env.CROSSWORD_CONFIG;
  if (opts.path !== undefined) {
    candidate = opts.path;
    explicit = true;
  } else if (envPath !== undefined && envPath.trim() !== '') {
    candidate = envPath;
    explicit = true;
  } else {
    candidate = DEFAULT_CONFIG_FILENAME;
    explicit = false;
  }

  const absPath = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);

  if (!existsSync(absPath)) {
    if (explicit) {
      throw usageError(`config file not found: ${absPath}`);
    }
    return { config: {}, path: null };
  }

  const text = await readFile(absPath, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw usageError(`invalid JSON in config file ${absPath}: ${(e as Error).message}`);
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw usageError(`config file ${absPath} must contain a JSON object`);
  }

  const unknownKey = firstUnrecognizedKey(raw as Record<string, unknown>);
  if (unknownKey !== undefined) {
    throw usageError(
      `unknown key "${unknownKey}" in config file ${absPath}`,
      `known keys: ${CONFIG_KEYS.join(', ')}`,
    );
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw usageError(`invalid config file ${absPath}: ${parsed.error.issues[0]?.message ?? 'validation failed'}`);
  }

  return { config: parsed.data, path: absPath };
}
