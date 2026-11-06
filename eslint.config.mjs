import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['custom_components/ha_query/frontend/*.js'],
    languageOptions: {globals: globals.browser},
  },
  {
    files: ['tests/*.cjs', 'eslint.config.mjs'],
    languageOptions: {globals: globals.node},
  },
  {rules: {'no-unused-vars': ['error', {argsIgnorePattern: '^_'}]}},
];
