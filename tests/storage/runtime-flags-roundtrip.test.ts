// Рантайм-флаги: сквозная проверка «переключил → перезапуск → поведение изменилось».
//
// Это НЕ дубль tests/components/runtime-flags-tab.test.ts. Там проверено, что клик
// по тумблеру зовёт settings.setKey с правильной строкой. Здесь проверено всё, что
// дальше по цепочке и что unit-тестом вкладки не покрывается:
//
//   1) запись идёт через РЕАЛЬНОЕ хранилище (`createSettings` поверх настоящей
//      sqlite из `openDb`) — тем же вызовом `setSecret`, который делает IPC-хендлер
//      `settings:set-key`;
//   2) БД ЗАКРЫВАЕТСЯ И ОТКРЫВАЕТСЯ ЗАНОВО — это и есть перезапуск приложения:
//      состояние процесса потеряно, остался только диск;
//   3) значение читается тем же `getSecret`, что в main;
//   4) и подаётся в НАСТОЯЩИЕ функции-потребители main (`isAutoCaptureEnabled`,
//      `isSmartFallbackAllowed`) — то есть проверяется поведение следующего
//      прогона, а не просто «строка в таблице».
//
// safeStorage подменён ровно так же, как в tests/storage/settings.test.ts: вне
// Electron его нет, а шифрование здесь не предмет проверки.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createSettings } from '../../electron/storage/settings'
import { isAutoCaptureEnabled } from '../../electron/ai/memory-hooks'
import { isSmartFallbackAllowed } from '../../electron/ipc/ai-send/fallback-route'
import type { ProviderDescriptor } from '../../electron/ai/registry'

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
}

let dir: string
let db: Database | undefined

/** Открыть приложение: новая БД-сессия поверх ТОГО ЖЕ файла на диске. */
function boot() {
  db?.close()
  db = openDb(join(dir, 'verstak.db'))
  const settings = createSettings(db, fakeSafeStorage)
  const getSecret = (key: string): string | null => settings.getSecret(key)
  return { settings, getSecret }
}

/** То, что делает IPC-хендлер settings:set-key при клике по тумблеру. */
function toggleInUi(settings: ReturnType<typeof createSettings>, key: string, on: boolean) {
  settings.setSecret(key, on ? 'true' : 'false')
}

const API_DESCRIPTOR = { transport: 'API' } as unknown as ProviderDescriptor
const fallbackInput = (getSecret: (k: string) => string | null) => ({
  getSecret,
  descriptor: API_DESCRIPTOR,
  promptRoute: null,
  oneShotAccountId: null,
})

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-flags-')) })
afterEach(() => {
  db?.close()
  db = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe('рантайм-флаги: переключение переживает перезапуск и меняет поведение', () => {
  it('сырой автозахват: выключен на чистой установке, включается и остаётся включённым', () => {
    // Чистая установка — потребитель в main видит «выключено».
    let app = boot()
    expect(isAutoCaptureEnabled(app.getSecret)).toBe(false)

    // Пользователь включил тумблер.
    toggleInUi(app.settings, 'auto_capture_memory', true)
    expect(isAutoCaptureEnabled(app.getSecret)).toBe(true)

    // Перезапуск приложения.
    app = boot()
    expect(app.getSecret('auto_capture_memory')).toBe('true')
    expect(isAutoCaptureEnabled(app.getSecret)).toBe(true)

    // И обратно — выключение тоже переживает перезапуск.
    toggleInUi(app.settings, 'auto_capture_memory', false)
    app = boot()
    expect(isAutoCaptureEnabled(app.getSecret)).toBe(false)
  })

  it('автоподмена при сбое: включена на чистой установке, выключается и остаётся выключенной', () => {
    let app = boot()
    expect(isSmartFallbackAllowed(fallbackInput(app.getSecret))).toBe(true)

    toggleInUi(app.settings, 'smart_fallback', false)
    expect(isSmartFallbackAllowed(fallbackInput(app.getSecret))).toBe(false)

    app = boot()
    expect(app.getSecret('smart_fallback')).toBe('false')
    expect(isSmartFallbackAllowed(fallbackInput(app.getSecret))).toBe(false)

    toggleInUi(app.settings, 'smart_fallback', true)
    app = boot()
    expect(isSmartFallbackAllowed(fallbackInput(app.getSecret))).toBe(true)
  })

  it('остальные три флага переживают перезапуск в обе стороны', () => {
    let app = boot()
    for (const key of ['memory_lifecycle', 'smart_routing', 'use_project_brain']) {
      toggleInUi(app.settings, key, false)
    }
    app = boot()
    for (const key of ['memory_lifecycle', 'smart_routing', 'use_project_brain']) {
      expect(app.getSecret(key)).toBe('false')
      // Та же проверка, что в main: opt-out флаг выключается строкой 'false'.
      expect(app.getSecret(key) !== 'false').toBe(false)
      toggleInUi(app.settings, key, true)
    }
    app = boot()
    for (const key of ['memory_lifecycle', 'smart_routing', 'use_project_brain']) {
      expect(app.getSecret(key) !== 'false').toBe(true)
    }
  })

  it('переключение одного флага не задевает соседей', () => {
    let app = boot()
    toggleInUi(app.settings, 'smart_routing', false)
    app = boot()
    expect(app.getSecret('smart_routing')).toBe('false')
    for (const key of ['memory_lifecycle', 'smart_fallback', 'use_project_brain', 'auto_capture_memory']) {
      expect(app.getSecret(key)).toBeNull()
    }
    expect(isAutoCaptureEnabled(app.getSecret)).toBe(false)
    expect(isSmartFallbackAllowed(fallbackInput(app.getSecret))).toBe(true)
  })
})
