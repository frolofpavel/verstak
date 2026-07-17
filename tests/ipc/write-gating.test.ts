import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { writeFileHandler } from '../../electron/ipc/tool-handlers/file-ops'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { AgentMode } from '../../electron/ai/mode-policy'
import type { ToolCall } from '../../electron/ai/types'

/**
 * Гейтинг записи (diffConfirmWrite): mode-policy решает судьбу write_file ДО записи.
 *  - plan → block: запись не происходит, модель получает причину;
 *  - accept-edits/auto/bypass → auto-accept: пишет без модалки;
 *  - ask → confirm: ждёт ответ пользователя (pendingWrites) — accept пишет, reject/abort отменяют.
 * Это рубеж «AI не пишет в обход режима». Мокнут только tools.execute (фиксируем вызовы),
 * остальное — настоящая логика diffConfirmWrite.
 */

interface Harness {
  ctx: ToolContext
  writes: Array<{ path: string; content: string }>
  recordWriteCalls: number
  lastProvenance?: { runId?: string | null; chatId?: number | null; messageId?: number | null }
  controller: AbortController
}

function harness(dir: string, mode: AgentMode): Harness {
  const writes: Array<{ path: string; content: string }> = []
  const controller = new AbortController()
  const h = { writes, recordWriteCalls: 0, controller } as Harness
  h.ctx = {
    runId: 'run-x', // 2.0.11-E: провенанс отката — recordWrite должен его прокинуть
    projectPath: dir,
    sendId: 't',
    agentMode: mode,
    signal: controller.signal,
    sender: { send: () => {} },
    pendingWrites: new Map(),
    scopedKey: (sendId: unknown, callId: unknown) => `${sendId}:${callId}`,
    recordWrite: (_p: unknown, _f: unknown, _b: unknown, _a: unknown, provenance?: Harness['lastProvenance']) => {
      h.recordWriteCalls++
      h.lastProvenance = provenance
    },
    recordRunEvent: () => {},
    tools: {
      execute: async (name: string, args: Record<string, unknown>) => {
        if (name === 'read_file') return ''            // before-content пустой
        if (name === 'write_file') { writes.push({ path: String(args.path), content: String(args.content) }); return 'ok' }
        return ''
      }
    }
  } as unknown as ToolContext
  return h
}

function call(path = 'src/foo.ts', content = 'new content'): ToolCall {
  return { id: '1', name: 'write_file', args: { path, content } }
}

const tick = () => new Promise<void>(r => setTimeout(r, 0))

describe('write_file gating (diffConfirmWrite)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-wgate-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('plan → block: записи нет, ошибка с причиной режима', async () => {
    const h = harness(dir, 'plan')
    const res = await writeFileHandler.handle(call(), h.ctx)
    expect(h.writes.length).toBe(0)
    expect(res.result).toBe('')
    expect(res.error).toContain('Режим планирования')
  })

  it('accept-edits → auto-accept: пишет без подтверждения', async () => {
    const h = harness(dir, 'accept-edits')
    const res = await writeFileHandler.handle(call(), h.ctx)
    expect(h.writes).toEqual([{ path: 'src/foo.ts', content: 'new content' }])
    expect(h.recordWriteCalls).toBe(1)
    expect(res.result).toContain('Applied write to src/foo.ts')
    expect(res.error).toBeFalsy()
  })

  // 2.0.11-E: undo-запись должна нести провенанс прогона (runId), иначе rewindCoverage
  // не отличит трассируемую правку от непротрассированной.
  it('recordWrite получает провенанс прогона (runId)', async () => {
    const h = harness(dir, 'accept-edits')
    await writeFileHandler.handle(call(), h.ctx)
    expect(h.lastProvenance?.runId).toBe('run-x')
  })

  it('absolute Downloads-style write does not create project undo entry', async () => {
    const h = harness(dir, 'accept-edits')
    const target = join(tmpdir(), 'verstak-export.md')
    const res = await writeFileHandler.handle(call(target, 'export'), h.ctx)
    expect(h.writes).toEqual([{ path: target, content: 'export' }])
    expect(h.recordWriteCalls).toBe(0)
    expect(res.result).toContain(target)
  })

  it('ask → confirm + accept: запись после подтверждения', async () => {
    const h = harness(dir, 'ask')
    const p = writeFileHandler.handle(call(), h.ctx)
    await tick()                                       // дать хендлеру выставить pending-write
    expect(h.writes.length).toBe(0)                    // ещё НЕ писал — ждёт юзера
    h.ctx.pendingWrites.get('t:1')!.resolve(true)
    const res = await p
    expect(h.writes.length).toBe(1)
    expect(res.result).toContain('Applied write')
  })

  it('ask → confirm + reject: записи нет, "User rejected"', async () => {
    const h = harness(dir, 'ask')
    const p = writeFileHandler.handle(call(), h.ctx)
    await tick()
    h.ctx.pendingWrites.get('t:1')!.resolve(false)
    const res = await p
    expect(h.writes.length).toBe(0)
    expect(res.error).toBe('User rejected')
  })

  it('ask → confirm + abort сигнала: трактуется как отказ', async () => {
    const h = harness(dir, 'ask')
    const p = writeFileHandler.handle(call(), h.ctx)
    await tick()
    h.controller.abort()                               // таймаут/отмена субзадачи
    const res = await p
    expect(h.writes.length).toBe(0)
    expect(res.error).toBe('User rejected')
  })

  it('abort ДО входа в ожидание → сразу отказ (signal уже aborted)', async () => {
    const h = harness(dir, 'ask')
    h.controller.abort()                               // прерван заранее
    const res = await writeFileHandler.handle(call(), h.ctx)
    expect(h.writes.length).toBe(0)
    expect(res.error).toBe('User rejected')
  })
})
