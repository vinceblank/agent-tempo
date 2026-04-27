// Flat ESLint config for the claude-tempo dashboard.
//
// **Build-blocking custom rules** (architect's testability addendum):
//
// - `no-restricted-globals` bans `window.confirm`/`alert`/`prompt` because they
//   block the `claude-in-chrome` MCP tooling that powers autonomous validation.
//   The conductor's playbook routes UI testing through `mcp__claude-in-chrome__*`
//   and a single `alert()` halts the entire driver until a human dismisses it.
//
// - `no-restricted-syntax` bans the native `<dialog>` element. Use shadcn
//   Dialog/AlertDialog/Sheet instead — they're a11y-first and play nicely with
//   the testid convention documented in `dashboard/README.md`.
//
// Lint runs in `npm --prefix dashboard run lint` and via the dashboard-build
// CI job; either failing blocks merge.

import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        getComputedStyle: 'readonly',
        HTMLElement: 'readonly',
        Element: 'readonly',
        // Node globals — legitimately used by Vitest test files that
        // need to read fixtures off disk (`oklch-tokens.test.tsx`
        // injects `tokens.css` via `process.cwd()`). Source files
        // don't reference these, but listing them globally keeps the
        // config simple.
        process: 'readonly',
        // Vitest globals — test files use `describe`, `it`, `expect`, etc.
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        vi: 'readonly',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'confirm', message: 'Use shadcn AlertDialog. Native confirm blocks claude-in-chrome.' },
        { name: 'alert', message: 'Use shadcn Dialog or Sonner toast.' },
        { name: 'prompt', message: 'Use shadcn Dialog with form input.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXOpeningElement[name.name='dialog']",
          message: 'Use shadcn Dialog component, not native <dialog>. See dashboard/README.md § Testability.',
        },
        {
          selector: "CallExpression[callee.object.name='window'][callee.property.name='confirm']",
          message: 'Use shadcn AlertDialog. Native window.confirm blocks claude-in-chrome.',
        },
        {
          selector: "CallExpression[callee.object.name='window'][callee.property.name='alert']",
          message: 'Use shadcn Dialog or Sonner toast. Native window.alert blocks claude-in-chrome.',
        },
        {
          selector: "CallExpression[callee.object.name='window'][callee.property.name='prompt']",
          message: 'Use shadcn Dialog with form input. Native window.prompt blocks claude-in-chrome.',
        },
      ],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-unused-vars': 'off',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'tests/setup.ts'],
  },
];
