import { describe, expect, it } from 'vitest'
import { createRenderWatchdog } from '../../electron/render-watchdog'

// Watchdog смерти рендера: crashed → reload с лимитом попыток, дальше честная
// ошибка. Правило репозитория: рядом с «действие произошло» стоит контрольный
// кейс, где оно НЕ должно происходить (clean-exit, исчерпанный лимит).

describe('createRenderWatchdog — решение по смерти рендера', () => {
  it('смерть рендера → reload, до исчерпания лимита попыток', () => {
    const w = createRenderWatchdog({ maxAttempts: 3, windowMs: 60_000 })
    expect(w.decide('crashed', 1_000)).toBe('reload')
    expect(w.decide('crashed', 2_000)).toBe('reload')
    expect(w.decide('oom', 3_000)).toBe('reload')
  })

  it('КОНТРОЛЬ: попытка сверх лимита в окне → give-up (не бесконечный цикл крашей)', () => {
    const w = createRenderWatchdog({ maxAttempts: 3, windowMs: 60_000 })
    w.decide('crashed', 1_000)
    w.decide('crashed', 2_000)
    w.decide('crashed', 3_000)
    expect(w.decide('crashed', 4_000)).toBe('give-up')
  })

  it('КОНТРОЛЬ: clean-exit — не смерть, ignore и попытки не тратятся', () => {
    const w = createRenderWatchdog({ maxAttempts: 2, windowMs: 60_000 })
    for (let i = 0; i < 10; i++) expect(w.decide('clean-exit', 1_000 + i)).toBe('ignore')
    // после десяти clean-exit лимит цел: настоящая смерть всё ещё получает reload
    expect(w.decide('crashed', 2_000)).toBe('reload')
  })

  it('скользящее окно: старые попытки забываются, редкий краш снова получает reload', () => {
    const w = createRenderWatchdog({ maxAttempts: 2, windowMs: 10_000 })
    w.decide('crashed', 1_000)
    w.decide('crashed', 2_000)
    expect(w.decide('crashed', 3_000)).toBe('give-up')
    // окно уехало — приложение живёт давно, одиночный краш не приговор
    expect(w.decide('crashed', 20_000)).toBe('reload')
  })

  it('give-up не съедает окно: после отказа новая смерть за пределами окна снова reload', () => {
    const w = createRenderWatchdog({ maxAttempts: 1, windowMs: 5_000 })
    expect(w.decide('crashed', 1_000)).toBe('reload')
    expect(w.decide('crashed', 2_000)).toBe('give-up')
    expect(w.decide('crashed', 7_000)).toBe('reload')
  })
})
