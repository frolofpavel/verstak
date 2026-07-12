// ESLint 9/10 flat config — Фаза 1 плана качества (report-only + ratchet).
// Цель: ловить реальные LLM-дефекты (проглоченные Promise, misuse, hooks-order,
// неисчерпывающий switch), НЕ переписывать legacy и НЕ тащить косметику из
// recommended. Набор правил — РОВНО из плана §1.2, ничего сверх.
// lint:full = отчёт по всему проекту; lint:changed = гейт только на изменённых
// файлах (встроен в precommit, падает на errors, warnings пропускает).
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    // Не-исходные и генерируемые зоны + конфиги/скрипты вне tsconfig.
    ignores: [
      'node_modules/**',
      'out/**',
      'release/**',
      'dist/**',
      'coverage/**',
      '.worktrees/**',
      'resources/**',
      'docs/**',
      '**/*.config.{mjs,cjs,js}',
      'scripts/**',
      'electron-builder.installer.json',
    ],
  },

  // Type-aware набор правил §1.2 для приложения (electron/ + src/) и тестов.
  {
    files: ['electron/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // projectService сам находит нужный tsconfig под каждый файл (electron/web/tests).
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── Реальные LLM-дефекты (план §1.2) — error ────────────────────────────
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      'no-async-promise-executor': 'error',
      'no-fallthrough': 'error',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],

      // ── Гигиена/ratchet — warn (не топим baseline, не блокируем на легаси) ───
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'complexity': ['warn', 15],
      'max-depth': ['warn', 4],
      'max-lines-per-function': ['warn', { max: 120, skipBlankLines: true, skipComments: true }],
    },
  },

  // React Hooks — только renderer (src). rules-of-hooks сразу error.
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Отчёт о неиспользуемых eslint-disable директивах (план §1.2).
  {
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
  },
)
