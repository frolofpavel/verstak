import type { Database } from 'better-sqlite3'

export interface SafeStorageLike {
  isEncryptionAvailable: () => boolean
  encryptString: (plaintext: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

export interface Settings {
  getSecret: (key: string) => string | null
  setSecret: (key: string, value: string) => void
}

/** Читаемый ли это текст, а не декодированные как UTF-8 зашифрованные байты:
 *  U+FFFD (битые последовательности) и управляющие символы (кроме \t\n\r) в
 *  легитимных значениях настроек не встречаются. */
function looksLikeReadableText(s: string): boolean {
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/.test(s)
}

/** Plain-base64 фолбэк: отдаёт значение ТОЛЬКО если оно читаемый текст.
 *  Зашифрованный blob, декодированный как UTF-8, — мусор, а не значение → null. */
function plainDecodeIfReadable(value: string): string | null {
  const decoded = Buffer.from(value, 'base64').toString('utf-8')
  return looksLikeReadableText(decoded) ? decoded : null
}

export function createSettings(db: Database, safe: SafeStorageLike): Settings {
  const stmtGet = db.prepare('SELECT value FROM settings WHERE key = ?')
  const stmtSet = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )

  // На Linux без libsecret (gnome-keyring / KDE wallet) safeStorage недоступен.
  // Fallback: base64 без шифрования. Не идеально, но лучше чем крэш при старте.
  const canEncrypt = safe.isEncryptionAvailable()

  return {
    getSecret(key) {
      const row = stmtGet.get(key) as { value: string } | undefined
      if (!row) return null
      try {
        if (canEncrypt) {
          const buf = Buffer.from(row.value, 'base64')
          return safe.decryptString(buf)
        }
        // Fallback: значение хранится как plain base64
        return plainDecodeIfReadable(row.value)
      } catch {
        // Если ключ записан одним способом а читаем другим — попробуем plain.
        // Б3.2 (живая приёмка 11.08): сюда попадает и DPAPI/os_crypt-blob чужого
        // окружения (dev на реальном профиле; prod после переустановки со сменой
        // ключа) — его БАЙТЫ нельзя отдавать как «значение»: так
        // last_whats_new_version стал кракозябрами в заголовке модалки
        // «Пропущенные обновления». Нечитаемое в этом окружении = null.
        try { return plainDecodeIfReadable(row.value) } catch { return null }
      }
    },
    setSecret(key, value) {
      if (canEncrypt) {
        const encrypted = safe.encryptString(value).toString('base64')
        stmtSet.run(key, encrypted)
      } else {
        // Fallback: base64 без шифрования
        stmtSet.run(key, Buffer.from(value, 'utf-8').toString('base64'))
      }
    }
  }
}
