#!/usr/bin/env node
// The dev-loop entry point. It registers tsx's ESM loader and then imports the
// TypeScript CLI directly, so a source edit under the bind mount applies on the
// next invocation with no build step. `npm run build` plus
// `node dist/cli/index.js` is the built path, exercised by `npm run smoke:dist`.
//
// tsx is resolved relative to this file rather than the working directory, so
// `xw` behaves the same wherever it is run from.
import { register } from 'tsx/esm/api';

register();

const { main } = await import('../src/cli/index.ts');
process.exitCode = await main(process.argv);
