import { describe, expect, it } from 'vitest'
import { join } from 'path'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import {
  isNativeModuleError,
  probeBetterSqlite3Node,
  repairBetterSqlite3FromBundle,
} from '../../electron/native-modules'

describe('native-modules', () => {
  it('probeBetterSqlite3Node returns missing for absent path', () => {
    expect(probeBetterSqlite3Node(join(tmpdir(), 'verstak-no-such-native', 'better_sqlite3.node'))).toBe('missing')
  })

  it('isNativeModuleError detects ABI mismatch text', () => {
    expect(
      isNativeModuleError(
        'The module was compiled against a different NODE_MODULE_VERSION',
      ),
    ).toBe(true)
    expect(isNativeModuleError('database is locked')).toBe(false)
  })

  // Инцидент 2.4.5: негодный native-fix (Node ABI под Electron) перезаписывал
  // рабочую копию ДО проверки — самопочинка чинила сломанное таким же сломанным,
  // а рабочий модуль уже уничтожен. Гард обязан пробовать ИСТОЧНИК до перезаписи.
  it('repairBetterSqlite3FromBundle не трогает target, когда source негоден по ABI (DI)', () => {
    const copied: Array<[string, string]> = []
    const ok = repairBetterSqlite3FromBundle({
      target: '/fake/target.node',
      source: '/fake/source.node',
      exists: () => true,
      probe: p => (p === '/fake/source.node' ? 'abi_mismatch' : 'ok'),
      ensureDir: () => {},
      copy: (from, to) => {
        copied.push([from, to])
      },
    })
    expect(ok).toBe(false)
    expect(copied).toEqual([]) // рабочая копия не тронута
  })

  it('repairBetterSqlite3FromBundle не затирает рабочий target нечитаемым source (реальные файлы)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verstak-native-fix-'))
    const source = join(dir, 'source.node')
    const target = join(dir, 'target.node')
    writeFileSync(source, Buffer.from('это не валидный нативный модуль')) // probe → 'unknown'
    writeFileSync(target, 'WORKING-COPY')
    const ok = repairBetterSqlite3FromBundle({ target, source })
    expect(ok).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('WORKING-COPY') // цела
  })

  it('repairBetterSqlite3FromBundle копирует source в target, когда source здоров (DI)', () => {
    const copied: Array<[string, string]> = []
    const ok = repairBetterSqlite3FromBundle({
      target: 't',
      source: 's',
      exists: () => true,
      probe: () => 'ok',
      ensureDir: () => {},
      copy: (from, to) => {
        copied.push([from, to])
      },
    })
    expect(ok).toBe(true)
    expect(copied).toEqual([['s', 't']])
  })
})
