import { describe, it, expect } from 'vitest'
import { mcpToolHandler } from '../../electron/ipc/tool-handlers/mcp'
import { compilePermissionConfig } from '../../electron/ai/permission-rules'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { AgentMode } from '../../electron/ai/mode-policy'
import type { ToolCall } from '../../electron/ai/types'

/**
 * БОЕВОЙ гейт MCP — не чистая функция, а сам `mcpToolHandler`.
 *
 * Ревизия 15.08 (§2.3 и §2.11): до этой сетки `mcpToolHandler` не импортировал НИ ОДИН
 * тест, поэтому любая правка внутри файла была для набора невидима. Две мутации давали
 * 5463 зелёных:
 *   §2.3  `mcpDecision(scope, ctx.agentMode)` → `mcpDecision('read', …)` — ЛЮБОЙ внешний
 *         инструмент (запись/команда/сеть) получал auto-accept во ВСЕХ режимах, включая plan;
 *   §2.11 `if (permRule?.decision === 'deny')` обесточено — явное правило «запретить этот
 *         MCP-инструмент» переставало работать, при том что в коде записано обещание
 *         «deny бьёт даже bypass».
 * Пины `tests/ai/mcp-policy.test.ts` и `tests/lib/mcp-confirm-visibility.test.ts` стерегут
 * ЧИСТЫЕ функции (`mcpDecision`, ярлык) и обе мутации пропускают: они сверяют функции между
 * собой, а доходит ли решение до вызова — не проверяет никто.
 *
 * Наблюдаемая величина здесь одна и она честная: УШЁЛ ЛИ ВЫЗОВ на внешний сервер
 * (`callTool`). Рядом с каждым «не ушёл» стоит контрольный кейс, где тот же вызов
 * УХОДИТ (§3.1 регламента: пин «действие не произошло» зелен и тогда, когда действие
 * не могло произойти вовсе).
 */

interface Harness {
  ctx: ToolContext
  calls: Array<{ serverId: string; name: string; args: unknown }>
  events: Array<{ type: string; [k: string]: unknown }>
}

// 'create_issue' → keyword 'create' → scope 'write' (гейтится как команда).
// 'list_repos'   → keyword 'list'   → scope 'read'  (проходит всегда).
const TOOLS = [
  { name: 'create_issue', description: 'Create an issue in the tracker', serverId: 'srv1' },
  { name: 'list_repos', description: 'List repositories', serverId: 'srv1' },
]

function harness(mode: AgentMode, opts?: { deny?: string[]; onConfirm?: boolean }): Harness {
  const calls: Array<{ serverId: string; name: string; args: unknown }> = []
  const events: Array<{ type: string; [k: string]: unknown }> = []
  const controller = new AbortController()
  const ctx = {
    projectPath: '',
    sendId: 't',
    agentMode: mode,
    signal: controller.signal,
    sender: { send: (_ch: string, p: { event: { type: string } }) => { events.push(p.event as { type: string }) } },
    // Подтверждение отвечает сразу заданным ответом — предмет проверки не модалка,
    // а факт «дошло ли до callTool».
    pendingCommands: {
      set: (_k: string, e: { resolve: (ok: boolean) => void }) => { e.resolve(opts?.onConfirm ?? false) },
      delete: () => {},
    },
    scopedKey: (sendId: unknown, callId: unknown) => `${sendId}:${callId}`,
    permissionRules: opts?.deny ? compilePermissionConfig({ deny: opts.deny }) : undefined,
    mcpClient: {
      getAllTools: () => TOOLS,
      callTool: async (serverId: string, name: string, args: unknown) => {
        calls.push({ serverId, name, args })
        return 'ok'
      },
    },
  } as unknown as ToolContext
  return { ctx, calls, events }
}

function call(name: string): ToolCall {
  return { id: '1', name, args: { title: 'x' } }
}

describe('mcpToolHandler — боевой гейт (§2.3 ревизии 15.08)', () => {
  it('plan + пишущий инструмент → блок, вызов на сервер НЕ уходит', async () => {
    const h = harness('plan')
    const res = await mcpToolHandler.handle(call('create_issue'), h.ctx)
    expect(h.calls.length).toBe(0)
    expect(res.error).toContain('Режим планирования')
    expect(h.events.some(e => e.type === 'tool-blocked')).toBe(true)
  })

  it('accept-edits + пишущий инструмент → подтверждение, отказ → вызов НЕ уходит', async () => {
    const h = harness('accept-edits', { onConfirm: false })
    const res = await mcpToolHandler.handle(call('create_issue'), h.ctx)
    expect(h.calls.length).toBe(0)
    expect(h.events.some(e => e.type === 'pending-command')).toBe(true)
    expect(res.error).toBe('User rejected')
  })

  it('ask + пишущий инструмент → подтверждение, согласие → вызов уходит', async () => {
    const h = harness('ask', { onConfirm: true })
    const res = await mcpToolHandler.handle(call('create_issue'), h.ctx)
    expect(h.events.some(e => e.type === 'pending-command')).toBe(true)
    expect(h.calls.length).toBe(1)
    expect(res.error).toBeFalsy()
  })

  // КОНТРОЛЬНЫЙ кейс к трём выше: тот же режим, читающий инструмент — вызов ОБЯЗАН
  // уйти без единой карточки. Без него «вызов не ушёл» ничего не измеряет.
  it('контроль: ask + читающий инструмент → авто, без подтверждения, вызов уходит', async () => {
    const h = harness('ask')
    const res = await mcpToolHandler.handle(call('list_repos'), h.ctx)
    expect(h.calls.length).toBe(1)
    expect(h.events.some(e => e.type === 'pending-command')).toBe(false)
    expect(res.error).toBeFalsy()
  })

  it('plan + читающий инструмент → проходит (гейт судит scope, а не режим в лоб)', async () => {
    const h = harness('plan')
    await mcpToolHandler.handle(call('list_repos'), h.ctx)
    expect(h.calls.length).toBe(1)
  })
})

describe('mcpToolHandler — deny-правило permissions (§2.11 ревизии 15.08)', () => {
  it('deny на имя MCP-инструмента → блок в auto, вызов НЕ уходит', async () => {
    const h = harness('auto', { deny: ['list_repos'] })
    const res = await mcpToolHandler.handle(call('list_repos'), h.ctx)
    expect(h.calls.length).toBe(0)
    expect(res.error).toBeTruthy()
    expect(h.events.some(e => e.type === 'tool-blocked')).toBe(true)
  })

  it('deny бьёт даже bypass — вызов НЕ уходит', async () => {
    const h = harness('bypass', { deny: ['create_issue'] })
    const res = await mcpToolHandler.handle(call('create_issue'), h.ctx)
    expect(h.calls.length).toBe(0)
    expect(res.error).toBeTruthy()
  })

  // КОНТРОЛЬНЫЕ кейсы: те же вызовы БЕЗ правила уходят, и deny на ЧУЖОЕ имя не задевает.
  it('контроль: без deny-правила тот же вызов в auto уходит', async () => {
    const h = harness('auto')
    await mcpToolHandler.handle(call('list_repos'), h.ctx)
    expect(h.calls.length).toBe(1)
  })

  it('контроль: deny на другое имя не блокирует этот инструмент', async () => {
    const h = harness('auto', { deny: ['create_issue'] })
    await mcpToolHandler.handle(call('list_repos'), h.ctx)
    expect(h.calls.length).toBe(1)
  })
})
