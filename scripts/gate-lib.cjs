/**
 * Чистая логика pre-commit гейта «гарантия вместо обещания». Вынесена из
 * precommit.cjs ради тестируемости (tests/precommit-gate.test.ts).
 *
 * Ключевая тонкость — ABI-лок: когда открыт `npm run dev`, better-sqlite3
 * залочен под Electron ABI, и sqlite-тесты падают NODE_MODULE_VERSION mismatch.
 * Это ИЗВЕСТНЫЙ ШУМ, не регрессия. Гейт не должен из-за него блокировать коммит
 * (иначе с открытым приложением вообще не закоммитить). Но НЕ-ABI падения под
 * этим шумом — реальная регрессия и блокируют.
 */

/** true, если в выводе vitest есть РЕАЛЬНОЕ (не-ABI) падение теста. */
function hasNonAbiFailures(output) {
  const lines = String(output || '').split('\n')
  return lines.some(l => {
    if (!/AssertionError|Expected|ReferenceError:|SyntaxError|TypeError:|Error:/.test(l)) return false
    if (/NODE_MODULE_VERSION/.test(l)) return false           // прямой ABI-mismatch
    if (/reading 'close'/.test(l)) return false               // вторичный каскад (db.close на undefined из-за ABI)
    if (/better_sqlite3|compiled against a different|was compiled against/i.test(l)) return false // первая строка многострочной ABI-ошибки (NODE_MODULE_VERSION на следующей строке)
    return true
  })
}

/**
 * Решение тест-гейта.
 *
 * abiStatus честный (см. scripts/safe-rebuild.cjs, задача 2 07.08 — статус берётся из
 * ПРОВЕРКИ факта, а не из кода возврата npm):
 *   'ok'      — better-sqlite3 уже под нужным ABI;
 *   'rebuilt' — пересобран и ПРОВЕРЕНО загружается → ABI-падений быть не должно;
 *   'locked'  — .node залочен запущенным Electron/`npm run dev`, пересборка физически
 *               не прошла → sqlite-падения = среда, не регрессия;
 *   'failed'  — пересборка не прошла по иной (не-лок) причине среды;
 *   'error'   — модуль не грузится не из-за ABI.
 * @param {{abiStatus:'ok'|'rebuilt'|'locked'|'failed'|'error', vitestExit:number, vitestOutput:string}} p
 * @returns {{block:boolean, reason:string}}
 */
function decideTestGate({ abiStatus, vitestExit, vitestOutput }) {
  if (vitestExit === 0) return { block: false, reason: 'все тесты зелёные' }
  // Среда: sqlite не удалось сделать загружаемым НЕ по вине кода — .node залочен
  // ('locked') или пересборка сорвалась ('failed'). ABI-падения тут = шум; блокируем
  // ТОЛЬКО реальные (не-ABI) падения под этим шумом.
  if (abiStatus === 'locked' || abiStatus === 'failed') {
    if (hasNonAbiFailures(vitestOutput)) {
      return { block: true, reason: 'есть НЕ-ABI падения тестов под ABI-шумом — реальная регрессия' }
    }
    const reason = abiStatus === 'locked'
      ? 'падения только ABI: .node залочен (открыт `npm run dev`/Electron) — пропускаю; закрой приложение и прогони `npm run test` для полного sqlite-покрытия'
      : 'падения только ABI: пересборка better-sqlite3 не прошла (среда) — пропускаю; почини окружение и прогони заново'
    return { block: false, reason }
  }
  // ABI в норме ('ok') или пересборка ПРОВЕРЕННО прошла ('rebuilt') → любое падение реально.
  return { block: true, reason: 'падения тестов (ABI в норме → регрессия)' }
}

module.exports = { hasNonAbiFailures, decideTestGate }
