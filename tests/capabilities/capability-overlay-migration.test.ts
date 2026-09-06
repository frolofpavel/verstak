// Миграция 66 против фикстуры из capability-overlay-store.test.ts.
//
// Зачем отдельный пин: там схема написана руками. Тест, чья фикстура разошлась с
// продовой формой, ничего не защищает и об этом не сообщает (CLAUDE.md §3.1) —
// здесь тот же слой доступа работает поверх НАСТОЯЩЕЙ базы из openDb, и любое
// расхождение колонок или ограничений становится красным.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createCapabilityOverlay } from '../../electron/storage/capability-overlay'
import { TRUST_FLOOR } from '../../shared/contracts/capability'

describe('capability_overlay в реальной схеме', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'verstak-capability-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const open = () => openDb(join(dir, 'test.db'))

  it('таблица создаётся миграцией и слой доступа с ней работает', () => {
    const db = open()
    const store = createCapabilityOverlay(db)
    store.set('skill:github', { trustLevel: 'T2', version: 'v1', evalScore: 0.5, lastVerifiedAt: 7, reason: 'старт' })
    expect(store.get('skill:github')).toEqual({ trustLevel: 'T2', version: 'v1', evalScore: 0.5, lastVerifiedAt: 7 })
    db.close()
  })

  it('доверие переживает переоткрытие базы', () => {
    const first = open()
    createCapabilityOverlay(first).set('mcp:moex', { trustLevel: 'T3', version: 'v9', evalScore: null, lastVerifiedAt: null, reason: 'проверен' })
    first.close()

    const second = open()
    expect(createCapabilityOverlay(second).get('mcp:moex')?.trustLevel).toBe('T3')
    second.close()
  })

  it('подмена версии роняет доверие и в настоящей базе', () => {
    const db = open()
    const store = createCapabilityOverlay(db)
    store.set('skill:github', { trustLevel: 'T4', version: 'v1', evalScore: 0.9, lastVerifiedAt: 1, reason: 'заслужено' })
    store.observeVersion('skill:github', 'v2')
    expect(store.get('skill:github')?.trustLevel).toBe(TRUST_FLOOR)
    db.close()
  })

  // Ограничение уровня — не украшение схемы: чужой уровень в этой колонке означал
  // бы паспорт с доверием, которого система не умеет сравнивать.
  it('схема не принимает уровень вне T0..T4', () => {
    const db = open()
    expect(() =>
      db.prepare(
        'INSERT INTO capability_overlay (capability_id, trust_level, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run('skill:bad', 'T9', 'v1', 1, 1)
    ).toThrow()
    db.close()
  })

  // Контроль: тот же INSERT с законным уровнем обязан проходить — иначе пин выше
  // зелен просто потому, что вставка не работает вовсе.
  it('контроль: законный уровень схема принимает', () => {
    const db = open()
    expect(() =>
      db.prepare(
        'INSERT INTO capability_overlay (capability_id, trust_level, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run('skill:ok', 'T2', 'v1', 1, 1)
    ).not.toThrow()
    db.close()
  })
})
