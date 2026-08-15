import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  INSTALL_BACKUP_SUFFIX,
  commitInstall,
  copyPayload,
  newInstallLedger,
  rollbackInstall,
  runInstall,
} from '../../electron/installer/engine'
import {
  detectRunningInstall,
  probeLock,
  RUNNING_INSTALL_MESSAGE,
  type LockProbe,
} from '../../electron/installer/running-check'

/**
 * Враждебное ревью 2.6.4 §1. Обновление поверх ЗАПУЩЕННОГО приложения падало на
 * залоченном файле, а «откат» удалял payload-файлы — то есть всю установку.
 * Замер на стенде: 22 записи каталога → 11, `locales/` пуст, приложение не
 * стартует вообще. Здесь стерегутся оба конца: отказ ДО первой записи и откат,
 * который восстанавливает, а не стирает.
 */
describe('installer: сбой не убивает рабочую установку', () => {
  let base: string
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'gg-inst-guard-')) })
  afterEach(() => { rmSync(base, { recursive: true, force: true }) })

  const silent = () => {}

  /** Прежняя (рабочая) установка + payload новой версии поверх неё. */
  function makeUpgradeStand() {
    const payload = join(base, 'payload')
    mkdirSync(join(payload, 'zz-sub'), { recursive: true })
    writeFileSync(join(payload, 'a-first.txt'), 'НОВОЕ a')
    writeFileSync(join(payload, 'b-second.txt'), 'НОВОЕ b')
    writeFileSync(join(payload, 'zz-sub', 'child.txt'), 'НОВОЕ child')

    const installDir = join(base, 'install')
    mkdirSync(installDir, { recursive: true })
    writeFileSync(join(installDir, 'a-first.txt'), 'СТАРОЕ a')
    writeFileSync(join(installDir, 'b-second.txt'), 'СТАРОЕ b')
    writeFileSync(join(installDir, 'sentinel.txt'), 'ЧУЖОЙ ФАЙЛ')
    return { payload, installDir }
  }

  it('откат посреди копирования ВОССТАНАВЛИВАЕТ прежние файлы, а не стирает их', async () => {
    const { payload, installDir } = makeUpgradeStand()
    // Обрыв на середине: в папке установки лежит ФАЙЛ с именем каталога payload,
    // поэтому mkdir под `zz-sub/child.txt` падает EEXIST — уже после того, как
    // две прежние версии заменены.
    writeFileSync(join(installDir, 'zz-sub'), 'блокирует создание каталога')

    const ledger = newInstallLedger()
    await expect(copyPayload(payload, installDir, silent, ledger)).rejects.toThrow()
    // Контроль, что кейс не вырожденный: обрыв случился ПОСЛЕ первой замены.
    expect(ledger.replaced.length).toBeGreaterThan(0)

    await rollbackInstall(installDir, ledger, false)

    expect(readFileSync(join(installDir, 'a-first.txt'), 'utf8')).toBe('СТАРОЕ a')
    expect(readFileSync(join(installDir, 'b-second.txt'), 'utf8')).toBe('СТАРОЕ b')
    expect(readFileSync(join(installDir, 'sentinel.txt'), 'utf8')).toBe('ЧУЖОЙ ФАЙЛ')
    expect(existsSync(join(installDir, `a-first.txt${INSTALL_BACKUP_SUFFIX}`))).toBe(false)
  })

  it('контроль: успешная установка по-прежнему проходит и не оставляет отложенных копий', async () => {
    const { payload, installDir } = makeUpgradeStand()

    const ledger = newInstallLedger()
    await copyPayload(payload, installDir, silent, ledger)
    await commitInstall(installDir, ledger)

    expect(readFileSync(join(installDir, 'a-first.txt'), 'utf8')).toBe('НОВОЕ a')
    expect(readFileSync(join(installDir, 'b-second.txt'), 'utf8')).toBe('НОВОЕ b')
    expect(readFileSync(join(installDir, 'zz-sub', 'child.txt'), 'utf8')).toBe('НОВОЕ child')
    expect(readFileSync(join(installDir, 'sentinel.txt'), 'utf8')).toBe('ЧУЖОЙ ФАЙЛ')
    expect(existsSync(join(installDir, `a-first.txt${INSTALL_BACKUP_SUFFIX}`))).toBe(false)
    expect(existsSync(join(installDir, `b-second.txt${INSTALL_BACKUP_SUFFIX}`))).toBe(false)
  })
})

describe('installer: проверка «приложение запущено» до первой записи', () => {
  let base: string
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'gg-inst-run-')) })
  afterEach(() => { rmSync(base, { recursive: true, force: true }) })

  const lockedProbe: LockProbe = async (p) => (p.endsWith('Verstak.exe') ? 'locked' : 'missing')
  const freeProbe: LockProbe = async () => 'free'
  const emptyProbe: LockProbe = async () => 'missing'

  it('залоченный файл установки → запущено; свободный и отсутствующий → нет', async () => {
    expect(await detectRunningInstall(base, lockedProbe)).toBe(true)
    expect(await detectRunningInstall(base, freeProbe)).toBe(false)
    expect(await detectRunningInstall(base, emptyProbe)).toBe(false)
  })

  it('probeLock на живой ФС: обычный файл свободен, отсутствующий — missing', async () => {
    const file = join(base, 'Verstak.exe')
    writeFileSync(file, 'not really an exe')
    expect(await probeLock(file)).toBe('free')
    expect(await probeLock(join(base, 'nope.dll'))).toBe('missing')
  })

  it('runInstall отказывает человеческим текстом и НЕ трогает папку', async () => {
    const installDir = join(base, 'install')
    mkdirSync(installDir, { recursive: true })
    writeFileSync(join(installDir, 'Verstak.exe'), 'РАБОЧАЯ ВЕРСИЯ')

    const result = await runInstall(installDir, '9.9.9', () => {}, { probeLock: lockedProbe })

    expect(result.ok).toBe(false)
    expect(result.error).toBe(RUNNING_INSTALL_MESSAGE)
    expect(result.error).not.toMatch(/EPERM|ENOENT|Error:/)
    expect(readFileSync(join(installDir, 'Verstak.exe'), 'utf8')).toBe('РАБОЧАЯ ВЕРСИЯ')
  })
})
