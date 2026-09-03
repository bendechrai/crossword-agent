import type { PuzzleExt, PuzzleWithSolution } from '../puzzle/types.js';

export interface PuzzleRef {
  id: string;
  source: string;
  date?: string;
  title?: string;
  url: string;
  ext: PuzzleExt;
}

export interface SourceListOptions {
  series?: string;
  date?: string;
  from?: string;
  to?: string;
  limit?: number;
  /** Local directory or zip, for the offline `xd` source. */
  path?: string;
}

export interface SourceDownload {
  bytes: Buffer;
  ext: PuzzleExt;
}

/**
 * The normalise hook every adapter implements: raw bytes plus the ref they
 * came from, in; a fully normalised puzzle, out.
 */
export type NormaliseHook = (bytes: Buffer, ref: PuzzleRef) => Promise<PuzzleWithSolution>;

export interface SourceAdapter {
  id: string;
  list(opts: SourceListOptions): Promise<PuzzleRef[]>;
  download(ref: PuzzleRef): Promise<SourceDownload>;
  normalise: NormaliseHook;
}

/** Injected so every adapter test stays offline. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
