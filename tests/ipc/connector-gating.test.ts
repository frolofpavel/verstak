import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { connectorQueryHandler } from '../../electron/ipc/tool-handlers/connectors'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { AgentMode } from '../../electron/ai/mode-policy'
import type { ToolCall } from '../../electron/ai/types'

/**
 * connector_query: внешние системы (SSH/HTTP/Telegram/публикация) гейтятся как команда
 * (plan→block, ask→confirm), результат и ошибки редактируются secret-scanner'ом, а
 * Я.Диск upload загоняет local_path в границы проекта (агент не выгрузит .env/произвольный
 * файл системы в облако клиента). Мокнут connectors.query (вход), остальное — настоящая логика.
 */

interface Harness {
  ctx: ToolContext
  queries: Array<{ cid: string; args: Record<string, unknown> }>
  controller: AbortController
}

function harness(dir: string, mode: AgentMode, queryImpl?: (cid: string, args: Record<string, unknown>) => unknown): Harness {
  const queries: Array<{ cid: string; args: Record<string, unknown> }> = []
  const controller = new AbortController()
  const ctx = {
    projectPath: dir,
    sendId: 't',
    agentMode: mode,
    signal: controller.signal,
    sender: { send: () => {} },
    pendingCommands: new Map(),
    scopedKey: (sendId: unknown, callId: unknown) => `${sendId}:${callId}`,
    recordJournal: () => {},
    connectors: {
      list: () => [],
      query: async (cid: string, args: Record<string, unknown>) => {
        queries.push({ cid, args })
        return queryImpl ? queryImpl(cid, args) : { ok: true }
      }
    }
  } as unknown as ToolContext
  return { ctx, queries, controller }
}

function call(args: Record<string, unknown>): ToolCall {
  return { id: '1', name: 'connector_query', args }
}

const tick = () => new Promise<void>(r => setTimeout(r, 0))

