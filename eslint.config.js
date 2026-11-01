/**
 * ESLint (Flat Config)
 *
 * Ziel: die Fehlerklasse abfangen, die von Tests nicht erfasst wird und die in
 * den letzten Releases tatsächlich aufgetreten ist — Tippfehler in
 * Bezeichnern, doppelte Objektschlüssel, unerreichbarer Code,
 * Promise-Executor-Fallen.
 *
 * Bewusst KEIN `eslint:recommended` und keine Stilregeln: bei ~150 k Zeilen
 * Bestandscode würde ein volles Regelwerk beim ersten Lauf tausende Meldungen
 * produzieren und die CI sofort rot färben. Die Regeln hier sind auf Fehler
 * beschränkt, die mit hoher Sicherheit echt sind.
 *
 * `npm run lint` prüft nur Errors (--quiet) → das ist das CI-Gate.
 * `npm run lint:all` zeigt zusätzlich die Warnungen (Aufräum-Backlog).
 */

import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'docs/**',
      'test/fixtures/**',
      'public/vendor/**',
      '**/*.min.js',
      'public/lucide.min.js',
    ],
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      // ---- Errors: klare Programmierfehler, praktisch keine Fehlalarme ----
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-class-members': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-func-assign': 'error',
      'no-obj-calls': 'error',
      'no-async-promise-executor': 'error',
      'no-unexpected-multiline': 'error',
      'no-compare-neg-zero': 'error',
      'no-sparse-arrays': 'error',
      'no-empty-pattern': 'error',
      'valid-typeof': 'error',
      'use-isnan': 'error',

      // ---- Warnungen: Aufräum-Backlog, blockiert die CI nicht ----
      'no-unused-vars': ['warn', { args: 'after-used', ignoreRestSiblings: true }],
      'no-undef': 'warn',
      eqeqeq: ['warn', 'smart'],
      'no-var': 'warn',
    },
  },
];
