/**
 * Vitest globalSetup — self-healing ABI better-sqlite3 перед всеми тестами.
 *
 * Запускается один раз в Node-процессе vitest ДО старта воркеров. Если бинарь
 * better-sqlite3 собран под Electron ABI (после `npm run dev`), пересобирает его
 * под текущий Node ABI на диске — воркеры (отдельные процессы) подхватывают уже
 * правильный .node. Благодаря этому `npx vitest run` чинит себя сам, минуя
 * npm-pretest хук.
 *
 * Логика общая с scripts/safe-rebuild.cjs (CLI для npm pretest). Грузим через
 * нативный require, чтобы Vite не трансформировал .cjs и нативный require
 * better-sqlite3 отработал в том же ABI, что и тест-воркеры.
 */
import { createRequire } from 'node:module'
import { sweepTestTempDirs } from './temp-sweep'

const require = createRequire(import.meta.url)
const { ensureNodeAbi } = require('../scripts/safe-rebuild.cjs') as {
  ensureNodeAbi: (opts?: { log?: Pick<Console, 'log' | 'warn'> }) => {
    status: 'ok' | 'rebuilt' | 'failed' | 'error'
    rebuilt: boolean
  }
}

// Возвращает teardown: vitest выполнит его ОДИН раз после всего прогона.
export default function setup(): () => void {
  ensureNodeAbi({ log: console })
  // Старт-свип: убираем СТАРЫЕ (>30 мин) test-temp-каталоги от прошлых/убитых прогонов —
  // их накопление (10 051 за сессию 18.07) насыщает антивирус → EPERM-эскалация. Свежие
  // каталоги активного параллельного прогона НЕ трогаем (olderThanMs). См. temp-sweep.ts.
  try { sweepTestTempDirs({ olderThanMs: 30 * 60 * 1000 }) } catch { /* best-effort */ }
  // Teardown: чистим ВСЕ свои test-temp после прогона (тесты завершены → хендлы отпущены,
  // rmDirRobust добьёт readonly/транзиентные локи).
  return function teardown(): void {
    try { sweepTestTempDirs() } catch { /* best-effort */ }
  }
}
