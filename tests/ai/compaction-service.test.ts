import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Database as DB } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { compactChatContext, contextState } from '../../electron/ai/compaction-service'
import type { CompactionDeps } from '../../electron/ai/compaction-service'
import { activeSnapshot } from '../../electron/storage/chat-context-snapshots'
import type { CompactableMessage } from '../../electron/ai/manual-compaction'

/**
 * Срез 2.0.11-B: ручная компакция целиком.
 *
 * Главный инвариант, который здесь и проверяется: при ЛЮБОЙ осечке предыдущий контекст
 * остаётся рабочим. «Осечка» = идёт прогон, упала модель, пустой ответ, пришло новое
 * сообщение. Ни один из этих путей не смеет ничего записать.
 */

let dir: string
let db: DB

const CHAT = 7

const msg = (chatId: number, role: string, content: string): number => {
  const info = db.prepare(
    "INSERT INTO chats (project_path, session_id, role, content, created_at) VALUES ('/p', ?, ?, ?, 1)"
  ).run(chatId, role, content)
  return info.lastInsertRowid as number
}

/** Наполнить чат n сообщениями и вернуть их как список для loadMessages. */
const seed = (chatId: number, n: number): CompactableMessage[] => {
  const out: CompactableMessage[] = []
  for (let i = 0; i < n; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant'
    const content = `сообщение ${i + 1}`
    const dbId = msg(chatId, role, content)
    out.push({ role: role as 'user' | 'assistant', content, dbId })
  }
  return out
}

const deps = (messages: CompactableMessage[], over: Partial<CompactionDeps> = {}): CompactionDeps => ({
  loadMessages: () => messages,
  summarize: async () => 'итог разговора',
  hasActiveRun: () => false,
  now: () => 1000,
  providerId: 'claude',
  model: 'claude-opus-4-8',
  ...over,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vst-compact-'))
  db = openDb(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ручная компакция — успешный путь', () => {
  it('сжимает и возвращает честные цифры', async () => {
    const messages = seed(CHAT, 20)
    const r = await compactChatContext(db, CHAT, deps(messages))

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.compactedCount).toBe(14)
    expect(r.keptCount).toBe(6)
    expect(r.snapshot.summary).toBe('итог разговора')
    expect(r.snapshot.providerId).toBe('claude')
  })

  it('снапшот записан и читается как активный (переживёт рестарт)', async () => {
    await compactChatContext(db, CHAT, deps(seed(CHAT, 20)))
    const snap = activeSnapshot(db, CHAT)
    expect(snap).not.toBeNull()
    expect(snap!.summary).toBe('итог разговора')
  })

  // Сообщения человека — не расходный материал сжатия.
  it('видимая переписка НЕ тронута: все 20 сообщений на месте', async () => {
    await compactChatContext(db, CHAT, deps(seed(CHAT, 20)))
    const count = db.prepare('SELECT COUNT(*) as c FROM chats WHERE session_id = ?').get(CHAT) as { c: number }
    expect(count.c).toBe(20)
  })

  it('оценка «после» меньше оценки «до» (сжатие имеет смысл)', async () => {
    const r = await compactChatContext(db, CHAT, deps(seed(CHAT, 20)))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.snapshot.estimatedTokensAfter!).toBeLessThan(r.snapshot.estimatedTokensBefore!)
  })
})

