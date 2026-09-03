import { downloadWordList } from '../src/validate/wordlist.js';
import { log } from '../src/util/log.js';

/**
 * T43: downloads the Crossword Nexus collaborative word list (MIT) into
 * `data/wordlist/collaborative.txt`, which is gitignored. The 2,000-line
 * subset committed at `test/fixtures/wordlist.txt` is what tests use, so this
 * script is never on a test path (its download logic lives in
 * `src/validate/wordlist.ts`'s `downloadWordList`, which is what the unit
 * test exercises with an injected `fetch`; this file itself is a thin,
 * human-run network wrapper around it).
 */
export async function fetchWordList(): Promise<void> {
  const { path, bytes } = await downloadWordList();
  log.info(`wrote ${String(bytes)} bytes to ${path}`);
}

await fetchWordList();
