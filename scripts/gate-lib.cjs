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
 * @param {{abiStatus:'ok'|'rebuilt'|'failed'|'error', vitestExit:number, vitestOutput:string}} p
 * @returns {{block:boolean, reason:string}}
 */
function decideTestGate({ abiStatus, vitestExit, vitestOutput }) {
  if (vitestExit === 0) return { block: false, reason: 'все тесты зелёные' }
  if (abiStatus === 'failed') {
    // ABI-лок (открыт npm run dev) — sqlite-падения = шум. Блокируем только реальные.
    if (hasNonAbiFailures(vitestOutput)) {
      return { block: true, reason: 'есть НЕ-ABI падения тестов под ABI-шумом — реальная регрессия' }
    }
    return { block: false, reason: 'падения только ABI (открыт npm run dev) — пропускаю; sqlite-покрытие деградировано, прогони `npm run test` при закрытом приложении' }
  }
  // ABI в норме (ok/rebuilt) → любое падение реально.
  return { block: true, reason: 'падения тестов (ABI в норме → регрессия)' }
}

module.exports = { hasNonAbiFailures, decideTestGate }
