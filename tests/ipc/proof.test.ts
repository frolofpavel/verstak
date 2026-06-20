import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Интеграционный тест Proof Pack end-to-end: proof:generate собирает данные из
 * agent_runs + events + verifications, пишет proof.json + proof.html, возвращает
 * пути и html. Мокаем electron.ipcMain (как dev-task.test), реальная in-memory БД.
 */
const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) } }
}))

const { openDb } = await import('../../electron/storage/db')
const { createAgentRuns } = await import('../../electron/storage/agent-runs')
const { createVerifications } = await import('../../electron/storage/verifications')
const { registerProofIpc } = await import('../../electron/ipc/proof')

function invoke<T>(channel: string, ...args: unknown[]): T {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return fn({} as unknown, ...args) as T
}

describe('proof:generate IPC (Proof Pack end-to-end)', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let agentRuns: ReturnType<typeof createAgentRuns>
  let verifications: ReturnType<typeof createVerifications>

  beforeEach(() => {
    handlers.clear()
    dir = mkdtempSync(join(tmpdir(), 'gg-proof-'))
    db = openDb(join(dir, 'test.db'))
    agentRuns = createAgentRuns(db)
    verifications = createVerifications(db)
    // seed: прогон + события + верификация (тот же chatId).
    agentRuns.create({ runId: 'run-test1234', projectPath: dir, chatId: 7, title: 'Тестовая задача', providerId: 'claude', model: 'claude-opus-4-8', agentMode: 'ask' })
    agentRuns.appendEvent('run-test1234', 'tool_call', { label: 'write_file', detail: 'src/x.ts', status: 'ok' })
    agentRuns.appendEvent('run-test1234', 'verify', { label: 'DoD', detail: '3/3', status: 'passed' })
    agentRuns.appendEvent('run-test1234', 'assistant_msg', { detail: 'Готово: сделал X', status: 'completed' })
    agentRuns.finish('run-test1234', 'done', { costCents: 50, toolCount: 1, filesCount: 1 })
    verifications.insert({ projectPath: dir, chatId: 7, runId: 'run-test1234', overall: 'passed', checksTotal: 3, checksPassed: 3, changedFilesCount: 1, artifactPath: 'x.json', htmlPath: 'x.html', taskSummary: 'тесты + typecheck', createdAt: 1_700_000_000_000 })
    registerProofIpc({
      agentRuns, verifications,
      getProjectRoot: () => dir,
      queryAuditForRun: () => []
    })
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  it('собирает proof.json + proof.html, возвращает пути и html', async () => {
    const res = await invoke<Promise<{ ok: boolean; jsonPath?: string; htmlPath?: string; html?: string }>>('proof:generate', 'run-test1234')
    expect(res.ok).toBe(true)
    expect(existsSync(res.jsonPath!)).toBe(true)
    expect(existsSync(res.htmlPath!)).toBe(true)
    // HTML: DoD-бейдж + заголовок задачи
    expect(res.html).toContain('ДОКАЗАНО · 3/3')
    expect(res.html).toContain('Тестовая задача')
    // proof.json: структура из источников
    const pack = JSON.parse(readFileSync(res.jsonPath!, 'utf-8'))
    expect(pack.run.provider).toBe('claude')
    expect(pack.run.costUsd).toBe(0.5)         // 50 центов
    expect(pack.verification.overall).toBe('passed')
    expect(pack.result).toContain('Готово: сделал X')
    // таймлайн содержит значимые события
    expect(pack.timeline.map((e: { kind: string }) => e.kind)).toContain('verify')
  })

  it('нет прогона → no-run', async () => {
    const res = await invoke<Promise<{ ok: boolean; error?: string }>>('proof:generate', 'nope')
    expect(res.ok).toBe(false)
    expect(res.error).toBe('no-run')
  })

  it('не подтягивает verification другого run в том же chatId', async () => {
    agentRuns.create({ runId: 'run-noverif', projectPath: dir, chatId: 7, title: 'Без своей проверки', providerId: 'claude', model: 'm', agentMode: 'ask' })
    agentRuns.finish('run-noverif', 'done', {})
    verifications.insert({
      projectPath: dir,
      chatId: 7,
      runId: 'run-other',
      overall: 'passed',
      checksTotal: 9,
      checksPassed: 9,
      changedFilesCount: 0,
      artifactPath: 'other.json',
      htmlPath: 'other.html',
      taskSummary: 'чужая проверка',
      createdAt: 1_800_000_000_000,
    })

    const res = await invoke<Promise<{ ok: boolean; jsonPath?: string }>>('proof:generate', 'run-noverif')
    expect(res.ok).toBe(true)
    const pack = JSON.parse(readFileSync(res.jsonPath!, 'utf-8'))
    expect(pack.verification.overall).toBe('not_run')
    expect(pack.verification.taskSummary).toBeNull()
  })

  it('run из другого проекта → run-project-mismatch', async () => {
    agentRuns.create({ runId: 'run-foreign', projectPath: join(dir, 'other-project'), chatId: 7, title: 'Чужой проект', providerId: 'claude', model: 'm', agentMode: 'ask' })
    const res = await invoke<Promise<{ ok: boolean; error?: string }>>('proof:generate', 'run-foreign')
    expect(res.ok).toBe(false)
    expect(res.error).toBe('run-project-mismatch')
  })
})