describe('connector_query gating + Я.Диск guard', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-conn-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('id обязателен', async () => {
    const h = harness(dir, 'auto')
    const res = await connectorQueryHandler.handle(call({}), h.ctx)
    expect(res.error).toContain('id обязателен')
    expect(h.queries.length).toBe(0)
  })

  it('plan → block: запрос не уходит, причина режима', async () => {
    const h = harness(dir, 'plan')
    const res = await connectorQueryHandler.handle(call({ id: 'ssh' }), h.ctx)
    expect(h.queries.length).toBe(0)
    expect(res.error).toContain('Режим планирования')
  })

  it('auto → запрос уходит, результат редактируется', async () => {
    const h = harness(dir, 'auto', () => 'token=ghp_0123456789abcdefABCDEF0123456789abcdef')
    const res = await connectorQueryHandler.handle(call({ id: 'http' }), h.ctx)
    expect(h.queries.length).toBe(1)
    expect(String(res.result)).not.toContain('ghp_0123456789abcdefABCDEF0123456789abcdef')
    expect(String(res.result)).toContain('[REDACTED')
  })

  it('ask → confirm + reject: запрос не уходит', async () => {
    const h = harness(dir, 'ask')
    const p = connectorQueryHandler.handle(call({ id: 'telegram' }), h.ctx)
    await tick()
    expect(h.queries.length).toBe(0)
    h.ctx.pendingCommands.get('t:1')!.resolve(false)
    const res = await p
    expect(h.queries.length).toBe(0)
    expect(res.error).toBe('User rejected')
  })

  it('Я.Диск: local_path вне проекта → запрещён', async () => {
    const h = harness(dir, 'auto')
    const res = await connectorQueryHandler.handle(call({ id: 'yandex_disk', local_path: '../../secret.txt' }), h.ctx)
    expect(res.error).toContain('вне проекта')
    expect(h.queries.length).toBe(0)
  })

  it('Я.Диск: секретный файл (.env) внутри проекта → запрещён', async () => {
    writeFileSync(join(dir, '.env'), 'SECRET=1')
    const h = harness(dir, 'auto')
    const res = await connectorQueryHandler.handle(call({ id: 'yandex_disk', local_path: '.env' }), h.ctx)
    expect(res.error).toContain('секретные файлы')
    expect(h.queries.length).toBe(0)
  })

  it('Я.Диск: обычный файл внутри проекта → проходит, путь нормализован', async () => {
    writeFileSync(join(dir, 'report.html'), '<h1>ok</h1>')
    const h = harness(dir, 'auto')
    const res = await connectorQueryHandler.handle(call({ id: 'yandex_disk', local_path: 'report.html' }), h.ctx)
    expect(res.error).toBeFalsy()
    expect(h.queries.length).toBe(1)
    expect(String(h.queries[0].args.local_path)).toContain('report.html')
  })

  // 2.0.0 + ре-ревью: telegram send_document разрешён ТОЛЬКО из .verstak/artifacts
  // (агент-сгенерированные деливераблы), по РЕАЛЬНОМУ пути (realpath). Произвольные
  // файлы проекта (вкл. секреты вне enum'а isForbiddenPath и symlink) — эксфильтрация.
  it('Telegram: файл из .verstak/artifacts → проходит, путь = realpath', async () => {
    const art = join(dir, '.verstak', 'artifacts', '2026-07-11')
    mkdirSync(art, { recursive: true })
    writeFileSync(join(art, 'report.pdf'), '%PDF-ok')
    const h = harness(dir, 'auto')
    const res = await connectorQueryHandler.handle(call({ id: 'telegram', action: 'send_document', document_path: '.verstak/artifacts/2026-07-11/report.pdf' }), h.ctx)
    expect(res.error).toBeFalsy()
    expect(h.queries.length).toBe(1)
    expect(String(h.queries[0].args.document_path)).toContain('report.pdf')
  })

  it('Telegram: обычный файл проекта ВНЕ артефактов → запрещён (не эксфильтрация)', async () => {
    writeFileSync(join(dir, 'report.html'), '<h1>ok</h1>')
    const h = harness(dir, 'auto')
    const res = await connectorQueryHandler.handle(call({ id: 'telegram', action: 'send_document', document_path: 'report.html' }), h.ctx)
    expect(res.error).toContain('artifacts')
    expect(h.queries.length).toBe(0)
  })

  it('Telegram: .env → запрещён (вне артефактов)', async () => {
    writeFileSync(join(dir, '.env'), 'SECRET=1')
    const h = harness(dir, 'auto')
    const res = await connectorQueryHandler.handle(call({ id: 'telegram', action: 'send_document', document_path: '.env' }), h.ctx)
    expect(res.error).toContain('artifacts')
    expect(h.queries.length).toBe(0)
  })

  it('Telegram: symlink на .env под безобидным именем в артефактах → запрещён (realpath)', async () => {
    const art = join(dir, '.verstak', 'artifacts')
    mkdirSync(art, { recursive: true })
    writeFileSync(join(dir, '.env'), 'SECRET=leak')
    try {
      symlinkSync(join(dir, '.env'), join(art, 'report.pdf'))
    } catch {
      return  // нет прав на симлинк (Windows без dev-mode) — пропускаем
    }
    const h = harness(dir, 'auto')
    const res = await connectorQueryHandler.handle(call({ id: 'telegram', action: 'send_document', document_path: '.verstak/artifacts/report.pdf' }), h.ctx)
    expect(res.error).toContain('artifacts')  // realpath = .env вне артефактов
    expect(h.queries.length).toBe(0)
  })

  // 2.0.0 security (аудит M2): вывод коннектора недоверен → обрамлён маркером
  // против prompt-injection (симметрия с web_fetch).
  it('результат коннектора обрамлён маркером недоверенного контента', async () => {
    const h = harness(dir, 'auto', () => ({ rows: [{ msg: 'привет' }] }))
    const res = await connectorQueryHandler.handle(call({ id: 'http' }), h.ctx)
    expect(res.result).toContain('НЕДОВЕРЕННЫЕ данные из внешнего коннектора')
    expect(res.result).toContain('привет')
  })
})
