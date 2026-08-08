import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { classifyStartup, isFatalLogLine, isPositiveLogLine } = require('../../scripts/smoke-verdict.cjs')

// «Проверка, которая никогда не видела мёртвого приложения, краснеть не умеет» (штаб).
// Эти пины кормят вердикт СИНТЕТИЧЕСКИ мёртвым стартом и требуют FAIL — доказывают, что
// smoke УМЕЕТ забраковать. Рядом — контрольный здоровый старт, требующий PASS.
describe('classifyStartup — smoke-вердикт умеет и краснеть, и зеленеть', () => {
  const base = { sawStartupOk: false, fatalEvents: [], exitedEarly: false, exitCode: null, waitedMs: 0, timeoutMs: 30000 }

  it('FAIL: render_process_gone в логах (реальный симптом установленной 2.4.5)', () => {
    const v = classifyStartup({ ...base, fatalEvents: ['window.render_process_gone'], waitedMs: 5000 })
    expect(v.verdict).toBe('FAIL')
  })

  it('FAIL: процесс вышел до маркера готовности (VERSTAK_SMOKE exit 1 / краш)', () => {
    const v = classifyStartup({ ...base, exitedEarly: true, exitCode: 1, waitedMs: 3000 })
    expect(v.verdict).toBe('FAIL')
  })

  it('FAIL: нет маркера startup.ok за таймаут (чёрный экран / зависшая модалка)', () => {
    const v = classifyStartup({ ...base, waitedMs: 30000, timeoutMs: 30000 })
    expect(v.verdict).toBe('FAIL')
  })

  it('PASS: маркер startup.ok получен и фатальных событий нет', () => {
    const v = classifyStartup({ ...base, sawStartupOk: true, waitedMs: 4000 })
    expect(v.verdict).toBe('PASS')
  })

  it('фатальное событие ПОБЕЖДАЕТ даже при полученном startup.ok (краш после старта)', () => {
    const v = classifyStartup({ ...base, sawStartupOk: true, fatalEvents: ['window.render_process_gone'], waitedMs: 8000 })
    expect(v.verdict).toBe('FAIL')
  })

  it('INCONCLUSIVE: ещё ждём (ни маркера, ни фатала, время не вышло)', () => {
    const v = classifyStartup({ ...base, waitedMs: 5000, timeoutMs: 30000 })
    expect(v.verdict).toBe('INCONCLUSIVE')
  })

  it('isFatalLogLine ловит render_process_gone, db.open.fail и нативный ABI, игнорит info', () => {
    expect(isFatalLogLine({ level: 'error', event: 'window.render_process_gone', reason: 'crashed' })).toBe(true)
    expect(isFatalLogLine({ level: 'error', event: 'db.open.fail', message: 'нет native-модуля' })).toBe(true)
    expect(isFatalLogLine({ level: 'error', event: 'native.load', message: 'NODE_MODULE_VERSION mismatch' })).toBe(true)
    expect(isFatalLogLine({ level: 'info', event: 'startup.ok' })).toBe(false)
    expect(isFatalLogLine({ level: 'error', event: 'ai.retry', reason: 'timeout' })).toBe(false)
  })

  it('isPositiveLogLine ловит startup.ok (новый) И db.open.ok (есть уже в 2.4.6)', () => {
    expect(isPositiveLogLine({ level: 'info', event: 'startup.ok' })).toBe(true)
    expect(isPositiveLogLine({ level: 'info', event: 'db.open.ok' })).toBe(true)
    expect(isPositiveLogLine({ level: 'error', event: 'window.render_process_gone' })).toBe(false)
    expect(isPositiveLogLine({ level: 'info', event: 'ai.turn' })).toBe(false)
  })
})
