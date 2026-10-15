// ESLint config for the whole repo — bug-catching rules only, no style rules. Run (also in CI):
//   ESLINT_DIR=/tmp/eslint /tmp/eslint/node_modules/.bin/eslint -c tools/eslint.config.mjs .
// after `npm install eslint eslint-plugin-html globals` into ESLINT_DIR (default /tmp/eslint).
// The packages live outside the repo on purpose (no package.json/node_modules here), so they're
// loaded from ESLINT_DIR rather than imported by name.

import { createRequire } from 'module';
import { readFileSync } from 'fs';

const require = createRequire((process.env.ESLINT_DIR || '/tmp/eslint') + '/');
const html = require('eslint-plugin-html');
const globals = require('globals');

// Everything shared/common.js declares at top level is a global for every page that loads it —
// derived from the file itself so a new shared helper needs no change here.
const commonJs = readFileSync(new URL('../shared/common.js', import.meta.url), 'utf8');
const sharedGlobals = Object.fromEntries(
  [...commonJs.matchAll(/^(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map(m => [m[1], 'readonly']));

const bugRules = {
  'no-undef': 'error',
  // vars: 'local' — top-level functions in a page script are often only called from markup
  // (onclick="...") or other script blocks, which ESLint can't see, so only locals are checked.
  'no-unused-vars': ['error', { vars: 'local', args: 'none', caughtErrors: 'none' }],
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-duplicate-case': 'error',
  // builtinGlobals: false — a top-level `let history`/`let ai` legally shadows the browser's own
  // global of that name in a script; only genuine double declarations are reported.
  'no-redeclare': ['error', { builtinGlobals: false }],
  'no-unreachable': 'error',
  'no-fallthrough': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-const-assign': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-finally': 'error',
  'no-sparse-arrays': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-constant-condition': ['error', { checkLoops: false }],
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'getter-return': 'error',
  'no-setter-return': 'error',
  'no-loss-of-precision': 'error',
  'no-unused-labels': 'error',
  'no-useless-backreference': 'error',
};

export default [
  { ignores: ['**/levels/**', '**/node_modules/**'] },
  {
    files: ['**/*.html'],
    plugins: { html },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.browser, ...sharedGlobals },
    },
    rules: bugRules,
  },
  {
    files: ['shared/common.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      // `state` is each page's own global, defined by the page's script that loads this file.
      globals: { ...globals.browser, state: 'readonly' },
    },
    rules: { ...bugRules, 'no-redeclare': 'off' },
  },
  {
    files: ['sw.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: globals.serviceworker },
    rules: bugRules,
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    rules: bugRules,
  },
];
