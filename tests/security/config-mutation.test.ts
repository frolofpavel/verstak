import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Database } from 'better-sqlite3'
import { TOOL_DEFS } from '../../electron/ai/tools'
import { openDb } from '../../electron/storage/db'
import { createSettings } from '../../electron/storage/settings'

const FORBIDDEN_TOOL_NAME = /(settings?|secret|credential|api[_-]?key|provider[_-]?key|env|token)/i

describe('config mutation guard', () => {
  let dir: string
  let db: Database

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-security-config-'))
  })

  afterEach(() => {
    db?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not expose settings or secret mutation as agent tools', () => {
    const toolNames = TOOL_DEFS.map(tool => tool.name)
    expect(toolNames.filter(name => FORBIDDEN_TOOL_NAME.test(name))).toEqual([])
  })

  it('does not store encrypted settings as plaintext when safeStorage is available', () => {
    const secret = 'verstak-gateway-live-secret-123456'
    const key = 'verstak_gateway_api_key'
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (plaintext: string) => Buffer.from(`cipher:${Buffer.from(plaintext, 'utf8').toString('hex')}`, 'utf8'),
      decryptString: (encrypted: Buffer) => {
        const raw = encrypted.toString('utf8')
        if (!raw.startsWith('cipher:')) throw new Error('bad ciphertext')
        return Buffer.from(raw.slice('cipher:'.length), 'hex').toString('utf8')
      }
    }

    db = openDb(join(dir, 'settings.db'))
    const settings = createSettings(db, safeStorage)

    settings.setSecret(key, secret)

    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string }
    expect(row.value).not.toContain(secret)
    expect(Buffer.from(row.value, 'base64').toString('utf8')).not.toContain(secret)
    expect(settings.getSecret(key)).toBe(secret)
  })
})
