import { notImplemented } from '../util/errors.js';
import type { EventHandler } from '../events/types.js';

/**
 * T15: reads a `.events.jsonl` back and calls the handler in file order, so a
 * `--watch` playback of an old run costs nothing.
 */
export function replay(_path: string, _handler: EventHandler): Promise<void> {
  return notImplemented('src/render/replay.ts');
}
