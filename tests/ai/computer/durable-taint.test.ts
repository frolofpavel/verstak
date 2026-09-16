import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../../electron/storage/db'
import {
  COMPUTER_CONTEXT_TAINT_CAP,
  createBrowserTasks,
  type BrowserTasks,
} from '../../../electron/storage/browser-tasks'
import {
  isChatComputerTainted,
  materializeChatComputerTaint,
  projectConversationSearchForComputerTaint,
} from '../../../electron/ai/computer/durable-taint'
import { COMPUTER_CONTEXT_OMITTED } from '../../../electron/ai/tool-telemetry'

let dir: string
let db: Database
let browserTasks: BrowserTasks

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verstak-durable-computer-taint-'))
  db = openDb(join(dir, 'test.db'))
  browserTasks = createBrowserTasks(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function createTask(chatId: number): string {
  const browserTaskId = `bt-${chatId}`
  browserTasks.create({ browserTaskId, projectPath: '/project', chatId, runId: `run-${chatId}` })
  return browserTaskId
}

function propose(chatId: number, actionType: string): void {
  const browserTaskId = browserTasks.get(`bt-${chatId}`) ? `bt-${chatId}` : createTask(chatId)
  browserTasks.proposeAction({
    actionId: `action-${chatId}-${actionType}`,
    browserTaskId,
    runId: `run-${chatId}`,
    actionType,
    riskLevel: 'R1',
  })
}

describe('durable Computer Use taint', () => {
  it('любой статус computer:* в current или bounded ancestor taints, обычные actions не taint', () => {
    propose(7, 'computer:read')
    const parents = new Map<number, number | null>([[8, 7], [9, 8], [10, null]])
    const deps = { browserTasks, getChatParentChatId: (id: number) => parents.get(id) ?? null }

    expect(isChatComputerTainted(7, deps)).toBe(true)
    expect(isChatComputerTainted(9, deps)).toBe(true)

    propose(10, 'browser:click')
    browserTasks.finalizeAction('action-10-browser:click', 'failed')
    expect(isChatComputerTainted(10, deps)).toBe(false)
    expect(isChatComputerTainted(null, deps)).toBe(false)
  })

  it('fail-closes on an unreadable or cyclic ancestor chain', () => {
    expect(isChatComputerTainted(1, {
      browserTasks,
      getChatParentChatId: () => { throw new Error('db read failed') },
    })).toBe(true)
    expect(isChatComputerTainted(1, {
      browserTasks,
      getChatParentChatId: id => id === 1 ? 2 : 1,
    })).toBe(true)
  })

  it('materialized fork marker survives unrelated setCaps updates without fake UI actions', () => {
    materializeChatComputerTaint(browserTasks, 42, '/project')
    expect(browserTasks.get('bt-42')?.caps[COMPUTER_CONTEXT_TAINT_CAP]).toBe(true)
    expect(browserTasks.listActions('bt-42')).toEqual([])

    browserTasks.setCaps('bt-42', { browserRead: true })
    expect(browserTasks.get('bt-42')?.caps).toEqual({
      browserRead: true,
      [COMPUTER_CONTEXT_TAINT_CAP]: true,
    })
    expect(isChatComputerTainted(42, { browserTasks })).toBe(true)
  })

  it('conversation search omits every content row from tainted sessions', () => {
    propose(7, 'computer:type')
    const rows = [
      { session_id: 7, role: 'assistant', content: 'DESKTOP_SEARCH_POISON', created_at: 1 },
      { session_id: 7, role: 'user', content: 'user topic remains', created_at: 2 },
      { session_id: 8, role: 'assistant', content: 'ordinary assistant remains', created_at: 3 },
    ]
    const projected = projectConversationSearchForComputerTaint(
      rows,
      id => isChatComputerTainted(id, { browserTasks }),
    )

    expect(projected[0]).toEqual({ ...rows[0], content: COMPUTER_CONTEXT_OMITTED })
    expect(projected[1]).toEqual({ ...rows[1], content: COMPUTER_CONTEXT_OMITTED })
    expect(projected[2]).toEqual(rows[2])
  })
})
