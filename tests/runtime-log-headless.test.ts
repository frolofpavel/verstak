import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Headless-контур (Этап 1а облачного Verstak, разведка 04.08 §1):
// runtime-log — единственный жёсткий блокер импорта ядра в чистом Node. Мок кидает на
// import ровно как require('electron') на сервере, где пакета electron нет. Пока в
// runtime-log.ts живёт top-level `import { app, ipcMain } from 'electron'` — этот тест
// красный; после расщепления модуль обязан грузиться и писать лог в явный каталог.
vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

describe('runtime-log в headless Node — без electron', () => {
  it('модуль импортируется и logRuntime пишет в явно сконфигурированный каталог', async () => {
    const mod = await import('../electron/runtime-log')
    const dir = mkdtempSync(join(tmpdir(), 'vsk-rtlog-'))
    try {
      mod.configureRuntimeLogDir(dir)
      mod.logRuntime('headless_smoke', { detail: 'ok' })
      const file = join(dir, 'runtime.jsonl')
      expect(existsSync(file)).toBe(true)
      const line = readFileSync(file, 'utf8')
      expect(line).toContain('headless_smoke')
      // Редакция значений (контракт 1.9.8 #6) обязана работать и в headless-пути.
      mod.logRuntime('headless_redact', { detail: 'Authorization: Bearer sk-ant-abcdefghij0123456789klmno' })
      expect(readFileSync(file, 'utf8')).not.toContain('sk-ant-abcdefghij0123456789klmno')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('без явной конфигурации фолбэк не трогает electron и указывает внутрь APPDATA/cwd', async () => {
    const mod = await import('../electron/runtime-log')
    // ЯВНАЯ правка фикстуры (09.08): tests/setup.ts теперь глобально перенаправляет журнал
    // во временный каталог (тесты не пишут в боевой errors.jsonl). Это ЗАТЕНЯЕТ фолбэк,
    // который проверяет данный кейс, поэтому снимаем конфигурацию перед проверкой самого
    // фолбэка — иначе тест мерил бы temp-каталог сетапа, а не поведение без конфигурации.
    mod.configureRuntimeLogDir(null)
    const dir = mod.runtimeLogsDir()
    const expectedRoot = process.env.APPDATA || process.cwd()
    expect(dir.startsWith(expectedRoot)).toBe(true)
  })
})
