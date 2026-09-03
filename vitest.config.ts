import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Enforced by `npm run coverage` (and by CI's `npm test -- --coverage`),
      // not by the plain `npm test` that preflight runs.
      thresholds: {
        lines: 80,
        branches: 75,
        'src/grid/**': { lines: 95 },
        'src/validate/**': { lines: 95 },
        'src/eval/scorer.ts': { lines: 95 },
      },
    },
  },
});
