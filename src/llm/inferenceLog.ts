import { notImplemented } from '../util/errors.js';
import type { InferenceLog } from './types.js';

export interface InferenceLogOptions {
  /** Defaults to `resolveInferenceLogDir()`. */
  dir?: string;
  /** `false` returns a no-op sink (`--no-inference-log`). */
  enabled?: boolean;
}

/**
 * T10: append-only JSONL at `<dir>/<YYYY-MM-DD>.jsonl`, one record per line,
 * through a single write stream per process per day. `write()` is
 * fire-and-forget: a failure warns once and never fails the run.
 */
export function openInferenceLog(_opts: InferenceLogOptions): InferenceLog {
  return notImplemented('src/llm/inferenceLog.ts');
}
