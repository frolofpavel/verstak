#!/usr/bin/env node
/**
 * Best-effort rebuild better-sqlite3 под текущий Node ABI перед тестами.
 *
 * Зачем — better-sqlite3 в node_modules скомпилирован под Electron'овский
 * Node ABI (NODE_MODULE_VERSION 143). Vitest бежит под чистым Node (137),
 * и тесты которые открывают БД падают `NODE_MODULE_VERSION mismatch`.
 *
 * Раньше — 8 sqlite-тестов всегда падали. ТЗ Pavel'а: добавить pretest hook
 * который перекомпилирует. ПРОБЛЕМА: если параллельно крутится electron-dev,
 * .node-файл заблокирован Windows'ом → npm rebuild падает EBUSY → весь
 * test:fast становится невозможен.
 *
 * Решение: пробуем rebuild, ловим любую ошибку (особенно EBUSY/EPERM на
 * Win и ESRCH на *nix), завершаемся с exit 0 + понятное warning. Тесты
 * запускаются. Если rebuild прошёл — 8 sqlite-тестов теперь зелёные;
 * если не прошёл — поведение как было раньше (8 падают, остальные ок).
 */
const { spawn } = require('child_process')
const { platform } = require('os')

const npmCmd = platform() === 'win32' ? 'npm.cmd' : 'npm'

// На Windows spawn .cmd / .bat файла требует shell:true (иначе EINVAL в Node 24+).
const child = spawn(npmCmd, [
  'rebuild',
  'better-sqlite3',
  '--runtime=node',
  '--update-binary'
], {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: platform() === 'win32'
})

let stdoutBuf = ''
let stderrBuf = ''
child.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString() })
child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString() })

child.on('close', (code) => {
  if (code === 0) {
    console.log('[safe-rebuild] better-sqlite3 пересобран под Node ABI ✓')
    process.exit(0)
  }
  // Распознаём типичный «занят dev'ом» сценарий — даём подсказку, но НЕ валим.
  const combined = (stdoutBuf + '\n' + stderrBuf).toLowerCase()
  const isBusy = combined.includes('ebusy') || combined.includes('eperm') ||
                 combined.includes('resource busy') || combined.includes('operation not permitted')
  if (isBusy) {
    console.warn('[safe-rebuild] rebuild skipped: .node файл заблокирован (видимо запущен `npm run dev`).')
    console.warn('[safe-rebuild] sqlite-тесты могут падать с NODE_MODULE_VERSION mismatch.')
    console.warn('[safe-rebuild] Закрой Electron-приложение и запусти ещё раз — тогда rebuild пройдёт.')
  } else {
    console.warn(`[safe-rebuild] rebuild failed (exit ${code}), пропускаю и продолжаю.`)
    if (stderrBuf) console.warn(stderrBuf.slice(0, 400))
  }
  process.exit(0) // НЕ блокируем тесты
})

child.on('error', (err) => {
  console.warn(`[safe-rebuild] spawn error: ${err.message}. Пропускаю.`)
  process.exit(0)
})
