import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createJournal } from '../../electron/storage/journal'
import type { Database } from 'better-sqlite3'

describe('journal session summaries', () => {
  let dir: string
  let db: Database | null = null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-journal-'))
    vi.useFakeTimers()
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a concise structured summary from the real chat dialog', () => {
    vi.setSystemTime(new Date('2026-06-21T09:15:00'))
    db = openDb(join(dir, 'test.db'))
    const journal = createJournal(db)
    insertChat('client-a', 'user', 'Что нужно добавить в программу, а что убрать?')
    insertChat('client-a', 'assistant', 'Добавить стоит журнал решений, настройки автообновления и понятные статусы. Убрать можно лишние всплывающие окна.')
    journal.append('client-a', 'tool', 'Изменён файл src/App.tsx', 'Обновлена страница журнала')

    vi.setSystemTime(new Date('2026-06-21T11:42:00'))
    const summaries = journal.flushSessionSummaries('close')

    expect(summaries).toHaveLength(1)
    expect(summaries[0].kind).toBe('session')
    expect(summaries[0].title).toContain('Сводка сессии')
    const summary = parseSummary(summaries[0].detail)
    expect(summary.type).toBe('session-summary')
    expect(summary.stats.userMessages).toBe(1)
    expect(summary.turns[0].user).toBe('уточнил, что стоит добавить и что убрать в проекте')
    expect(summary.turns[0].assistant).toContain('Дала рекомендации, что добавить или убрать')
    expect(summary.turns[0].assistant).toContain('Зафиксировала выполненные изменения')
    expect(summary.changed[0]).toContain('Изменён файл src/App.tsx')
  })

  it('summarizes an ad campaign audit without keeping the raw answer', () => {
    vi.setSystemTime(new Date('2026-06-21T10:00:00'))
    db = openDb(join(dir, 'test.db'))
    const journal = createJournal(db)
    insertChat('westers', 'user', 'Сделай краткий аудит по РК за неделю')
    insertChat('westers', 'assistant', 'Аудит за 14.06-21.06: есть просадка по CTR, слабые объявления и проблемы с бюджетом. План решения: обновить креативы, перераспределить бюджет и проверить посадочные страницы.')

    vi.setSystemTime(new Date('2026-06-21T10:20:00'))
    const summaries = journal.flushSessionSummaries('close')

    const summary = parseSummary(summaries[0].detail)
    expect(summary.turns[0].user).toBe('запросил краткий аудит по РК за неделю')
    expect(summary.turns[0].assistant).toContain('Отправила краткий аудит')
    expect(summary.turns[0].assistant).toContain('Указала на недостатки и риски')
    expect(summary.turns[0].assistant).toContain('Предоставила план решения проблемы')
    expect(summary.turns[0].assistant).not.toContain('CTR')
  })

  it('hides legacy session fragments from the journal list', () => {
    vi.setSystemTime(new Date('2026-06-21T09:15:00'))
    db = openDb(join(dir, 'test.db'))
    const journal = createJournal(db)

    journal.append('client-a', 'session', 'Что добавить?', 'Старый обрывок')
    journal.append('client-a', 'manual', 'Ручная заметка', null)

    const entries = journal.list('client-a')
    expect(entries).toHaveLength(1)
    expect(entries[0].title).toBe('Ручная заметка')
  })

  it('creates a summary for a chat-only session without raw journal events', () => {
    vi.setSystemTime(new Date('2026-06-21T12:00:00'))
    db = openDb(join(dir, 'test.db'))
    const journal = createJournal(db)
    insertChat('client-a', 'user', 'Какие функции в Запрете лишние?')
    insertChat('client-a', 'assistant', 'Лишними выглядят дублирующие настройки, повторные подсказки и отдельные всплывающие окна без действия.')

    vi.setSystemTime(new Date('2026-06-21T12:30:00'))
    const summaries = journal.flushSessionSummaries('close')

    expect(summaries).toHaveLength(1)
    const summary = parseSummary(summaries[0].detail)
    expect(summary.turns[0].user).toContain('что стоит добавить и что убрать')
    expect(summary.turns[0].assistant).toContain('Дала рекомендации, что добавить или убрать')
    expect(summary.stats.toolEvents).toBe(0)
  })

  it('returns a current session preview without persisting it', () => {
    vi.setSystemTime(new Date('2026-06-21T14:00:00'))
    db = openDb(join(dir, 'test.db'))
    const journal = createJournal(db)
    insertChat('client-a', 'user', 'Собери краткую сводку по клиенту.')
    insertChat('client-a', 'assistant', 'Сводка будет состоять из вопросов пользователя, ответа AI и выполненных действий.')

    const current = journal.currentSession('client-a')

    expect(current?.id).toBe(0)
    expect(current?.title).toContain('Текущая сессия')
    const summary = parseSummary(current?.detail ?? null)
    expect(summary.reason).toBe('current')
    expect(summary.turns[0].user).toContain('запросил краткую сводку')
    expect(journal.list('client-a')).toHaveLength(0)
  })

  it('rolls the active journal window over at local midnight', () => {
    vi.setSystemTime(new Date('2026-06-21T23:50:00'))
    db = openDb(join(dir, 'test.db'))
    const journal = createJournal(db)

    insertChat('client-a', 'user', 'Подготовь дневной отчёт по клиенту.')
    journal.append('client-a', 'tool', 'Создан файл report.md', 'Черновик отчёта')

    vi.setSystemTime(new Date('2026-06-22T00:01:00'))
    const daySummaries = journal.flushDailyRollovers()
    insertChat('client-a', 'user', 'Продолжим новый день.')
    journal.append('client-a', 'tool', 'Изменён файл report.md', 'Новая дневная сессия')
    const closeSummaries = journal.flushSessionSummaries('close')

    expect(daySummaries).toHaveLength(1)
    expect(daySummaries[0].title).toBe('Сводка дня · 21.06.2026')
    expect(parseSummary(daySummaries[0].detail).turns[0].user).toContain('запросил краткую сводку')
    expect(closeSummaries).toHaveLength(1)
    expect(closeSummaries[0].title).toContain('22.06.2026')
    expect(parseSummary(closeSummaries[0].detail).turns[0].user).toContain('написал: Продолжим новый день')
  })

  function insertChat(projectPath: string, role: 'user' | 'assistant', content: string): void {
    db!.prepare(
      'INSERT INTO chats (project_path, role, content, created_at) VALUES (?, ?, ?, ?)'
    ).run(projectPath, role, content, Date.now())
  }
})

function parseSummary(detail: string | null): any {
  expect(detail).toBeTruthy()
  return JSON.parse(detail!)
}
