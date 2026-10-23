// @ts-check
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const prettier = require('eslint-config-prettier');

module.exports = tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts'],
    languageOptions: {
      // Nest DI reads constructor types from decorator metadata; keep those imports as values.
      parserOptions: { emitDecoratorMetadata: true, experimentalDecorators: true },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': 'error',
    },
  },
  {
    // The domain layer must stay framework- and transport-free.
    files: ['apps/*/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@nestjs/*'], message: 'Domain code must not import NestJS.' },
            {
              group: ['pg', 'opossum', 'jose', 'pino'],
              message: 'Domain code must not import infrastructure.',
            },
            {
              group: ['@dv/shared', '@dv/shared/*'],
              message: 'Domain code must not import shared infrastructure.',
            },
            {
              group: ['**/adapters/**', '**/api/**', '**/application/**'],
              message: 'Domain must not depend on outer layers.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off', 'no-console': 'off' },
  },
);
