import { notImplemented } from '../../util/errors.js';
import type { PuzzleAdapter } from './index.js';

/**
 * T25: the `.xd` text format. Clue lines carry the answer after a ` ~ `
 * separator, and everything from ` ~ ` onward is stripped before the clue text
 * is stored (B42).
 */
export const xdAdapter: PuzzleAdapter = {
  name: 'xd-crossword-tools',
  extensions: ['xd'],
  parse() {
    return notImplemented('src/puzzle/adapters/xd.ts');
  },
};
