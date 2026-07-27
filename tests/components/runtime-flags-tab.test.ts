// @vitest-environment jsdom
//
// Вкладка «Поведение агента» — targeted-тесты (позиция 2 плана 2026-07-27).
//
// Что здесь охраняется, кроме «кнопки рисуются»:
//  · тумблер показывает состояние, ВЫВЕДЕННОЕ из сохранённого значения по
//    полярности флага, а не по наивному `stored === 'true'`. Наивное чтение
//    показало бы четыре opt-out флага выключенными на чистой установке;
//  · клик пишет РОВНО ту строку, которую main умеет прочитать обратно;
//  · сбой записи откатывает тумблер — иначе UI показывает состояние, которого в
//    настройках нет.
//
// Граница харнесса общая для проекта: только синхронные проверки через act();
// асинхронную загрузку значений ждём одним флашем промисов — здесь это безопасно,
// потому что монтируется отдельная вкладка, а не Chat (см. docs/CODE-AUDIT, 2.1.11).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'

const { RuntimeFlagsTab } = await import('../../src/components/RuntimeFlagsTab')
const { RUNTIME_FLAGS } = await import('../../src/lib/runtime-flags')

let store: Record<string, string>
let getKey: ReturnType<typeof vi.fn>
let setKey: ReturnType<typeof vi.fn>

function stubApi(overrides: { setKey?: () => Promise<void> } = {}) {
  getKey = vi.fn(async (key: string) => store[key] ?? null)
  setKey = vi.fn(overrides.setKey ?? (async (key: string, value: string) => { store[key] = value }))
  vi.stubGlobal('window', Object.assign(globalThis.window, {
    api: { settings: { getKey, setKey } },
  }))
}

/** Монтирует вкладку и даёт её загрузочному эффекту доехать. */
async function mountTab() {
  const r = render(createElement(RuntimeFlagsTab))
  await act(async () => { await Promise.resolve() })
  return r
}

function row(key: string): HTMLElement {
  const el = document.querySelector(`[data-flag="${key}"]`)
  if (!el) throw new Error(`нет строки флага ${key}`)
  return el as HTMLElement
}

function toggleOf(key: string): HTMLButtonElement {
  return row(key).querySelector('[role="switch"]') as HTMLButtonElement
}

beforeEach(() => { store = {}; stubApi() })
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('вкладка «Поведение агента» — состав', () => {
  it('рисует все пять флагов, каждый с подписью и тумблером', async () => {
    await mountTab()
    expect(document.querySelectorAll('.gg-runtime-flag-row').length).toBe(5)
    for (const f of RUNTIME_FLAGS) {
      const r = row(f.key)
      expect(r.querySelector('.gg-runtime-flag-title')?.textContent).toContain(f.title)
      expect(r.querySelector('.gg-runtime-flag-what')?.textContent).toBe(f.what)
      expect(toggleOf(f.key)).toBeTruthy()
    }
  })

  it('подпись человеческая: имени ключа в тексте строки нет', async () => {
    await mountTab()
    for (const f of RUNTIME_FLAGS) {
      expect(row(f.key).textContent ?? '').not.toContain(f.key)
    }
  })

  it('opt-in флаг помечен как выключенный по умолчанию, opt-out — нет', async () => {
    await mountTab()
    expect(row('auto_capture_memory').querySelector('.gg-runtime-flag-tag')).toBeTruthy()
    expect(row('smart_routing').querySelector('.gg-runtime-flag-tag')).toBeNull()
  })
})

describe('вкладка «Поведение агента» — чтение состояния', () => {
  it('чистая установка: четыре флага включены, сырой автозахват выключен', async () => {
    await mountTab()
    for (const key of ['memory_lifecycle', 'use_project_brain', 'smart_routing', 'smart_fallback']) {
      expect(toggleOf(key).getAttribute('aria-checked')).toBe('true')
    }
    expect(toggleOf('auto_capture_memory').getAttribute('aria-checked')).toBe('false')
  })

  it('сохранённые значения читаются по полярности своего флага', async () => {
    store = { smart_routing: 'false', auto_capture_memory: 'true' }
    await mountTab()
    expect(toggleOf('smart_routing').getAttribute('aria-checked')).toBe('false')
    expect(toggleOf('auto_capture_memory').getAttribute('aria-checked')).toBe('true')
    // Соседи не задеты.
    expect(toggleOf('smart_fallback').getAttribute('aria-checked')).toBe('true')
  })

  it('значения читаются ровно по своим ключам', async () => {
    await mountTab()
    const asked = getKey.mock.calls.map(c => c[0]).sort()
    expect(asked).toEqual(RUNTIME_FLAGS.map(f => f.key).sort())
  })
})

describe('вкладка «Поведение агента» — запись', () => {
  it('выключение opt-out флага пишет строку, которую main читает как «выключено»', async () => {
    await mountTab()
    await act(async () => { fireEvent.click(toggleOf('smart_fallback')) })
    expect(setKey).toHaveBeenCalledWith('smart_fallback', 'false')
    expect(toggleOf('smart_fallback').getAttribute('aria-checked')).toBe('false')
    expect(store.smart_fallback).toBe('false')
  })

  it('включение сырого автозахвата пишет ровно true', async () => {
    await mountTab()
    await act(async () => { fireEvent.click(toggleOf('auto_capture_memory')) })
    expect(setKey).toHaveBeenCalledWith('auto_capture_memory', 'true')
    expect(store.auto_capture_memory).toBe('true')
  })

  it('записанное значение переживает пересборку вкладки', async () => {
    await mountTab()
    await act(async () => { fireEvent.click(toggleOf('smart_routing')) })
    cleanup()
    await mountTab()
    expect(toggleOf('smart_routing').getAttribute('aria-checked')).toBe('false')
  })

  it('сбой записи возвращает тумблер назад и показывает причину', async () => {
    stubApi({ setKey: async () => { throw new Error('диск только для чтения') } })
    await mountTab()
    await act(async () => { fireEvent.click(toggleOf('memory_lifecycle')) })
    expect(toggleOf('memory_lifecycle').getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('.gg-settings-hint.is-error')?.textContent)
      .toContain('диск только для чтения')
  })
})
