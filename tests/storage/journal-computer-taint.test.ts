import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createJournal } from '../../electron/storage/journal'

describe('journal Computer Use privacy boundary', () => {
  let dir: string
  let db: Database | null = null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vst-journal-computer-'))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-16T09:00:00'))
    db = openDb(join(dir, 'test.db'))
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  it('omits tainted chat text from current and flushed summaries while retaining an adjacent clean chat', () => {
    const typedMarker = 'JOURNAL_PRIVATE_TYPED_MARKER'
    const windowMarker = 'JOURNAL_PRIVATE_WINDOW_MARKER'
    const thrownMarker = 'JOURNAL_FAIL_CLOSED_MARKER'
    insertChat(701, 'user', `/computer-use: введи ${typedMarker}\nиз файла PRIVATE-NOTES.txt`)
    insertChat(701, 'assistant', `Вижу ${windowMarker} в выбранном окне.`)
    insertChat(702, 'user', 'Обычный соседний запрос')
    insertChat(702, 'assistant', 'Обычный ответ без Computer Use.')
    insertChat(703, 'user', `/computer-use: введи ${thrownMarker}`)

    const taintChecks: number[] = []
    const journal = createJournal(db!, {
      isChatComputerTainted: chatId => {
        taintChecks.push(chatId)
        if (chatId === 703) throw new Error('taint storage unavailable')
        return chatId === 701
      },
    })

    const current = journal.currentSession('client-a')
    expect(current).not.toBeNull()
    expect(JSON.stringify(current)).not.toContain(typedMarker)
    expect(JSON.stringify(current)).not.toContain(windowMarker)
    expect(JSON.stringify(current)).not.toContain(thrownMarker)
    expect(JSON.stringify(current)).not.toContain('PRIVATE-NOTES.txt')
    expect(JSON.stringify(current)).toContain('Обычный соседний запрос')

    vi.setSystemTime(new Date('2026-09-16T09:10:00'))
    const flushed = journal.flushSessionSummaries('close')
    expect(flushed).toHaveLength(1)
    expect(JSON.stringify(flushed)).not.toContain(typedMarker)
    expect(JSON.stringify(flushed)).not.toContain(windowMarker)
    expect(JSON.stringify(flushed)).not.toContain(thrownMarker)
    expect(JSON.stringify(flushed)).not.toContain('PRIVATE-NOTES.txt')
    const persisted = JSON.stringify(journal.list('client-a'))
    expect(persisted).not.toContain(typedMarker)
    expect(persisted).not.toContain(windowMarker)
    expect(persisted).not.toContain(thrownMarker)
    expect(persisted).not.toContain('PRIVATE-NOTES.txt')
    expect(persisted).toContain('Обычный соседний запрос')
    expect(taintChecks).toEqual(expect.arrayContaining([701, 702, 703]))
  })

  it('wires the durable Computer taint authority into the production journal', () => {
    const source = readFileSync(join(process.cwd(), 'electron', 'main.ts'), 'utf8')
    const journalWiring = /createJournal\(db,\s*\{\s*isChatComputerTainted:\s*chatHasDurableComputerTaint,?\s*\}\)/u
    expect(source).toMatch(journalWiring)

    const missingGateMutation = source.replace(journalWiring, 'createJournal(db)')
    expect(missingGateMutation).not.toBe(source)
    expect(missingGateMutation).not.toMatch(journalWiring)
  })

  function insertChat(sessionId: number, role: 'user' | 'assistant', content: string): void {
    db!.prepare(
      'INSERT INTO chats (project_path, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('client-a', sessionId, role, content, Date.now())
  }
})
