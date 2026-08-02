// СТАРТОВАЯ ГОНКА браузера (живая проверка a0f7a22, Павел): browser_navigate иногда
// падал «вкладка не открыта» на первом вызове после запуска, следующий тот же вызов
// проходил — между попытками ничего не менялось. Причина: PersistentBrowser
// монтируется в renderer АСИНХРОННО (lazy), а хендлер при отсутствии
// window.verstakBrowser отдавал ошибку НЕМЕДЛЕННО. Лечение — честное ожидание
// готовности (browser-ready.ts): ждать появления API до предела, не слепой паузой.
//
// Пин воспроизводит ИМЕННО вызов раньше монтирования: сниппет сообщает __vskNotReady,
// пока API не появился. Мутация (убрать цикл ожидания) роняет первый тест — он не
// декоративен.
import { describe, it, expect, vi } from 'vitest'
import { execAwaitingBrowserApi, isBrowserNotReady } from '../../electron/ipc/tool-handlers/browser-ready'

const noSleep = () => Promise.resolve()

describe('execAwaitingBrowserApi — честное ожидание готовности (гонка старта)', () => {
  it('вызов РАНЬШЕ монтирования: API нет → появился → дождался и выполнил (не «не открыта»)', async () => {
    let calls = 0
    // Первые два вызова: браузер ещё монтируется. Третий: смонтировался, отдал результат.
    const exec = vi.fn(async () => (++calls < 3 ? { __vskNotReady: true } : { ok: true, url: 'https://alfa' }))
    const r = await execAwaitingBrowserApi('SNIPPET', { exec, timeoutMs: 1000, sleep: noSleep })
    expect(isBrowserNotReady(r)).toBe(false)
    expect(r).toEqual({ ok: true, url: 'https://alfa' })
    expect(exec).toHaveBeenCalledTimes(3)   // дождался появления, а не сдался с первого раза
  })

  it('API готов сразу → ровно один вызов, без накладных (happy path)', async () => {
    const exec = vi.fn(async () => ({ ok: true }))
    const r = await execAwaitingBrowserApi('SNIPPET', { exec, timeoutMs: 1000, sleep: noSleep })
    expect(r).toEqual({ ok: true })
    expect(exec).toHaveBeenCalledTimes(1)
  })

  // КОНТРОЛЬ: если API так и не появился — не бесконечный цикл, а честный __vskNotReady
  // после предела (хендлер превратит его в ошибку «повтори попытку»).
  it('API не появился никогда → __vskNotReady после предела, цикл ограничен', async () => {
    const exec = vi.fn(async () => ({ __vskNotReady: true }))
    let clock = 0
    const r = await execAwaitingBrowserApi('SNIPPET', { exec, timeoutMs: 200, sleep: noSleep, now: () => (clock += 60) })
    expect(isBrowserNotReady(r)).toBe(true)
    expect(exec.mock.calls.length).toBeGreaterThan(1)   // пытался ждать
    expect(exec.mock.calls.length).toBeLessThan(20)     // но ограничен пределом, не завис
  })
})
