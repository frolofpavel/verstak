import { defineConfig, configDefaults } from 'vitest/config'

// Файлы с РЕАЛЬНЫМИ git-субпроцессами + temp-репо inherently враждебны параллелизму: под
// нагрузкой (Codex/сборка/полный suite) git возвращает EPERM на очистке temp-дерева и мусор
// в snapshot/reconcile (cross-contention нескольких git-процессов). Гоняем их СТРОГО ПО ОДНОМУ
// отдельным проектом; остальной suite остаётся параллельным. rmDirRobust добивает транзиентные
// локи, сериализация — cross-contention. См. память verstak-worktree-* и STATUS.
const WORKTREE_FILES = [
  'tests/ai/worktree-lifecycle.test.ts',
  'tests/ai/worktree-status.test.ts',
  'tests/ai/git-worktree.test.ts',
]

export default defineConfig({
  test: {
    // Общие настройки — наследуются проектами через extends: true (в т.ч. globalSetup, который
    // vitest запускает ОДИН раз последовательно в главном процессе → без гонки ABI-пересборки).
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 30_000,
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'main',
          include: ['tests/**/*.test.ts'],
          // configDefaults.exclude ОБЯЗАТЕЛЕН: без него node_modules снова попадёт в прогон.
          exclude: [...configDefaults.exclude, ...WORKTREE_FILES],
        },
      },
      {
        extends: true,
        test: {
          name: 'worktree',
          include: WORKTREE_FILES,
          // git-субпроцессы враждебны параллелизму → строго по одному файлу (maxWorkers=1).
          fileParallelism: false,
          // git под нагрузкой корректен, но медленный — поднимаем таймауты под гейт.
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // worktree-setup: снятие GIT_*-переменных (карточка #2, класс 747e3e0) — чтобы прямой
          // прогон не тёк core.bare=true в main. Явно перечисляем оба (project.setupFiles
          // заменяет унаследованный, не мержит).
          setupFiles: ['tests/setup.ts', 'tests/worktree-setup.ts'],
        },
      },
    ],
  },
})
