import { notImplemented } from '../util/errors.js';
import type { FetchLike, SourceAdapter } from './types.js';

export interface FileSourceOptions {
  /** Injected so tests stay offline; used only for http(s) refs. */
  fetch?: FetchLike;
}

/** T22: imports a local path or a URL to a single .puz/.ipuz/.jpz/.xd. */
export function createFileSource(_opts: FileSourceOptions = {}): SourceAdapter {
  return {
    id: 'file',
    list: () => notImplemented('src/sources/file.ts'),
    download: () => notImplemented('src/sources/file.ts'),
    normalise: () => notImplemented('src/sources/file.ts'),
  };
}

/** The instance the registry holds. */
export const fileSource: SourceAdapter = createFileSource();
