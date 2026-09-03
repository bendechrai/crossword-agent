import { readFile } from 'node:fs/promises';

import { log } from '../util/log.js';
import type { EventHandler, SolverEvent } from '../events/types.js';

/**
 * T15: reads a `.events.jsonl` back and calls the handler in file order, so a
 * `--watch` playback of an old run costs nothing.
 *
 * Events are handed back exactly as recorded - `seq` and `tMs` are not
 * re-stamped, since they belong to the original run, not to this replay. A
 * trailing blank line (the common case: the file ends with a newline) is
 * skipped silently. A line that fails to parse as JSON is reported to
 * `src/util/log.ts` with its 1-based line number and the file path, and
 * replay continues with the next line rather than throwing.
 */
export async function replay(path: string, handler: EventHandler): Promise<void> {
  const text = await readFile(path, 'utf8');
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let event: SolverEvent;
    try {
      event = JSON.parse(trimmed) as SolverEvent;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(`replay: malformed line ${i + 1} in ${path}: ${reason}`);
      continue;
    }

    handler(event);
  }
}
