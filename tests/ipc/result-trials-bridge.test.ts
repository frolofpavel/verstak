// P1: контракт моста состязания — preload ↔ типы ↔ handler.
//
// Правило репозитория (§9): новый IPC-endpoint живёт в ТРЁХ местах, и разъезд
// любых двух молчалив — renderer зовёт то, чего нет, и падает уже у человека.
// Здесь это проверяется по исходникам: каждый канал, объявленный в handler'е,
// обязан иметь мост в preload и тип в api.d.ts.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const handlerSrc = read('electron/ipc/result-trials.ts')
const preloadSrc = read('electron/preload.ts')
const typesSrc = read('src/types/api.d.ts')

/** Каналы, реально зарегистрированные обработчиком. */
const channels = Array.from(handlerSrc.matchAll(/ipcMain\.handle\('([^']+)'/g)).map(m => m[1])

describe('P1: мост состязания собран во всех трёх местах', () => {
  it('обработчик регистрирует ожидаемый набор каналов (парсер не пустой)', () => {
    expect(channels.length, 'ни одного канала не найдено — страж молча зелёный').toBeGreaterThan(5)
    expect(channels).toContain('result-trials:start')
    expect(channels).toContain('result-trials:accept')
    expect(channels).toContain('result-trials:summary')
    expect(channels).toContain('result-trials:diff')
  })

  for (const channel of channels) {
    it(`канал ${channel} проброшен в preload`, () => {
      expect(preloadSrc, `канал ${channel} зарегистрирован в main, но renderer его не достанет`).toContain(`'${channel}'`)
    })
  }

  it('в типах renderer объявлен фасад resultTrials с ключевыми методами', () => {
    expect(typesSrc).toContain('resultTrials: {')
    for (const method of ['available:', 'start:', 'summary:', 'diff:', 'accept:', 'dispose:']) {
      expect(typesSrc, `метод ${method} не объявлен в api.d.ts — вызов будет any`).toContain(method)
    }
    expect(typesSrc).toContain('TrialAttemptSummaryDTO')
  })

  it('main регистрирует контур (иначе каналы существуют только на бумаге)', () => {
    const mainSrc = read('electron/main.ts')
    expect(mainSrc).toContain('registerResultTrialsIpc')
    expect(mainSrc).toContain('createResultTrials(db)')
  })

  it('запуск требует ДВУХ исполнителей — состязание с одним сравнивать не с чем', () => {
    expect(handlerSrc).toContain('competitors.length < 2')
  })

  it('на принятии каталоги НЕ удаляются: отклонённая работа остаётся диффом', () => {
    // Страж формулировки-намерения: уборка вынесена в отдельный канал dispose,
    // и accept её не зовёт. Иначе «принятие не теряет работу» было бы обещанием.
    const acceptBlock = handlerSrc.slice(handlerSrc.indexOf("'result-trials:accept'"), handlerSrc.indexOf("'result-trials:dispose'"))
    expect(acceptBlock).not.toContain('.dispose()')
  })
})
