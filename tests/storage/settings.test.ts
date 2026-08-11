import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createSettings } from '../../electron/storage/settings'

// Stub safeStorage for tests — in real Electron it encrypts via OS
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8')
}

describe('settings', () => {
  let dir: string
  let db: Database
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-')) })
  afterEach(() => {
    db?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null for missing key', () => {
    db = openDb(join(dir, 't.db'))
    const settings = createSettings(db, fakeSafeStorage)
    expect(settings.getSecret('gemini_api_key')).toBeNull()
  })

  it('roundtrips encrypted secret', () => {
    db = openDb(join(dir, 't.db'))
    const settings = createSettings(db, fakeSafeStorage)
    settings.setSecret('gemini_api_key', 'AIzaSyTest123')
    expect(settings.getSecret('gemini_api_key')).toBe('AIzaSyTest123')
  })

  // Б3.2 (живая приёмка 11.08): dev-прогон на реальном профиле не может
  // расшифровать DPAPI/os_crypt-blob чужого окружения — decryptString падает,
  // а catch-фолбэк декодировал ЗАШИФРОВАННЫЕ байты как UTF-8 и отдавал их
  // потребителю как значение. Так `last_whats_new_version` превратился в
  // «С vv10}s�67W������$k�G…» в заголовке модалки «Пропущенные обновления».
  // Тот же класс ждёт prod после переустановки со сменой os_crypt-ключа.
  // Правило: значение, нечитаемое в этом окружении, — это ОТСУТСТВИЕ значения
  // (null), а не мусор.
  it('нерасшифровываемый blob → null, а не кракозябры (живой факт 11.08)', () => {
    db = openDb(join(dir, 't.db'))
    // Пишущее окружение «шифрует» в бинарь, похожий на os_crypt v10-blob.
    const writer = createSettings(db, {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.concat([
        Buffer.from('v10'),
        Buffer.from([0x7d, 0x73, 0xd9, 0x86, 0x37, 0x57, 0x00, 0x9c, 0xfe, 0x01, 0x84, 0x6b, 0xd0, 0x47, 0x7b, 0x05]),
      ]),
      decryptString: (b: Buffer) => b.toString('utf8'),
    })
    writer.setSecret('last_whats_new_version', '2.4.9')
    // Читающее окружение blob расшифровать НЕ может (чужой Local State).
    const reader = createSettings(db, {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(s, 'utf8'),
      decryptString: () => { throw new Error('decrypt failed: key mismatch') },
    })
    expect(reader.getSecret('last_whats_new_version'),
      'зашифрованные байты уехали потребителю как «значение»').toBeNull()
  })

  // КОНТРОЛЬ «происходит»: легитимный сценарий «записано plain (base64 без
  // шифрования), читаем в окружении с шифрованием» обязан ПРОДОЛЖАТЬ работать —
  // ради него catch-фолбэк и существует.
  it('контроль: plain-base64 значение читается и там, где decryptString падает', () => {
    db = openDb(join(dir, 't.db'))
    const plainWriter = createSettings(db, {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf8'),
      decryptString: (b: Buffer) => b.toString('utf8'),
    })
    plainWriter.setSecret('last_whats_new_version', '2.4.9')
    const reader = createSettings(db, {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(s, 'utf8'),
      decryptString: () => { throw new Error('not encrypted') },
    })
    expect(reader.getSecret('last_whats_new_version')).toBe('2.4.9')
    // Кириллица и переносы строк — читаемый текст, не «мусор».
    plainWriter.setSecret('note', 'правило проекта\nвторая строка\tтаб')
    expect(reader.getSecret('note')).toBe('правило проекта\nвторая строка\tтаб')
  })
})