describe('ручная компакция — осечки НЕ портят контекст', () => {
  it('идёт прогон → busy, ничего не записано', async () => {
    const r = await compactChatContext(db, CHAT, deps(seed(CHAT, 20), { hasActiveRun: () => true }))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('busy')
    expect(activeSnapshot(db, CHAT)).toBeNull()
  })

  it('идёт прогон → модель даже не вызывается (не жжём деньги впустую)', async () => {
    let called = 0
    await compactChatContext(db, CHAT, deps(seed(CHAT, 20), {
      hasActiveRun: () => true,
      summarize: async () => { called++; return 'итог' },
    }))
    expect(called).toBe(0)
  })

  it('модель упала → summary-failed, активный снапшот не тронут', async () => {
    const messages = seed(CHAT, 20)
    const r = await compactChatContext(db, CHAT, deps(messages, {
      summarize: async () => { throw new Error('429 rate limit') },
    }))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('summary-failed')
    expect(r.ok === false && r.detail).toContain('429')
    expect(activeSnapshot(db, CHAT)).toBeNull()
  })

  // Пустой summary = стереть начало разговора, не дав ничего взамен.
  it('модель вернула пустоту → summary-failed, пустой снапшот НЕ записан', async () => {
    const r = await compactChatContext(db, CHAT, deps(seed(CHAT, 20), { summarize: async () => '   ' }))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('summary-failed')
    expect(activeSnapshot(db, CHAT)).toBeNull()
  })

  // Суммаризация занимает секунды — за это время человек успевает дописать.
  it('пришло новое сообщение во время summary → conflict, не записано ничего', async () => {
    const messages = seed(CHAT, 20)
    const r = await compactChatContext(db, CHAT, deps(messages, {
      summarize: async () => {
        msg(CHAT, 'user', 'а ещё вот что') // человек дописал, пока считали
        return 'итог'
      },
    }))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('conflict')
    expect(activeSnapshot(db, CHAT)).toBeNull()
  })

  it('осечка при существующем снапшоте → СТАРЫЙ снапшот остаётся рабочим', async () => {
    const messages = seed(CHAT, 20)
    await compactChatContext(db, CHAT, deps(messages, { summarize: async () => 'первый итог' }))

    const more = [...messages, ...seed(CHAT, 10)]
    await compactChatContext(db, CHAT, deps(more, { summarize: async () => { throw new Error('упало') } }))

    expect(activeSnapshot(db, CHAT)!.summary).toBe('первый итог') // не затёрт осечкой
  })

  it('короткий чат → nothing-to-compact', async () => {
    const r = await compactChatContext(db, CHAT, deps(seed(CHAT, 3)))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('nothing-to-compact')
  })

  it('пустой чат → nothing-to-compact, без падения', async () => {
    const r = await compactChatContext(db, CHAT, deps([]))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('nothing-to-compact')
  })
})

describe('повторная компакция', () => {
  it('второй раз поверх первого → новый активный, старый остаётся в истории', async () => {
    const messages = seed(CHAT, 20)
    await compactChatContext(db, CHAT, deps(messages, { summarize: async () => 'первый итог' }))
    const more = [...messages, ...seed(CHAT, 10)]
    await compactChatContext(db, CHAT, deps(more, { summarize: async () => 'второй итог' }))

    expect(activeSnapshot(db, CHAT)!.summary).toBe('второй итог')
    const all = db.prepare('SELECT COUNT(*) as c FROM chat_context_snapshots WHERE chat_id = ?').get(CHAT) as { c: number }
    expect(all.c).toBe(2) // журнал, а не замена — путь отката
  })

  it('чаты изолированы: сжатие одного не трогает другой', async () => {
    await compactChatContext(db, CHAT, deps(seed(CHAT, 20)))
    expect(activeSnapshot(db, 99)).toBeNull()
  })
})

describe('состояние контекста для ContextMeter', () => {
  it('до сжатия — честные факты', () => {
    const messages = seed(CHAT, 20)
    const s = contextState(db, CHAT, messages)
    expect(s.totalMessages).toBe(20)
    expect(s.compacted).toBe(false)
    expect(s.compactedThroughMessageId).toBeNull()
    expect(s.canCompact).toBe(true)
    expect(s.estimatedTokens).toBeGreaterThan(0)
  })

  it('после сжатия — показывает границу', async () => {
    const messages = seed(CHAT, 20)
    await compactChatContext(db, CHAT, deps(messages))
    const s = contextState(db, CHAT, messages)
    expect(s.compacted).toBe(true)
    expect(s.compactedThroughMessageId).toBe(14)
  })

  it('короткий чат → кнопка сжатия недоступна', () => {
    expect(contextState(db, CHAT, seed(CHAT, 3)).canCompact).toBe(false)
  })
})
