import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatEvent, ChatProvider } from '../../electron/ai/types'

// Этап 1а облачного Verstak, блок №4 — главный риск оценки (docs/headless-core-recon-
// 2026-08-04.md §4): ПОЛНЫЙ runApiConversation никогда не гонялся headless. Существующий
// харнес agent-loop.test.ts мокает electron НЕЙТРАЛЬНО (рабочие заглушки app/ipcMain);
// headless-сервер — среда, где импорт electron ПАДАЕТ. Здесь мок кидает, как реальный
// require('electron') на сервере без пакета: любой top-level electron-импорт во всём
// транзитивном графе runner-api → tools → tool-handlers → storage роняет прогон.
// Контрольный кейс, что такой мок действительно валит модуль с electron-импортом, —
// красный прогон tests/runtime-log-headless.test.ts на коде до расщепления runtime-log
// (блок №1 той же линии).
vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

const { runApiConversation } = await import('../../electron/ai/runner-api')
const { createToolsForProject } = await import('../../electron/ai/tools')
const { createCostGuard } = await import('../../electron/ai/cost-guard')
const { openDb } = await import('../../electron/storage/db')
const { createAgentRuns } = await import('../../electron/storage/agent-runs')

/** Скриптованный провайдер: ход 1 — write_file, ход 2 — финальный текст. */
function scriptedProvider(): ChatProvider {
  let turn = 0
  return {
    id: 'headless-scripted', name: 'headless-scripted', models: ['headless-scripted'],
    async *send(): AsyncGenerator<ChatEvent> {
      turn++
      if (turn === 1) {
        yield { type: 'tool-call', call: { id: 'w1', name: 'write_file', args: { path: 'report.md', content: '# Headless report\nok\n' } } }
        yield { type: 'done' }
      } else {
        yield { type: 'text', text: 'Отчёт готов: report.md' }
        yield { type: 'done' }
      }
    }
  }
}

