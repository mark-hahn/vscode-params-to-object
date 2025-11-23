/* eslint-disable no-undef */
/* eslint-env node */
const js = require('@eslint/js');
const typescript = require('@typescript-eslint/eslint-plugin');
const typescriptParser = require('@typescript-eslint/parser');

module.exports = [
  // Base JS recommended rules applied to JS files
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module'
    },
    ...js.configs.recommended
  },

  // TypeScript-specific rules
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
        project: './tsconfig.json'
      }
    },
    plugins: {
      '@typescript-eslint': typescript
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: 'variableLike',
          format: ['camelCase', 'UPPER_CASE']
        },
        {
          selector: 'typeLike',
          format: ['PascalCase']
        }
      ],
      'curly': 'off',
      'eqeqeq': 'warn',
      'no-throw-literal': 'warn',
      'semi': 'warn'
    }
  },

  // Ignore patterns
  {
    ignores: ['misc/**', 'out/**', 'dist/**', '**/*.d.ts']
  }
];
