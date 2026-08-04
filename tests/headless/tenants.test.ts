import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'

// Мульти-тенантные секреты (Этап 1а, блок №7). Мок electron кидает — сервис живёт
// в чистом Node.
vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

const { createTenantRegistry, deriveTenantKey, tenantDirName } = await import('../../electron/headless/tenants')
const { createAesGcmSafeStorage } = await import('../../electron/headless/secure-storage')
const { openDb } = await import('../../electron/storage/db')

describe('мульти-тенантность headless-сервиса (Этап 1а, №7)', () => {
  let root: string
  let registry: ReturnType<typeof createTenantRegistry>
  const masterKey = randomBytes(32)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vsk-tenants-'))
    registry = createTenantRegistry({ root, masterKey })
  })
  afterEach(async () => {
    await registry.closeAll()
    rmSync(root, { recursive: true, force: true })
  })

  it('у каждого тенанта свой каталог и своя БД', async () => {
    const a = await registry.get('user-a@example.com')
    const b = await registry.get('user-b@example.com')
    expect(a.workspaceRoot).not.toBe(b.workspaceRoot)
    expect(readdirSync(root).length).toBe(2)
    expect(existsSync(join(root, tenantDirName('user-a@example.com'), 'verstak.db'))).toBe(true)
  })

  it('секрет одного тенанта не виден другому', async () => {
    const a = await registry.get('user-a')
    const b = await registry.get('user-b')
    a.host.setSecret('deepseek_api_key', 'ключ-пользователя-A')
    expect(a.host.getSecret('deepseek_api_key')).toBe('ключ-пользователя-A')
    expect(b.host.getSecret('deepseek_api_key')).toBeNull()
  })

  it('КЛЮЧЕВОЕ: шифртекст тенанта A не расшифровывается ключом тенанта B', async () => {
    const a = await registry.get('user-a')
    a.host.setSecret('deepseek_api_key', 'ключ-пользователя-A')
    const raw = openDb(join(root, tenantDirName('user-a'), 'verstak.db'))
    let stored: string
    try {
      stored = (raw.prepare('SELECT value FROM settings WHERE key = ?').get('deepseek_api_key') as { value: string }).value
    } finally { raw.close() }
    const keyB = createAesGcmSafeStorage(deriveTenantKey(masterKey, 'user-b'))
    expect(() => keyB.decryptString(Buffer.from(stored, 'base64'))).toThrow()
    // Контрольный кейс: СВОИМ ключом то же значение читается — иначе тест доказывал бы
    // лишь то, что значение битое, а не что изоляция работает.
    const keyA = createAesGcmSafeStorage(deriveTenantKey(masterKey, 'user-a'))
    expect(keyA.decryptString(Buffer.from(stored, 'base64'))).toBe('ключ-пользователя-A')
  })

  it('env процесса НЕ подмешивается в секреты тенанта', async () => {
    const withEnv = createTenantRegistry({ root: join(root, 'iso'), masterKey })
    try {
      const t = await withEnv.get('user-env')
      // Даже если у процесса есть ключ в окружении, тенант его не видит.
      process.env.DEEPSEEK_API_KEY = 'ключ-процесса'
      expect(t.host.getSecret('deepseek_api_key')).toBeNull()
    } finally {
      delete process.env.DEEPSEEK_API_KEY
      await withEnv.closeAll()
    }
  })

  it('повторный get отдаёт тот же хост (не плодит подключения к БД)', async () => {
    const a1 = await registry.get('user-a')
    const a2 = await registry.get('user-a')
    expect(a2.host).toBe(a1.host)
  })

  it('connectorStatus отдаёт ИМЕНА недостающих ключей и никогда значения', async () => {
    const a = await registry.get('user-a')
    a.host.setSecret('telegram_bot_token', 'секрет-бота-НЕ-показывать')
    const status = await registry.connectorStatus('user-a')
    const serialized = JSON.stringify(status)
    expect(serialized).not.toContain('секрет-бота-НЕ-показывать')
    const gsheets = status.find(s => s.id === 'gsheets')
    expect(gsheets?.missingKeys.length ?? 0).toBeGreaterThan(0)
    // Заданный ключ из списка недостающих ушёл.
    const telegram = status.find(s => s.id === 'telegram')
    expect(telegram?.missingKeys).not.toContain('telegram_bot_token')
    // ssh выключен на сервере Этапа 1 — его нет в выдаче вовсе.
    expect(status.some(s => s.id === 'ssh')).toBe(false)
  })

  it('deriveTenantKey: разные тенанты → разные ключи, один тенант → стабильный ключ', () => {
    const k1 = deriveTenantKey(masterKey, 'user-a')
    const k2 = deriveTenantKey(masterKey, 'user-a')
    const k3 = deriveTenantKey(masterKey, 'user-b')
    expect(k1.equals(k2)).toBe(true)
    expect(k1.equals(k3)).toBe(false)
    expect(k1.length).toBe(32)
    // Мастер-ключ не восстанавливается из производного (HKDF односторонняя).
    expect(k1.equals(masterKey)).toBe(false)
  })
})
