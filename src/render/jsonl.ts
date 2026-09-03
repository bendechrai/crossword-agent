import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

import { ensureDir } from '../util/fs.js';
import type { EventHandler } from '../events/types.js';

export interface JsonlEventSink {
  handler: EventHandler;
  close(): Promise<void>;
}

/**
 * T15: appends every event as one JSON line to `runs/<runId>.events.jsonl`.
 * Attached automatically at `-vvv` or with `--trace`.
 *
 * Each event is written synchronously the moment it arrives - the sink never
 * holds more than the one line currently being written in memory - and the
 * underlying file descriptor is explicitly `fsync`ed on `run:end` and on
 * `close()`, so a crash right after either point cannot lose a line that was
 * already handed to the sink.
 */
export function createJsonlEventSink(path: string): JsonlEventSink {
  ensureDir(dirname(path));
  const fd = openSync(path, 'a');
  let closed = false;

  const handler: EventHandler = (event) => {
    if (closed) return;
    writeSync(fd, `${JSON.stringify(event)}\n`);
    if (event.type === 'run:end') {
      fsyncSync(fd);
    }
  };

  const close = (): Promise<void> => {
    if (!closed) {
      closed = true;
      fsyncSync(fd);
      closeSync(fd);
    }
    return Promise.resolve();
  };

  return { handler, close };
}
