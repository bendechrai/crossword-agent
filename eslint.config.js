import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'cache/**',
      'corpora/**',
      'data/**',
      'logs/**',
      'runs/**',
      'puzzles/**',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // The whole-repository program: src, test, scripts and vitest.config.
        // tsconfig.json alone is the build config and covers only src.
        project: ['./tsconfig.check.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // Output is the event stream's and the renderers' job; everything else
      // that needs to say something uses src/util/log.ts.
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/render/**/*.ts', 'src/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Plain JS (the bin shim, this config): no type information available.
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
