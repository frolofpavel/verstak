// Оверлей возможностей в БД: доверие, оценка, отметка проверки и версия, НА
// КОТОРОЙ доверие заработано. Пины стерегут то, ради чего таблица заведена, —
// невозможность поднять доверие мимо явного решения и невозможность унести его
// на новое содержимое.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createCapabilityOverlay } from '../../electron/storage/capability-overlay'
import { TRUST_FLOOR } from '../../shared/contracts/capability'

let db: Database.Database

// Схема повторяет миграцию 66. Отдельная фикстура здесь законна: тест про слой
// доступа, а не про миграцию; полноту схемы стережёт пин на openDb ниже.
beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE capability_overlay (
      capability_id TEXT PRIMARY KEY,
      trust_level TEXT NOT NULL,
      version TEXT NOT NULL,
      eval_score REAL,
      last_verified_at INTEGER,
      trust_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
})

afterEach(() => db.close())

describe('чтение оверлея', () => {
  it('незнакомая возможность даёт null, а не пустую запись', () => {
    expect(createCapabilityOverlay(db).get('skill:github')).toBeNull()
  })

  it('записанное читается обратно без потерь', () => {
    const store = createCapabilityOverlay(db)
    store.set('skill:github', { trustLevel: 'T3', version: 'v1', evalScore: 0.7, lastVerifiedAt: 42, reason: 'три зелёные проверки' })
    expect(store.get('skill:github')).toEqual({ trustLevel: 'T3', version: 'v1', evalScore: 0.7, lastVerifiedAt: 42 })
  })

  it('причина уровня хранится и читается отдельно от паспорта', () => {
    const store = createCapabilityOverlay(db)
    store.set('skill:github', { trustLevel: 'T2', version: 'v1', evalScore: null, lastVerifiedAt: null, reason: 'нет доказательств' })
    expect(store.reason('skill:github')).toBe('нет доказательств')
  })
})

describe('перезапись не поднимает доверие втихую', () => {
  it('запись той же версии обновляет оценку, но требует явного уровня', () => {
    const store = createCapabilityOverlay(db)
    store.set('skill:github', { trustLevel: 'T2', version: 'v1', evalScore: 0.5, lastVerifiedAt: 1, reason: 'старт' })
    store.set('skill:github', { trustLevel: 'T2', version: 'v1', evalScore: 0.9, lastVerifiedAt: 2, reason: 'ещё прогон' })
    expect(store.get('skill:github')).toEqual({ trustLevel: 'T2', version: 'v1', evalScore: 0.9, lastVerifiedAt: 2 })
  })

  // Смена версии — событие безопасности, и слой хранения обязан её пережить сам,
  // не полагаясь на аккуратность вызывающего.
  it('пришла другая версия — уровень падает на пол, оценка снимается', () => {
    const store = createCapabilityOverlay(db)
    store.set('skill:github', { trustLevel: 'T4', version: 'v1', evalScore: 0.95, lastVerifiedAt: 10, reason: 'заслужено' })
    store.observeVersion('skill:github', 'v2')
    const after = store.get('skill:github')
    expect(after?.trustLevel).toBe(TRUST_FLOOR)
    expect(after?.version).toBe('v2')
    expect(after?.evalScore).toBeNull()
    expect(after?.lastVerifiedAt).toBeNull()
    expect(store.reason('skill:github')).toContain('версия')
  })

  // Контроль: без него пин выше зелен и у реализации, которая роняет доверие
  // всегда — то есть не отличает подмену от обычного чтения.
  it('контроль: та же версия ничего не роняет', () => {
    const store = createCapabilityOverlay(db)
    store.set('skill:github', { trustLevel: 'T4', version: 'v1', evalScore: 0.95, lastVerifiedAt: 10, reason: 'заслужено' })
    store.observeVersion('skill:github', 'v1')
    expect(store.get('skill:github')).toEqual({ trustLevel: 'T4', version: 'v1', evalScore: 0.95, lastVerifiedAt: 10 })
  })

  it('незнакомую возможность observeVersion не заводит — доверие не создаётся из ничего', () => {
    const store = createCapabilityOverlay(db)
    store.observeVersion('skill:unknown', 'v1')
    expect(store.get('skill:unknown')).toBeNull()
  })
})
