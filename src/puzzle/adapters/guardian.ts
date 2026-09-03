import { notImplemented } from '../../util/errors.js';
import type { PuzzleAdapter } from './index.js';

/**
 * T26: a Guardian crossword JSON payload (`crossword.entries[]`) converted to
 * a `PuzzleWithSolution` with `parsedBy: 'guardian-json'` (B17).
 */
export const guardianAdapter: PuzzleAdapter = {
  name: 'guardian-json',
  extensions: ['json'],
  parse() {
    return notImplemented('src/puzzle/adapters/guardian.ts');
  },
};
