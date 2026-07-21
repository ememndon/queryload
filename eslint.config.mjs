// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

/**
 * Flat ESLint config for the QueryLoad monorepo.
 *
 * Beyond ordinary hygiene, this config encodes two of the project's
 * non-negotiable rules as lint errors so a violation fails CI, not review:
 *   - Rule #1 (zero runtime network): the renderer may never import a
 *     network/telemetry primitive directly.
 *   - Rule #2 (engine/UI separation): the renderer may not import from the
 *     engine package; it speaks only the shared API contract.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/release/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'corpus/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-restricted-globals': ['error', 'event', 'name'],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  // Engine + service scripts run in Node.
  {
    files: ['packages/engine/**/*.ts', 'packages/desktop/**/*.ts', 'scripts/**/*.mjs', '**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  // Renderer runs in the browser sandbox — and is held to the isolation rules.
  {
    files: ['packages/ui/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@queryload/engine', '@queryload/engine/*'],
              message:
                'Rule #2: the renderer is a pure client of the engine API. Import types from @queryload/shared, never the engine implementation.',
            },
            {
              group: ['node:*', 'fs', 'net', 'http', 'https', 'dns', 'child_process'],
              message:
                'The sandboxed renderer must not use Node built-ins. Go through window.queryload.* (preload whitelist).',
            },
          ],
        },
      ],
    },
  },
  // Renderer test files + Vitest config run in Node, not the browser sandbox.
  {
    files: ['packages/ui/**/*.test.{ts,tsx}', 'packages/ui/vitest.config.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-restricted-imports': 'off' },
  },
  // Config / build files are not part of a tsconfig project.
  {
    files: ['**/*.mjs', '**/*.cjs', '*.config.*'],
    ...tseslint.configs.disableTypeChecked,
  },
  // CommonJS build hooks (e.g. the electron-builder afterPack rebuild) run in
  // Node and legitimately use require/module/exports.
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  prettier,
);
