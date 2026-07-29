// В dev канала автообновления нет ПО ЗАМЫСЛУ: `initAutoUpdater` выходит до
// создания сервиса при `!app.isPackaged`. Но renderer зовёт `update:get-state`
// вслепую и получал необработанную ошибку «No handler registered» — дважды за
// старт, в логе Павла это выглядело как поломка обновлений.
//
// Дефекта в автообновлении нет и не было (собранная сборка канал регистрирует,
// публичную проверку 2.2.21 прошли). Чинится ровно шум: dev отдаёт то же пустое
// состояние, что отдал бы сервис, и контракт preload/api.d.ts не меняется.
//
// Регистрация каналов — модульный синглтон, поэтому все утверждения про неё живут
// в ОДНОМ тесте: сбрасывать флаг между тестами значило бы проверять не тот код,
// который выполняется в приложении.
import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'node:os'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: () => '2.2.21',
    getPath: () => tmpdir(),
  },
  ipcMain: {
    // Настоящий electron бросает именно так — иначе пин на идемпотентность
    // ничего бы не значил.
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
      handlers.set(channel, fn)
    },
  },
  BrowserWindow: class {},
  shell: { openExternal: () => {} },
}))

const { ipcMain } = await import('electron')
const { initAutoUpdater } = await import('../electron/autoupdate/service')

describe('dev: состояние обновлений отвечает вместо необработанной ошибки', () => {
  it('канал есть, ответ осмысленный, повторная инициализация не роняет', async () => {
    initAutoUpdater({} as never)

    const handler = handlers.get('update:get-state')
    expect(handler, 'канал не зарегистрирован — ошибка в консоли останется').toBeTruthy()

    const state = await handler!() as { phase: string; installedVersion?: string }
    expect(typeof state.phase, 'ответ без фазы renderer не поймёт').toBe('string')
    expect(state.installedVersion).toBe('2.2.21')

    // Второй init (перезапуск окна) не должен упереться во «второй обработчик».
    expect(() => initAutoUpdater({} as never)).not.toThrow()
  })

  // КОНТРОЛЬ: без него предыдущий пин был бы зелёным и от «мок ничего не
  // проверяет» — надо доказать, что двойная регистрация действительно падает.
  it('контроль: мок ловит двойную регистрацию', () => {
    ipcMain.handle('проверка-двойной-регистрации', () => null)
    expect(() => ipcMain.handle('проверка-двойной-регистрации', () => null)).toThrow(/second handler/)
  })
})
