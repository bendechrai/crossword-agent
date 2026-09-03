import { notImplemented } from '../util/errors.js';
import type { SourceAdapter } from './types.js';

export interface XdSourceOptions {
  /** Local directory or zip; `./corpora/xd-puzzles.zip` by default. */
  path?: string;
}

export const XD_DEFAULT_PATH = 'corpora/xd-puzzles.zip';

/** T27: reads a local directory or a zip of the xd corpus. No network. */
export function createXdSource(_opts: XdSourceOptions = {}): SourceAdapter {
  return {
    id: 'xd',
    list: () => notImplemented('src/sources/xd.ts'),
    download: () => notImplemented('src/sources/xd.ts'),
    normalise: () => notImplemented('src/sources/xd.ts'),
  };
}

/** The instance the registry holds. */
export const xdSource: SourceAdapter = createXdSource();
