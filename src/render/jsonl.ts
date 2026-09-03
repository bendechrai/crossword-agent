import { notImplemented } from '../util/errors.js';
import type { EventHandler } from '../events/types.js';

export interface JsonlEventSink {
  handler: EventHandler;
  close(): Promise<void>;
}

/**
 * T15: appends every event as one JSON line to `runs/<runId>.events.jsonl`.
 * Attached automatically at `-vvv` or with `--trace`.
 */
export function createJsonlEventSink(_path: string): JsonlEventSink {
  return notImplemented('src/render/jsonl.ts');
}