describe('headless full loop — runApiConversation в чистом Node (Этап 1а, №4)', () => {
  let projectDir: string
  let dbDir: string
  let db: ReturnType<typeof openDb>

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'vsk-headless-proj-'))
    dbDir = mkdtempSync(join(tmpdir(), 'vsk-headless-db-'))
    db = openDb(join(dbDir, 'headless.db'))
  })
  afterEach(() => {
    try { db.close() } catch { /* уже закрыта */ }
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('полный цикл: tool-ход write_file → финал; durable-таймлайн и файл на месте', async () => {
    const agentRuns = createAgentRuns(db)
    const runId = 'headless-run-1'
    // Продовая форма старта прогона — как openAgentRun (ipc/ai-send/run-bookkeeping.ts):
    // строка agent_runs + user_msg первым событием таймлайна.
    agentRuns.create({
      runId, projectPath: projectDir, chatId: null, owner: 'main',
      title: 'собери отчёт', providerId: 'openai-api', model: 'test-model',
      requestedProviderId: 'openai-api', requestedModel: 'test-model',
      sendId: 101, agentMode: 'bypass', accountId: null
    })
    agentRuns.appendEvent(runId, 'user_msg', { detail: 'собери отчёт' })

    const events: unknown[] = []
    const sender = {
      // Серверный аналог null-sender из ipc/ai.ts:359, но собирающий: события — будущий SSE-поток.
      send: (_channel: string, payload: { id: number; event: unknown }) => { events.push(payload.event) },
      exec: async () => undefined
    }
    const ctrl = new AbortController()
    const tools = createToolsForProject(projectDir, ctrl.signal, {})

    await runApiConversation({
      sender, sendId: 101, provider: scriptedProvider(), tools, projectPath: projectDir,
      initialMessages: [
        { role: 'system', content: 'test system' },
        { role: 'user', content: 'собери отчёт' }
      ],
      signal: ctrl.signal,
      recordWrite: () => undefined,
      recordPlan: () => ({ id: 1 }),
      recordJournal: () => undefined,
      readJournal: () => [],
      saveMemory: () => ({ id: 'm' }),
      saveDecision: () => ({ id: 1 }),
      invalidateMemory: () => false,
      searchMemories: () => [],
      searchConversations: () => [],
      connectors: { list: () => [], query: async () => ({}) },
      agentMode: 'bypass',
      turnsBudget: 5,
      getSecretForDelegate: () => null,
      costGuard: createCostGuard(100),
      providerId: 'openai-api',
      model: 'test-model',
      agentRuns,
      runId
      // Каст через unknown — как spread-каст в agent-loop.test.ts: стабы памяти/решений
      // сознательно минимальные, полный DecisionRecord тесту не нужен.
    } as unknown as Parameters<typeof runApiConversation>[0])

    // 1. Реальный tool-ход прошёл через настоящий handler-чейн: файл записан.
    const reportPath = join(projectDir, 'report.md')
    expect(existsSync(reportPath)).toBe(true)
    expect(readFileSync(reportPath, 'utf8')).toContain('Headless report')

    // 2. Durable-таймлайн в sqlite: прогон завершён 'done', события пережили бы рестарт процесса.
    const runRow = db.prepare('SELECT status FROM agent_runs WHERE run_id = ?').get(runId) as { status: string }
    expect(runRow.status).toBe('done')
    const eventRows = db.prepare('SELECT kind FROM agent_run_events WHERE run_id = ? ORDER BY id').all(runId) as Array<{ kind: string }>
    expect(eventRows.length).toBeGreaterThan(1)
    expect(eventRows[0].kind).toBe('user_msg')

    // 3. Чистое завершение убирает crash-resume чекпойнт (runner-finalize).
    const checkpoint = db.prepare('SELECT run_id FROM agent_run_checkpoints WHERE run_id = ?').get(runId)
    expect(checkpoint).toBeUndefined()

    // 4. События ушли в sender (будущий SSE): есть tool-активность и финальный done.
    const types = events.map(e => (e as { type?: string }).type)
    expect(types).toContain('done')
    expect(types.some(t => t === 'tool-call' || t === 'tool-activity')).toBe(true)
  })

  it('стоп снаружи: abort до второго хода → прогон не виснет и не остаётся running', async () => {
    const agentRuns = createAgentRuns(db)
    const runId = 'headless-run-abort'
    agentRuns.create({
      runId, projectPath: projectDir, chatId: null, owner: 'main',
      title: 'abort smoke', providerId: 'openai-api', model: 'test-model',
      requestedProviderId: 'openai-api', requestedModel: 'test-model',
      sendId: 102, agentMode: 'bypass', accountId: null
    })
    const ctrl = new AbortController()
    let turn = 0
    const provider: ChatProvider = {
      id: 'p-abort', name: 'p-abort', models: ['p-abort'],
      async *send(): AsyncGenerator<ChatEvent> {
        turn++
        if (turn === 1) {
          yield { type: 'tool-call', call: { id: 'c1', name: 'read_file', args: { path: 'nope.txt' } } }
          ctrl.abort() // серверная ручка stop дёргает тот же AbortController
          yield { type: 'done' }
        } else {
          yield { type: 'text', text: 'не должен случиться' }
          yield { type: 'done' }
        }
      }
    }
    await runApiConversation({
      sender: { send: () => undefined, exec: async () => undefined }, sendId: 102,
      provider, tools: createToolsForProject(projectDir, ctrl.signal, {}), projectPath: projectDir,
      initialMessages: [{ role: 'user', content: 'abort smoke' }], signal: ctrl.signal,
      recordWrite: () => undefined, recordPlan: () => ({ id: 1 }), recordJournal: () => undefined,
      readJournal: () => [], saveMemory: () => ({ id: 'm' }), saveDecision: () => ({ id: 1 }),
      invalidateMemory: () => false, searchMemories: () => [], searchConversations: () => [],
      connectors: { list: () => [], query: async () => ({}) }, agentMode: 'bypass', turnsBudget: 5,
      getSecretForDelegate: () => null, costGuard: createCostGuard(100),
      providerId: 'openai-api', model: 'test-model', agentRuns, runId
      // Каст через unknown — см. комментарий в первом кейсе.
    } as unknown as Parameters<typeof runApiConversation>[0])

    const runRow = db.prepare('SELECT status FROM agent_runs WHERE run_id = ?').get(runId) as { status: string }
    expect(runRow.status).not.toBe('running')
  })
})
