import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'module'
import { autoUpdateRoot, payloadRoot, payloadVersionDir } from '../electron/autoupdate/paths'
import { acquireLock, readState, resetState, writeState } from '../electron/autoupdate/state'
import { verifyPayloadRoot } from '../electron/autoupdate/payload'
import { AutoUpdateService, toUiSnapshot } from '../electron/autoupdate/service'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar') as { createPackage(src: string, dest: string): Promise<void> }

async function writeVersionedAsar(filePath: string, version: string): Promise<void> {
  const src = join(tmpdir(), `verstak-autoupdate-asar-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(src, { recursive: true })
  try {
    writeFileSync(join(src, 'package.json'), JSON.stringify({ version, main: 'out/main/main.mjs' }))
    mkdirSync(join(src, 'out', 'main'), { recursive: true })
    writeFileSync(join(src, 'out', 'main', 'main.mjs'), 'export {}\n')
    writeFileSync(join(src, 'padding.bin'), Buffer.alloc(10_000_000, 0x61))
    await asar.createPackage(src, filePath)
  } finally {
    rmSync(src, { recursive: true, force: true })
  }
}

describe('autoupdate state machine', () => {
  let previousLocalAppData = process.env.LOCALAPPDATA
  let root = ''

  beforeEach(() => {
    root = join(tmpdir(), `verstak-autoupdate-test-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    process.env.LOCALAPPDATA = root
    mkdirSync(autoUpdateRoot(), { recursive: true })
  })

  afterEach(() => {
    process.env.LOCALAPPDATA = previousLocalAppData
    rmSync(root, { recursive: true, force: true })
  })

  it('stores one canonical state and maps payload_ready to UI ready', () => {
    const stored = writeState({
      schemaVersion: 1,
      status: 'payload_ready',
      version: '1.5.22',
      payloadRoot: 'C:\\payload',
      percent: 100,
      step: 'done',
      updatedAt: Date.now(),
    })

    expect(readState()?.status).toBe('payload_ready')
    expect(toUiSnapshot(stored)).toMatchObject({
      phase: 'ready',
      version: '1.5.22',
      percent: 100,
    })
  })

  it('maps update_available to UI available so backend can auto-start download', () => {
    const stored = writeState({
      schemaVersion: 1,
      status: 'update_available',
      version: '1.5.22',
      installedVersion: '1.5.17',
      remoteVersion: '1.5.22',
      installerFileName: 'Verstak-Setup-1.5.22-x64.exe',
      installerSha512: 'sha',
      installerSize: 123,
      pendingRelease: false,
      updatedAt: Date.now(),
    })

    expect(toUiSnapshot(stored)).toMatchObject({
      phase: 'available',
      version: '1.5.22',
      pendingRelease: false,
    })
  })

  it('uses lock file to reject concurrent updater operations', () => {
    const release = acquireLock('download', '1.5.22')
    expect(() => acquireLock('extract', '1.5.22')).toThrow(/busy/i)
    release()
    const releaseAgain = acquireLock('extract', '1.5.22')
    releaseAgain()
  })

  it('rejects empty app.asar and accepts a versioned payload', async () => {
    const rootPayload = payloadRoot('1.5.22')
    mkdirSync(join(rootPayload, 'resources'), { recursive: true })
    writeFileSync(join(rootPayload, 'Verstak.exe'), 'exe')
    writeFileSync(join(rootPayload, 'resources', 'app.asar'), '')
    expect(verifyPayloadRoot(rootPayload, '1.5.22')).toMatchObject({
      ok: false,
      error: 'Повреждён payload: пустой файл resources\\app.asar',
    })

    await writeVersionedAsar(join(rootPayload, 'resources', 'app.asar'), '1.5.22')
    expect(verifyPayloadRoot(rootPayload, '1.5.22')).toMatchObject({
      ok: true,
      version: '1.5.22',
    })
  })

  it('resetState returns updater to idle without touching payload files', async () => {
    const rootPayload = payloadRoot('1.5.22')
    mkdirSync(join(rootPayload, 'resources'), { recursive: true })
    writeFileSync(join(rootPayload, 'Verstak.exe'), 'exe')
    await writeVersionedAsar(join(rootPayload, 'resources', 'app.asar'), '1.5.22')

    resetState()
    expect(readState()?.status).toBe('idle')
    expect(verifyPayloadRoot(rootPayload, '1.5.22').ok).toBe(true)
  })
})

// Фиксы по ревью автообновления (зона F): восстановление из застрявшего installing
// + идемпотентность install. recoverReadyPayload и install зовут только state/payload
// модули (не electron app), поэтому тестируются с mock-окном.
describe('autoupdate service: recovery + idempotency', () => {
  const previousLocalAppData = process.env.LOCALAPPDATA
  let root = ''
  const mockWindow = { isDestroyed: () => false, webContents: { send: () => { /* noop */ } } } as never

  beforeEach(() => {
    root = join(tmpdir(), `verstak-autoupdate-svc-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    process.env.LOCALAPPDATA = root
    mkdirSync(autoUpdateRoot(), { recursive: true })
  })
  afterEach(() => {
    process.env.LOCALAPPDATA = previousLocalAppData
    rmSync(root, { recursive: true, force: true })
  })

  async function setupVerifiedPayload(version: string): Promise<void> {
    const payRoot = payloadRoot(version)
    mkdirSync(join(payRoot, 'resources'), { recursive: true })
    writeFileSync(join(payRoot, 'Verstak.exe'), 'exe-bytes')
    await writeVersionedAsar(join(payRoot, 'resources', 'app.asar'), version)
    writeFileSync(join(payloadVersionDir(version), 'verified.json'), JSON.stringify({
      version,
      payloadRoot: payRoot,
      appAsarSize: statSync(join(payRoot, 'resources', 'app.asar')).size,
      exeSize: statSync(join(payRoot, 'Verstak.exe')).size,
      verifiedAt: Date.now(),
    }))
  }

  it('recover: застрявший installing + валидный payload → payload_ready (рабочая кнопка)', async () => {
    await setupVerifiedPayload('1.5.23')
    writeState({ schemaVersion: 1, status: 'installing', version: '1.5.23', updatedAt: Date.now() })
    ;(new AutoUpdateService(mockWindow) as unknown as { recoverReadyPayload(): void }).recoverReadyPayload()
    expect(readState()?.status).toBe('payload_ready')
  })

  it('recover: застрявший installing БЕЗ payload → failed_recoverable (не вечный спиннер)', () => {
    writeState({ schemaVersion: 1, status: 'installing', version: '1.5.23', updatedAt: Date.now() })
    ;(new AutoUpdateService(mockWindow) as unknown as { recoverReadyPayload(): void }).recoverReadyPayload()
    const s = readState()
    expect(s?.status).toBe('failed_recoverable')
    expect(s?.error).toMatch(/прервалась/i)
  })

  it('install идемпотентен: повторный вызов в статусе installing не спавнит второй хелпер', async () => {
    writeState({ schemaVersion: 1, status: 'installing', version: '1.5.23', updatedAt: Date.now() })
    const result = await new AutoUpdateService(mockWindow).install()
    expect(result).toEqual({ ok: true, reason: 'already-installing' })
    expect(readState()?.status).toBe('installing')
  })
})
