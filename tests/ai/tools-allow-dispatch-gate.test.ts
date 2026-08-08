import { describe, it, expect, vi } from 'vitest'
import { dispatchToolTurn, toolsAllowBlockReason } from '../../electron/ai/runner-tool-turn'
import type { ToolContext, ToolHandler } from '../../electron/ipc/tool-handlers'
import type { ToolCall } from '../../electron/ai/types'

// Аудит 09.08 (штаб): tools_allow был FILTER-ONLY — фильтровал предлагаемый список, но
// диспетчер не проверял ничего. Значит галлюцинированный/инъецированный/унаследованный
// вызов инструмента ВНЕ набора ИСПОЛНЯЛСЯ. Гейт на исполнении делает гарантию
// «read-only скилл физически не сможет write_file» правдой, а не надеждой на провайдера.

function makeCtx(allowedToolNames: Set<string> | null, isChildSession = false): { ctx: ToolContext; sent: unknown[] } {
  const sent: unknown[] = []
  const ctx = {
    sender: { send: (_ch: string, ev: unknown) => { sent.push(ev) }, exec: async () => undefined },
    sendId: 1,
    allowedToolNames,
    isChildSession,
  } as unknown as ToolContext
  return { ctx, sent }
}

/** Хендлер-шпион: считает, БЫЛ ЛИ реально вызван инструмент (доказывает, что гейт
 *  блокирует ДО исполнения, а не после). */
function spyHandler(): { handler: ToolHandler; calls: () => number } {
  let n = 0
  const handler: ToolHandler = {
    mode: 'sequential',
    handle: async (call) => { n++; return { id: call.id, name: call.name, result: 'EXECUTED', error: undefined } },
  }
  return { handler, calls: () => n }
}

const READONLY = new Set(['read_file', 'search_project', 'get_project_map', 'connector_query'])
const writeCall: ToolCall = { id: 'w1', name: 'write_file', args: { path: 'x', content: 'y' } }
const readCall: ToolCall = { id: 'r1', name: 'read_file', args: { path: 'x' } }

describe('dispatchToolTurn — гейт tools_allow на ИСПОЛНЕНИИ', () => {
  it('КЕЙС 4 (латентная дыра, ШИРЕ наследования): вызов write_file «из ниоткуда» под read-only скиллом БЛОКИРУЕТСЯ, хендлер не вызван', async () => {
    const { ctx } = makeCtx(READONLY, /* isChildSession */ false)
    const spy = spyHandler()
    const [res] = await dispatchToolTurn({ toolCalls: [writeCall], context: ctx, hooks: null, addContext: () => {}, resolveHandler: () => spy.handler })
    expect(res.error).toBeTruthy()
    expect(res.result).toBe('')            // НЕ 'EXECUTED' — не исполнился
    expect(spy.calls()).toBe(0)            // хендлер вообще не позван
    expect(res.error).toMatch(/недоступен|tools_allow|ограничил/i)
  })

  it('КЕЙС 3 (наследование): у дочерней сессии отказ ОБЪЯСНЯЕТ, что набор унаследован от родителя', async () => {
    const { ctx } = makeCtx(READONLY, /* isChildSession */ true)
    const spy = spyHandler()
    const [res] = await dispatchToolTurn({ toolCalls: [writeCall], context: ctx, hooks: null, addContext: () => {}, resolveHandler: () => spy.handler })
    expect(res.error).toBeTruthy()
    expect(spy.calls()).toBe(0)
    expect(res.error).toMatch(/унаследован|родительск/i)   // немой «недоступен» недостаточен
  })

  it('КОНТРОЛЬ: без ограничения (allowedToolNames=null) write_file ИСПОЛНЯЕТСЯ — ничего лишнего не отняли', async () => {
    const { ctx } = makeCtx(null)
    const spy = spyHandler()
    const [res] = await dispatchToolTurn({ toolCalls: [writeCall], context: ctx, hooks: null, addContext: () => {}, resolveHandler: () => spy.handler })
    expect(res.error).toBeUndefined()
    expect(res.result).toBe('EXECUTED')
    expect(spy.calls()).toBe(1)
  })

  it('КОНТРОЛЬ: разрешённый инструмент (read_file в наборе) ИСПОЛНЯЕТСЯ, не блокируется', async () => {
    const { ctx } = makeCtx(READONLY)
    const spy = spyHandler()
    const [res] = await dispatchToolTurn({ toolCalls: [readCall], context: ctx, hooks: null, addContext: () => {}, resolveHandler: () => spy.handler })
    expect(res.error).toBeUndefined()
    expect(res.result).toBe('EXECUTED')
    expect(spy.calls()).toBe(1)
  })

  it('отказ гейта эмитит tool-blocked событие в UI (видимый след, не немой отказ)', async () => {
    const { ctx, sent } = makeCtx(READONLY, true)
    await dispatchToolTurn({ toolCalls: [writeCall], context: ctx, hooks: null, addContext: () => {}, resolveHandler: () => spyHandler().handler })
    const blockedEv = sent.find((e) => (e as { event?: { type?: string } }).event?.type === 'tool-blocked')
    expect(blockedEv).toBeTruthy()
  })
})

describe('toolsAllowBlockReason — текст отказа', () => {
  it('дочерняя сессия: называет наследование от родителя', () => {
    expect(toolsAllowBlockReason('write_file', true)).toMatch(/унаследован|родительск/i)
  })
  it('обычная сессия: называет ограничение скилла', () => {
    const r = toolsAllowBlockReason('run_command', false)
    expect(r).toMatch(/скилл|tools_allow/i)
    expect(r).not.toMatch(/унаследован/i)
  })
})
