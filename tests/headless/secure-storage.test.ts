import { describe, it, expect } from 'vitest'
import { randomBytes } from 'crypto'
import { createAesGcmSafeStorage, masterKeyFromEnv } from '../../electron/headless/secure-storage'

// Серверная замена safeStorage (Этап 1а, блок №2). sqlite не нужна — чистое крипто.

describe('AES-GCM SafeStorageLike — серверное хранилище секретов', () => {
  const key = randomBytes(32)

  it('roundtrip: encrypt → decrypt возвращает исходную строку', () => {
    const safe = createAesGcmSafeStorage(key)
    const secret = 'sk-live-очень-секретный-ключ-1234567890'
    expect(safe.decryptString(safe.encryptString(secret))).toBe(secret)
  })

  it('шифртекст не содержит плейнтекста и различается между вызовами (случайный IV)', () => {
    const safe = createAesGcmSafeStorage(key)
    const a = safe.encryptString('same-secret-value')
    const b = safe.encryptString('same-secret-value')
    expect(a.includes(Buffer.from('same-secret-value'))).toBe(false)
    expect(a.equals(b)).toBe(false)
  })

  it('подмена байта шифртекста → decrypt кидает (GCM-аутентификация)', () => {
    const safe = createAesGcmSafeStorage(key)
    const enc = safe.encryptString('tamper-me')
    enc[enc.length - 1] ^= 0xff
    expect(() => safe.decryptString(enc)).toThrow()
  })

  it('чужой ключ → decrypt кидает, а не отдаёт мусор', () => {
    const enc = createAesGcmSafeStorage(key).encryptString('cross-key')
    const other = createAesGcmSafeStorage(randomBytes(32))
    expect(() => other.decryptString(enc)).toThrow()
  })

  it('ключ не 32 байта → отказ на создании (fail-closed)', () => {
    expect(() => createAesGcmSafeStorage(randomBytes(16))).toThrow(/32 байта/)
  })

  it('неизвестная версия формата → отказ', () => {
    const safe = createAesGcmSafeStorage(key)
    const enc = safe.encryptString('x')
    enc[0] = 0x02
    expect(() => safe.decryptString(enc)).toThrow(/формат/)
  })
})

describe('masterKeyFromEnv', () => {
  it('base64 и hex по 32 байта принимаются', () => {
    const raw = randomBytes(32)
    expect(masterKeyFromEnv({ VERSTAK_MASTER_KEY: raw.toString('base64') }).equals(raw)).toBe(true)
    expect(masterKeyFromEnv({ VERSTAK_MASTER_KEY: raw.toString('hex') }).equals(raw)).toBe(true)
  })

  it('отсутствие ключа → throw с именем переменной (fail-closed, не тихий фолбэк)', () => {
    expect(() => masterKeyFromEnv({})).toThrow(/VERSTAK_MASTER_KEY/)
  })

  it('неверная длина → throw', () => {
    expect(() => masterKeyFromEnv({ VERSTAK_MASTER_KEY: randomBytes(16).toString('base64') })).toThrow(/32 байта/)
  })
})
