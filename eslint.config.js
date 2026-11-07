import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/*.generated.ts',
      '**/dist/**',
      '**/target/**',
      '**/node_modules/**',
      'apps/desktop/src-tauri/gen/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/desktop/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      // Une feature n'importe une autre feature que via son index.ts public.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/features/*/*',
                '../../features/*/*',
                '../*/components/*',
                '../*/services/*',
              ],
              message: 'Importer une feature uniquement via son index.ts public.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.{js,mjs}', 'scripts/**'],
    languageOptions: { globals: globals.node },
  },
);
