import { notImplemented } from '../../util/errors.js';
import type { PuzzleAdapter } from './index.js';

/** T24: `.puz`, `.ipuz` and `.jpz` through `@xwordly/xword-parser`. */
export const xwordlyAdapter: PuzzleAdapter = {
  name: '@xwordly/xword-parser',
  extensions: ['puz', 'ipuz', 'jpz'],
  parse() {
    return notImplemented('src/puzzle/adapters/xwordly.ts');
  },
};
