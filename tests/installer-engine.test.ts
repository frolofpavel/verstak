import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { dirIsOursToWipe, newInstallLedger, rollbackInstall } from '../electron/installer/engine'

/**
 * B1: runInstall при ЛЮБОЙ ошибке делал rm(installDir, recursive, force) —
 * стирал ВСЮ выбранную папку, включая чужие/старые файлы (обновление поверх
 * установки или выбор папки с личными файлами + сбой копирования = потеря данных).
 * Откат теперь убирает только то, что записал сам установщик.
 */
describe('installer rollback (B1: не теряем чужие файлы при сбое)', () => {
  let base: string
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'gg-inst-')) })
  afterEach(() => { rmSync(base, { recursive: true, force: true }) })

  it('dirIsOursToWipe: пустая → true, непустая → false, несуществующая → true', async () => {
    const empty = join(base, 'empty'); mkdirSync(empty)
    const full = join(base, 'full'); mkdirSync(full); writeFileSync(join(full, 'x.txt'), 'x')
    expect(await dirIsOursToWipe(empty)).toBe(true)
    expect(await dirIsOursToWipe(full)).toBe(false)
    expect(await dirIsOursToWipe(join(base, 'nope'))).toBe(true)
  })

  /**
   * Утверждение «откат УДАЛЯЕТ записанные payload-файлы» здесь стояло до 16.08 и
   * стерегло контракт, отменённый враждебным ревью §1: payload-файлы и есть вся
   * установка, поэтому их удаление означало «снести рабочее приложение при сбое».
   * Что осталось верным и проверяется по-прежнему — чужие файлы откат не трогает;
   * восстановление прежних версий стережёт tests/installer/install-guard.test.ts.
   */
  it('ownDir=false: откат убирает дописанное, СОХРАНЯЯ чужие файлы', async () => {
    const installDir = join(base, 'install'); mkdirSync(installDir)
    writeFileSync(join(installDir, 'sentinel.txt'), 'МОИ ДАННЫЕ') // чужой файл
    writeFileSync(join(installDir, 'a.txt'), 'a')                 // дописан установкой

    const ledger = newInstallLedger()
    ledger.created.push('a.txt')
    await rollbackInstall(installDir, ledger, false)

    expect(existsSync(join(installDir, 'sentinel.txt'))).toBe(true) // сохранён
    expect(existsSync(join(installDir, 'a.txt'))).toBe(false)       // дописанное убрано
  })

  it('ownDir=true: откат убирает папку целиком', async () => {
    const installDir = join(base, 'owned'); mkdirSync(installDir)
    writeFileSync(join(installDir, 'a.txt'), 'a')
    await rollbackInstall(installDir, newInstallLedger(), true)
    expect(existsSync(installDir)).toBe(false)
  })
})
