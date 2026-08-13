// C1 (13.08): правила проекта — мета-файл о ПОВЕДЕНИИ агента, а не рутинная правка
// кода. Заголовочное «черновик показан до записи» держалось только в ask: в auto
// (дефолт новых пользователей с 2.6.0) запись авто-принималась, и человек узнавал о
// новых правилах уже по факту.
//
// Сетка держит ОБЕ стороны: правила спрашивают даже в auto, обычная правка кода в
// auto по-прежнему не спрашивает. Без второго кейса первый ничего не измеряет —
// «спросило» зелено и у гейта, который спрашивает вообще всё.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { draftProjectRulesHandler } from '../../electron/ipc/tool-handlers/project-rules'
import { writeFileHandler } from '../../electron/ipc/tool-handlers/file-ops'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { AgentMode } from '../../electron/ai/mode-policy'
import type { ToolCall } from '../../electron/ai/types'

interface Harness {
  ctx: ToolContext
  writes: Array<{ path: string; content: string }>
  events: Array<{ type: string; [k: string]: unknown }>
}

function harness(dir: string, mode: AgentMode): Harness {
  const writes: Array<{ path: string; content: string }> = []
  const events: Array<{ type: string; [k: string]: unknown }> = []
  const ctx = {
    runId: 'run-c1',
    projectPath: dir,
    sendId: 't',
    agentMode: mode,
    signal: new AbortController().signal,
    sender: { send: (_ch: string, payload: { event: { type: string } }) => { events.push(payload.event as never) } },
    pendingWrites: new Map(),
    scopedKey: (sendId: unknown, callId: unknown) => `${sendId}:${callId}`,
    recordWrite: () => {},
    recordRunEvent: () => {},
    tools: {
      execute: async (name: string, args: Record<string, unknown>) => {
        if (name === 'write_file') { writes.push({ path: String(args.path), content: String(args.content) }); return 'ok' }
        return ''
      },
    },
  } as unknown as ToolContext
  return { ctx, writes, events }
}

const rulesCall = (): ToolCall => ({ id: '1', name: 'draft_project_rules', args: {} })

/**
 * Ждём ИМЕННО появления подтверждения, а не «одного тика»: сборщик черновика
 * читает файлы, и число микрозадач до модалки — не свойство поведения. Бюджет
 * заметно меньше testTimeout (20 000), чтобы отказ был назван причиной, а не
 * безымянным таймаутом прогона.
 */
async function waitForPending(ctx: ToolContext, key: string) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const p = ctx.pendingWrites.get(key)
    if (p) return p
    await new Promise<void>(r => setTimeout(r, 5))
  }
  return undefined
}

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verstak-c1-rules-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }), 'utf8')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('C1: запись правил проекта показывает diff даже в auto', () => {
  it('ПИН: auto → черновик правил ждёт подтверждения, до ответа записи нет', async () => {
    const h = harness(dir, 'auto')

    const p = draftProjectRulesHandler.handle(rulesCall(), h.ctx)
    const pending = await waitForPending(h.ctx, 't:1')

    expect(pending, 'подтверждение не выставлено: правила записаны молча').toBeTruthy()
    expect(h.writes, 'запись прошла до ответа человека').toHaveLength(0)
    expect(h.events.map(e => e.type)).toContain('pending-write')

    pending!.resolve(true)
    const res = await p
    expect(h.writes).toHaveLength(1)
    expect(res.error).toBeFalsy()
  })

  it('ПИН: отказ в auto → правила не записаны', async () => {
    const h = harness(dir, 'auto')

    const p = draftProjectRulesHandler.handle(rulesCall(), h.ctx)
    const pending = await waitForPending(h.ctx, 't:1')
    pending!.resolve(false)
    const res = await p

    expect(h.writes).toHaveLength(0)
    expect(res.error).toBe('User rejected')
  })

  it('КОНТРОЛЬ: обычная правка кода в auto по-прежнему БЕЗ вопроса', async () => {
    const h = harness(dir, 'auto')

    const res = await writeFileHandler.handle(
      { id: '2', name: 'write_file', args: { path: 'src/foo.ts', content: 'x' } },
      h.ctx,
    )

    expect(h.writes, 'исключение расползлось на обычные правки').toEqual([{ path: 'src/foo.ts', content: 'x' }])
    expect(h.ctx.pendingWrites.size).toBe(0)
    expect(res.error).toBeFalsy()
  })

  it('bypass остаётся «никаких диалогов»: это осознанный выбор человека, а не дефолт', async () => {
    const h = harness(dir, 'bypass')

    const res = await draftProjectRulesHandler.handle(rulesCall(), h.ctx)

    expect(h.writes).toHaveLength(1)
    expect(res.error).toBeFalsy()
  })

  it('plan по-прежнему блокирует запись правил', async () => {
    const h = harness(dir, 'plan')

    const res = await draftProjectRulesHandler.handle(rulesCall(), h.ctx)

    expect(h.writes).toHaveLength(0)
    expect(res.error).toBeTruthy()
  })
})
