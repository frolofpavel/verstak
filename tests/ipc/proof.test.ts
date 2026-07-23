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
const { createRunUsage, persistRunUsage } = await import('../../electron/storage/agent-run-usage')
const { normalizedUsage } = await import('../../shared/contracts/usage')
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
  let runUsage: ReturnType<typeof createRunUsage>

  beforeEach(() => {
    handlers.clear()
    dir = mkdtempSync(join(tmpdir(), 'gg-proof-'))
    db = openDb(join(dir, 'test.db'))
    agentRuns = createAgentRuns(db)
    verifications = createVerifications(db)
    runUsage = createRunUsage(db)
    // seed: прогон + события + верификация (тот же chatId).
    agentRuns.create({ runId: 'run-test1234', projectPath: dir, chatId: 7, title: 'Тестовая задача', providerId: 'claude', model: 'claude-opus-4-8', agentMode: 'ask' })
    agentRuns.appendEvent('run-test1234', 'tool_call', { label: 'write_file', detail: 'src/x.ts', status: 'ok' })
    agentRuns.appendEvent('run-test1234', 'verify', { label: 'DoD', detail: '3/3', status: 'passed' })
    agentRuns.appendEvent('run-test1234', 'tool_call', { label: 'review_before_commit', detail: 'REVIEW GATE: ПРОЙДЕНО · confidence 0.9', status: 'ok' })
    agentRuns.appendEvent('run-test1234', 'assistant_msg', { detail: 'Готово: сделал X', status: 'completed' })
    agentRuns.finish('run-test1234', 'done', { costCents: 50, toolCount: 1, filesCount: 1 })
    // VSK-PROOF-A1: usage-строка с ИЗВЕСТНОЙ ценой — иначе прогон стал бы legacy.
    persistRunUsage(db, { runId: 'run-test1234', providerId: 'claude', model: 'claude-sonnet-4-6', transport: 'API', accountId: null, usage: normalizedUsage({ inputTokens: 100, outputTokens: 50, inputAccounting: 'exclusive' }) }, 1_700_000_000_000)
    verifications.insert({ projectPath: dir, chatId: 7, runId: 'run-test1234', overall: 'passed', checksTotal: 3, checksPassed: 3, changedFilesCount: 1, artifactPath: 'x.json', htmlPath: 'x.html', taskSummary: 'тесты + typecheck', createdAt: 1_700_000_000_000 })
    registerProofIpc({
      agentRuns, verifications,
      getProjectRoot: () => dir,
      queryAuditForRun: () => [],
      getRunUsage: (runId: string) => runUsage.get(runId),
      getSecret: (key) => {
        if (key === 'telegram_bot_token') return '123:abc'
        if (key === 'telegram_notify_chat_id') return '777'
        if (key === 'telegram_chat_whitelist') return '["777"]'
        return null
      }
    })
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  it('собирает proof.json + proof.html, возвращает пути и html', async () => {
    const res = await invoke<Promise<{ ok: boolean; jsonPath?: string; htmlPath?: string; markdownPath?: string; html?: string; markdown?: string }>>('proof:generate', 'run-test1234')
    expect(res.ok).toBe(true)
    expect(existsSync(res.jsonPath!)).toBe(true)
    expect(existsSync(res.htmlPath!)).toBe(true)
    expect(existsSync(res.markdownPath!)).toBe(true)
    // HTML: DoD-бейдж + заголовок задачи
    expect(res.html).toContain('ДОКАЗАНО · 3/3')
    expect(res.html).toContain('Тестовая задача')
    // proof.json: структура из источников
    const pack = JSON.parse(readFileSync(res.jsonPath!, 'utf-8'))
    expect(pack.run.provider).toBe('claude')
    expect(pack.run.costUsd).toBe(0.5)         // 50 центов
    expect(pack.verification.overall).toBe('passed')
    expect(pack.reviewGate.status).toBe('passed')
    expect(pack.result).toContain('Готово: сделал X')
    expect(res.markdown).toContain('## Review Gate')
    // таймлайн содержит значимые события
    expect(pack.timeline.map((e: { kind: string }) => e.kind)).toContain('verify')
  })

  it('proof:export-pdf writes a local PDF next to the proof pack', async () => {
    const res = await invoke<Promise<{ ok: boolean; pdfPath?: string }>>('proof:export-pdf', 'run-test1234')
    expect(res.ok).toBe(true)
    expect(existsSync(res.pdfPath!)).toBe(true)
    const pdf = readFileSync(res.pdfPath!)
    expect(pdf.subarray(0, 5).toString('utf-8')).toBe('%PDF-')
    expect(pdf.toString('latin1')).toContain('Proof Pack run-test1234')
  })

  it('proof:send-telegram exports PDF and sends it through Telegram connector', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
      text: async () => '{"ok":true}'
    }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await invoke<Promise<{ ok: boolean; pdfPath?: string; result?: unknown }>>('proof:send-telegram', 'run-test1234')

    expect(res.ok).toBe(true)
    expect(existsSync(res.pdfPath!)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/sendDocument')
    expect(init.body).toBeInstanceOf(FormData)
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

  it('подтягивает review gate из follow-up run того же чата для proof основного выполнения', async () => {
    agentRuns.create({ runId: 'run-exec-no-review', projectPath: dir, chatId: 8, title: 'Основное выполнение', providerId: 'claude', model: 'm', agentMode: 'accept-edits' })
    agentRuns.appendEvent('run-exec-no-review', 'tool_call', { label: 'write_file', detail: 'src/y.ts', status: 'ok' })
    agentRuns.finish('run-exec-no-review', 'done', { toolCount: 1, filesCount: 1 })
    verifications.insert({
      projectPath: dir,
      chatId: 8,
      runId: 'run-exec-no-review',
      overall: 'passed',
      checksTotal: 1,
      checksPassed: 1,
      changedFilesCount: 1,
      artifactPath: 'exec.json',
      htmlPath: 'exec.html',
      taskSummary: 'npm test',
      createdAt: 1_700_000_000_100,
    })

    agentRuns.create({ runId: 'run-review-followup', projectPath: dir, chatId: 8, title: 'Дожать review gate', providerId: 'claude', model: 'm', agentMode: 'accept-edits' })
    agentRuns.appendEvent('run-review-followup', 'tool_call', { label: 'review_before_commit', detail: 'REVIEW GATE: ПРОЙДЕНО · confidence 0.9', status: 'ok' })
    agentRuns.finish('run-review-followup', 'done', { toolCount: 1 })

    const res = await invoke<Promise<{ ok: boolean; jsonPath?: string }>>('proof:generate', 'run-exec-no-review')
    expect(res.ok).toBe(true)
    const pack = JSON.parse(readFileSync(res.jsonPath!, 'utf-8'))
    expect(pack.run.runId).toBe('run-exec-no-review')
    expect(pack.verification.overall).toBe('passed')
    expect(pack.reviewGate.status).toBe('passed')
  })

  it('run из другого проекта → run-project-mismatch', async () => {
    agentRuns.create({ runId: 'run-foreign', projectPath: join(dir, 'other-project'), chatId: 7, title: 'Чужой проект', providerId: 'claude', model: 'm', agentMode: 'ask' })
    const res = await invoke<Promise<{ ok: boolean; error?: string }>>('proof:generate', 'run-foreign')
    expect(res.ok).toBe(false)
    expect(res.error).toBe('run-project-mismatch')
  })

  // VSK-PROOF-A1: ноль имеет три значения. Реальная in-memory БД, usage персистится
  // штатным persistRunUsage — Proof обязан отличать «бесплатно» от «неизвестно».
  it('неизвестная цена модели: JSON/HTML/Markdown согласованы, нигде нет $0.00', async () => {
    agentRuns.create({ runId: 'run-unknown-cost', projectPath: dir, chatId: 7, title: 'Непрайсованная модель', providerId: 'openai', model: 'gpt-НЕИЗВЕСТНАЯ', agentMode: 'ask' })
    agentRuns.finish('run-unknown-cost', 'done', { costCents: 0 })
    persistRunUsage(db, { runId: 'run-unknown-cost', providerId: 'openai', model: 'gpt-НЕИЗВЕСТНАЯ', transport: 'API', accountId: null, usage: normalizedUsage({ inputTokens: 1000, outputTokens: 100, inputAccounting: 'inclusive' }) }, 1_700_000_000_100)

    const res = await invoke<Promise<{ ok: boolean; jsonPath?: string; html?: string; markdown?: string }>>('proof:generate', 'run-unknown-cost')
    expect(res.ok).toBe(true)
    const pack = JSON.parse(readFileSync(res.jsonPath!, 'utf-8'))
    expect(pack.run.costStatus).toBe('unknown')
    expect(pack.run.costUsd).toBeNull()
    expect(pack.legacyIncomplete).toBe(false)
    expect(res.html).toContain('неизвестно')
    expect(res.html).not.toContain('$0.00')
    expect(res.markdown).toContain('неизвестно')
    expect(res.markdown).not.toContain('$0.00')
  })

  it('CLI-прогон — заведомо бесплатный: costUsd=0 и $0.00, НЕ «неизвестно»', async () => {
    agentRuns.create({ runId: 'run-cli-free', projectPath: dir, chatId: 7, title: 'CLI прогон', providerId: 'claude-cli', model: 'claude-code', agentMode: 'ask' })
    agentRuns.finish('run-cli-free', 'done', { costCents: 0 })
    persistRunUsage(db, { runId: 'run-cli-free', providerId: 'claude-cli', model: 'claude-code', transport: 'CLI', accountId: null, usage: normalizedUsage({ inputTokens: 5000, outputTokens: 500, inputAccounting: 'exclusive' }) }, 1_700_000_000_200)

    const res = await invoke<Promise<{ ok: boolean; jsonPath?: string; html?: string; markdown?: string }>>('proof:generate', 'run-cli-free')
    expect(res.ok).toBe(true)
    const pack = JSON.parse(readFileSync(res.jsonPath!, 'utf-8'))
    expect(pack.run.costStatus).toBe('known')
    expect(pack.run.costUsd).toBe(0)
    expect(pack.legacyIncomplete).toBe(false)
    expect(res.html).toContain('$0.00')
    expect(res.html).not.toContain('неизвестно')
    expect(res.markdown).toContain('$0.00')
    expect(res.markdown).not.toContain('неизвестно')
  })

  it('точный join по runId: proof не подхватывает pricingKnown чужого прогона', async () => {
    agentRuns.create({ runId: 'run-priced', projectPath: dir, chatId: 7, title: 'Прайсованный', providerId: 'claude', model: 'claude-sonnet-4-6', agentMode: 'ask' })
    agentRuns.finish('run-priced', 'done', { costCents: 25 })
    persistRunUsage(db, { runId: 'run-priced', providerId: 'claude', model: 'claude-sonnet-4-6', transport: 'API', accountId: null, usage: normalizedUsage({ inputTokens: 100, outputTokens: 50, inputAccounting: 'exclusive' }) }, 1_700_000_000_300)
    agentRuns.create({ runId: 'run-unpriced', projectPath: dir, chatId: 7, title: 'Непрайсованный', providerId: 'openai', model: 'gpt-НЕИЗВЕСТНАЯ', agentMode: 'ask' })
    agentRuns.finish('run-unpriced', 'done', { costCents: 25 })
    persistRunUsage(db, { runId: 'run-unpriced', providerId: 'openai', model: 'gpt-НЕИЗВЕСТНАЯ', transport: 'API', accountId: null, usage: normalizedUsage({ inputTokens: 100, outputTokens: 50, inputAccounting: 'inclusive' }) }, 1_700_000_000_400)

    const priced = await invoke<Promise<{ ok: boolean; jsonPath?: string }>>('proof:generate', 'run-priced')
    const pricedPack = JSON.parse(readFileSync(priced.jsonPath!, 'utf-8'))
    expect(pricedPack.run.costStatus).toBe('known')
    expect(pricedPack.run.costUsd).toBe(0.25)

    const unpriced = await invoke<Promise<{ ok: boolean; jsonPath?: string }>>('proof:generate', 'run-unpriced')
    const unpricedPack = JSON.parse(readFileSync(unpriced.jsonPath!, 'utf-8'))
    expect(unpricedPack.run.costStatus).toBe('unknown')
    expect(unpricedPack.run.costUsd).toBeNull()
  })

  it('legacy-прогон без строки usage: стоимость не выдумывается, честная пометка', async () => {
    agentRuns.create({ runId: 'run-legacy', projectPath: dir, chatId: 7, title: 'Старый прогон', providerId: 'claude', model: 'claude-opus-4-8', agentMode: 'ask' })
    agentRuns.finish('run-legacy', 'done', { costCents: 0 })
    // usage НЕ персистим — прогон до появления учёта расхода.

    const res = await invoke<Promise<{ ok: boolean; jsonPath?: string; html?: string; markdown?: string }>>('proof:generate', 'run-legacy')
    expect(res.ok).toBe(true)
    const pack = JSON.parse(readFileSync(res.jsonPath!, 'utf-8'))
    expect(pack.run.costStatus).toBe('unknown')
    expect(pack.run.costUsd).toBeNull()
    expect(pack.legacyIncomplete).toBe(true)
    expect(res.html).toContain('неизвестно · неполные legacy-данные')
    expect(res.html).not.toContain('$0.00')
    expect(res.markdown).toContain('неизвестно · неполные legacy-данные')
  })

  // VSK-PROOF-A1-R1: реальный CLI (grok/claude/codex/gemini) может не отдавать token
  // telemetry → runner не пишет usage-строку (runner-plain.ts:425). Это заведомо
  // бесплатный СОВРЕМЕННЫЙ прогон, а не legacy: честный known $0.00.
  it('CLI без usage-строки (нет token telemetry): known $0.00, НЕ legacy', async () => {
    agentRuns.create({ runId: 'run-cli-nousage', projectPath: dir, chatId: 7, title: 'CLI без телеметрии', providerId: 'grok-cli', model: 'grok-code-fast-1', agentMode: 'ask' })
    agentRuns.finish('run-cli-nousage', 'done', { costCents: 0 })
    // persistRunUsage НЕ вызываем — как в реальном runner без токенов.

    const res = await invoke<Promise<{ ok: boolean; jsonPath?: string; html?: string; markdown?: string }>>('proof:generate', 'run-cli-nousage')
    expect(res.ok).toBe(true)
    const pack = JSON.parse(readFileSync(res.jsonPath!, 'utf-8'))
    expect(pack.run.costStatus).toBe('known')
    expect(pack.run.costUsd).toBe(0)
    expect(pack.run.costDataStatus).toBe('missing')
    expect(pack.legacyIncomplete).toBe(false)
    expect(res.html).toContain('$0.00')
    expect(res.html).not.toContain('неизвестно')
    expect(res.markdown).toContain('$0.00')
    expect(res.markdown).not.toContain('неизвестно')
  })

  // R1: ошибка чтения usage (БД залочена/упала) — НЕ то же, что отсутствие строки.
  // Proof не падает, но честно маркирует unavailable, а не называет это legacy.
  it('getRunUsage бросает исключение: Proof не падает, явный unavailable, НЕ legacy', async () => {
    agentRuns.create({ runId: 'run-usage-err', projectPath: dir, chatId: 7, title: 'БД залочена', providerId: 'claude', model: 'claude-opus-4-8', agentMode: 'ask' })
    agentRuns.finish('run-usage-err', 'done', { costCents: 10 })
    registerProofIpc({
      agentRuns, verifications,
      getProjectRoot: () => dir,
      queryAuditForRun: () => [],
      getRunUsage: () => { throw new Error('SQLITE_BUSY: database is locked') }
    })

    const res = await invoke<Promise<{ ok: boolean; jsonPath?: string; html?: string; markdown?: string }>>('proof:generate', 'run-usage-err')
    expect(res.ok).toBe(true)
    const pack = JSON.parse(readFileSync(res.jsonPath!, 'utf-8'))
    expect(pack.run.costStatus).toBe('unknown')
    expect(pack.run.costUsd).toBeNull()
    expect(pack.run.costDataStatus).toBe('unavailable')
    expect(pack.legacyIncomplete).toBe(false)
    expect(res.html).toContain('неизвестно · данные usage недоступны')
    expect(res.html).not.toContain('legacy')
    expect(res.html).not.toContain('$0.00')
    expect(res.markdown).toContain('неизвестно · данные usage недоступны')
  })
})
