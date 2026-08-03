import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import type { SafeStorageLike } from '../storage/settings'

// Серверная замена electron.safeStorage (Этап 1а, отчёт §3а headless-recon):
// AES-256-GCM с мастер-ключом из env/KMS. createSettings принимает SafeStorageLike
// интерфейсом, поэтому storage-слой не меняется вовсе.
//
// Формат зашифрованного значения: [1 байт версии = 0x01][12 байт IV][16 байт GCM tag][шифртекст].
// Версия первой — чтобы будущая ротация схемы читала старые значения без эвристик.

const FORMAT_VERSION = 0x01
const IV_LENGTH = 12
const TAG_LENGTH = 16

export function createAesGcmSafeStorage(masterKey: Buffer): SafeStorageLike {
  if (masterKey.length !== 32) {
    throw new Error('AES-GCM хранилище секретов: мастер-ключ обязан быть 32 байта (AES-256)')
  }
  return {
    isEncryptionAvailable: () => true,
    encryptString(plaintext: string): Buffer {
      const iv = randomBytes(IV_LENGTH)
      const cipher = createCipheriv('aes-256-gcm', masterKey, iv)
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), encrypted])
    },
    decryptString(encrypted: Buffer): string {
      if (encrypted.length < 1 + IV_LENGTH + TAG_LENGTH || encrypted[0] !== FORMAT_VERSION) {
        throw new Error('AES-GCM хранилище секретов: неизвестный формат значения')
      }
      const iv = encrypted.subarray(1, 1 + IV_LENGTH)
      const tag = encrypted.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH)
      const data = encrypted.subarray(1 + IV_LENGTH + TAG_LENGTH)
      const decipher = createDecipheriv('aes-256-gcm', masterKey, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
    }
  }
}

/** Мастер-ключ из env: 32 байта в base64 либо 64 hex-символа. Fail-closed: нет/битый → throw. */
export function masterKeyFromEnv(
  env: Record<string, string | undefined> = process.env,
  name = 'VERSTAK_MASTER_KEY'
): Buffer {
  const raw = env[name]?.trim()
  if (!raw) {
    throw new Error(`${name} не задан — headless-хост требует мастер-ключ для секретов`)
  }
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (buf.length !== 32) {
    throw new Error(`${name}: ожидаю 32 байта (base64 или 64 hex-символа)`)
  }
  return buf
}
