import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
export default [
  ...svelte.configs['flat/base'],
  { files: ['src/**/*.{js,svelte}'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser, ...globals.node } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }], 'svelte/valid-compile': 'off' } },
];
