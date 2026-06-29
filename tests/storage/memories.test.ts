import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as DB } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { saveMemory, searchMemories, listMemories, deleteMemory, buildFtsMatch, invalidateMemory } from '../../electron/storage/memories'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('memories storage', () => {
  let dir: string
  let db: DB

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-mem-'))
    db = openDb(join(dir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const PROJECT = '/home/user/my-project'
  const OTHER = '/home/user/other-project'

  describe('saveMemory', () => {
    it('creates a memory and returns the Memory object', () => {
      const mem = saveMemory(db, PROJECT, 'fact', 'TypeScript strict mode is enabled', ['ts', 'config'])
      expect(mem.id).toBeTruthy()
      expect(mem.project_path).toBe(PROJECT)
      expect(mem.type).toBe('fact')
      expect(mem.content).toBe('TypeScript strict mode is enabled')
      expect(mem.tags).toEqual(['ts', 'config'])
      expect(mem.created_at).toBeGreaterThan(0)
      expect(mem.accessed_at).toBe(mem.created_at)
    })

    it('persists to DB — listMemories returns it', () => {
      saveMemory(db, PROJECT, 'decision', 'Use FTS5 for search', [])
      const list = listMemories(db, PROJECT)
      expect(list).toHaveLength(1)
      expect(list[0].content).toBe('Use FTS5 for search')
    })

    it('tags are stored as JSON and parsed back to array', () => {
      saveMemory(db, PROJECT, 'pattern', 'Always use prepared statements', ['sql', 'security'])
      const list = listMemories(db, PROJECT)
      expect(list[0].tags).toEqual(['sql', 'security'])
    })

    it('duplicate content: last write wins on type and tags', () => {
      saveMemory(db, PROJECT, 'bug', 'X', ['a'])
      const second = saveMemory(db, PROJECT, 'decision', 'X', ['b'])

      // returned object должен отражать новые type/tags
      expect(second.type).toBe('decision')
      expect(second.tags).toEqual(['b'])

      // в БД должна остаться ровно одна строка с обновлёнными полями
      const list = listMemories(db, PROJECT)
      expect(list).toHaveLength(1)
      expect(list[0].type).toBe('decision')
      expect(list[0].tags).toEqual(['b'])
    })
  })

  describe('listMemories', () => {
    it('returns empty array for unknown project', () => {
      expect(listMemories(db, '/nonexistent')).toEqual([])
    })

    it('returns only memories for the given project', () => {
      saveMemory(db, PROJECT, 'fact', 'fact for project', [])
      saveMemory(db, OTHER, 'fact', 'fact for other', [])
      const list = listMemories(db, PROJECT)
      expect(list).toHaveLength(1)
      expect(list[0].content).toBe('fact for project')
    })

    it('orders by accessed_at DESC', () => {
      const a = saveMemory(db, PROJECT, 'fact', 'first', [])
      // Форсируем разные accessed_at через прямой update
      db.prepare('UPDATE memories SET accessed_at = ? WHERE id = ?').run(1000, a.id)
      const b = saveMemory(db, PROJECT, 'fact', 'second', [])
      db.prepare('UPDATE memories SET accessed_at = ? WHERE id = ?').run(2000, b.id)

      const list = listMemories(db, PROJECT)
      expect(list[0].content).toBe('second')
      expect(list[1].content).toBe('first')
    })
  })

  describe('searchMemories', () => {
    beforeEach(() => {
      saveMemory(db, PROJECT, 'fact', 'TypeScript compiler options', ['ts', 'build'])
      saveMemory(db, PROJECT, 'bug', 'FTS5 triggers update rowid correctly', ['fts', 'sqlite'])
      saveMemory(db, PROJECT, 'preference', 'prefer single quotes in code', ['style'])
      saveMemory(db, OTHER, 'fact', 'unrelated other project fact', [])
    })

    it('returns most recent memories when query is empty', () => {
      const results = searchMemories(db, PROJECT, '', 10)
      expect(results).toHaveLength(3)
      // все принадлежат нашему проекту
      expect(results.every(r => r.project_path === PROJECT)).toBe(true)
    })

    it('does not return memories from other projects on empty query', () => {
      const results = searchMemories(db, PROJECT, '', 10)
      expect(results.some(r => r.project_path === OTHER)).toBe(false)
    })

    it('finds memories by FTS5 content match', () => {
      const results = searchMemories(db, PROJECT, 'TypeScript', 5)
      expect(results).toHaveLength(1)
      expect(results[0].content).toContain('TypeScript')
    })

    it('does not return memories from other projects on FTS search', () => {
      const results = searchMemories(db, PROJECT, 'unrelated', 5)
      expect(results).toHaveLength(0)
    })

    // #1 релевантный recall: сырое NL-сообщение со спецсимволами FTS5 раньше ломало
    // парсер → []. Теперь санитайзится и находит релевантное.
    it('NL-запрос со спецсимволами FTS5 не падает + находит релевантное', () => {
      const results = searchMemories(db, PROJECT, 'почему "TypeScript" (compiler) ломается?', 5)
      expect(results.length).toBeGreaterThan(0)
      expect(results.some(r => r.content.includes('TypeScript'))).toBe(true)
    })

    it('непустой запрос без совпадений → пусто (memory_search без recency-шума)', () => {
      const results = searchMemories(db, PROJECT, 'абвгдежзсовершеннодругое', 5)
      expect(results).toHaveLength(0)
    })

    it('respects limit parameter', () => {
      const results = searchMemories(db, PROJECT, '', 2)
      expect(results).toHaveLength(2)
    })

    it('updates accessed_at for returned records', () => {
      // Встроить старое время через прямой UPDATE
      const oldTime = Date.now() - 10000
      db.prepare(`UPDATE memories SET accessed_at = ? WHERE project_path = ?`).run(oldTime, PROJECT)

      searchMemories(db, PROJECT, 'TypeScript', 5)

      const updated = listMemories(db, PROJECT).find(m => m.content.includes('TypeScript'))!
      expect(updated.accessed_at).toBeGreaterThan(oldTime)
    })
  })

  describe('deleteMemory', () => {
    it('returns true and removes the record', () => {
      const mem = saveMemory(db, PROJECT, 'fact', 'to be deleted', [])
      const deleted = deleteMemory(db, mem.id)
      expect(deleted).toBe(true)
      expect(listMemories(db, PROJECT)).toHaveLength(0)
    })

    it('returns false for non-existent id', () => {
      expect(deleteMemory(db, 'non-existent-uuid')).toBe(false)
    })

    it('does not affect other memories', () => {
      const a = saveMemory(db, PROJECT, 'fact', 'keep this', [])
      const b = saveMemory(db, PROJECT, 'fact', 'delete this', [])
      deleteMemory(db, b.id)
      const list = listMemories(db, PROJECT)
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe(a.id)
    })
  })

  // #1 релевантный recall — санитайзер NL→FTS5 (чистая функция).
  describe('buildFtsMatch', () => {
    it('токены ≥3 в кавычках через OR; <3 и спецсимволы дропаются; пусто→пусто', () => {
      expect(buildFtsMatch('почини баг с FTS5')).toBe('"почини" OR "баг" OR "fts5"')
      expect(buildFtsMatch('a "b" (c)')).toBe('') // все токены <3 → пусто
      expect(buildFtsMatch('   ')).toBe('')
    })
  })
  describe('invalidateMemory (ось 4 #3 soft-invalidate)', () => {
    it('суперсеженное воспоминание выпадает из recall+list, но физически остаётся', () => {
      const db2 = openDb(join(dir, 'inv.db'))
      const m = saveMemory(db2, PROJECT, 'fact', 'проект использует webpack', ['build'])
      const m2 = saveMemory(db2, PROJECT, 'fact', 'проект перешёл на vite', ['build'])
      expect(invalidateMemory(db2, m.id, m2.id)).toBe(true)
      expect(searchMemories(db2, PROJECT, 'webpack', 5).find(x => x.id === m.id)).toBeUndefined()
      expect(listMemories(db2, PROJECT).find(x => x.id === m.id)).toBeUndefined()
      const raw = db2.prepare('SELECT superseded_by FROM memories WHERE id = ?').get(m.id) as { superseded_by: string }
      expect(raw.superseded_by).toBe(m2.id) // история сохранена
      db2.close()
    })
    it('повторная инвалидация → false (уже инвалидирован)', () => {
      const db2 = openDb(join(dir, 'inv2.db'))
      const m = saveMemory(db2, PROJECT, 'fact', 'x', [])
      expect(invalidateMemory(db2, m.id)).toBe(true)
      expect(invalidateMemory(db2, m.id)).toBe(false)
      db2.close()
    })
    it('ре-сохранение того же факта ВОСКРЕШАЕТ invalidated (ревью HIGH — не тихая потеря)', () => {
      const db2 = openDb(join(dir, 'inv3.db'))
      saveMemory(db2, PROJECT, 'fact', 'проект на vite', ['build'])
      const found = searchMemories(db2, PROJECT, 'vite', 5).find(x => x.content === 'проект на vite')!
      invalidateMemory(db2, found.id)
      expect(searchMemories(db2, PROJECT, 'vite', 5).find(x => x.content === 'проект на vite')).toBeUndefined()
      // снова явно сохраняем тот же факт → должен вернуться в recall
      saveMemory(db2, PROJECT, 'fact', 'проект на vite', ['build'])
      expect(searchMemories(db2, PROJECT, 'vite', 5).find(x => x.content === 'проект на vite')).toBeDefined()
      db2.close()
    })
  })
})
