import { notImplemented } from '../src/util/errors.js';

/**
 * T43: downloads the Crossword Nexus collaborative word list (MIT) into
 * `data/wordlist/collaborative.txt`, which is gitignored. The 2,000-line
 * subset committed at `test/fixtures/wordlist.txt` is what tests use, so this
 * script is never on a test path.
 */
export function fetchWordList(): Promise<void> {
  return notImplemented('scripts/wordlist-fetch.ts');
}

await fetchWordList();
