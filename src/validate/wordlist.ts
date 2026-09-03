import { notImplemented } from '../util/errors.js';
import type { WordList } from './types.js';

/**
 * T43 (B35). Loads `data/wordlist/collaborative.txt` in `word;score` form.
 * When the file is absent this returns a null object - `has` always false,
 * `score` always 0, `match` always empty - which disables the repair word-list
 * gate and leaves empty slots blank, with a one-time warning.
 */
export function openWordList(_path?: string): WordList {
  return notImplemented('src/validate/wordlist.ts');
}
