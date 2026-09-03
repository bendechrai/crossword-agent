import { notImplemented } from './util/errors.js';

/**
 * B27. No secrets live here - the API key comes from the environment only -
 * and the file is never read from `$HOME`, so a run inside the container and a
 * run on a colleague's machine resolve the same way.
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

/**
 * T23: `--config` > `$CROSSWORD_CONFIG` > `./crossword.config.json` > absent.
 */
export function loadConfig(_opts: LoadConfigOptions): Promise<LoadedConfig> {
  return notImplemented('src/config.ts');
}
