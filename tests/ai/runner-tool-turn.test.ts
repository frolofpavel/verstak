import { describe, expect, it, vi } from 'vitest'
import { dispatchToolTurn } from '../../electron/ai/runner-tool-turn'
import type { ToolCall, ToolResult } from '../../electron/ai/types'
import type { TaggedSender, ToolContext, ToolHandler } from '../../electron/ipc/tool-handlers'
import type { CompiledHooks } from '../../electron/ai/hooks'

function call(id: string, name: string): ToolCall {
  return { id, name, args: { value: name } }
}

function result(toolCall: ToolCall): ToolResult {
  return { id: toolCall.id, name: toolCall.name, result: toolCall.name }
}

function context(events: unknown[]): ToolContext {
  const sender: TaggedSender = {
    send: (_channel, payload) => { events.push(payload) },
    exec: async () => null,
  }
  return {
    sender,
    sendId: 42,
    signal: new AbortController().signal,
    projectPath: 'C:\\repo',
  } as unknown as ToolContext
}

describe('dispatchToolTurn', () => {
  it('browser run блокирует cross-tool мутацию, но исполняет browser tool', async () => {
    const events: unknown[] = []
    const handled: string[] = []
    const ctx = {
      ...context(events),
      browserTaskId: 'bt-1',
      browserRunState: { active: true },
    } as ToolContext
    const calls = [call('x1', 'run_command'), call('b1', 'browser_read_page')]
    const results = await dispatchToolTurn({
      toolCalls: calls,
      context: ctx,
      hooks: null,
      addContext: vi.fn(),
      resolveHandler: (name) => ({
        mode: 'sequential',
        handle: async toolCall => {
          handled.push(name)
          return result(toolCall)
        },
      }),
    })

    expect(handled).toEqual(['browser_read_page'])
    expect(results[0].error).toMatch(/Browser run|capability envelope/i)
    expect(results[1].result).toBe('browser_read_page')
  })

  it('обычный run без browserTaskId сохраняет доступ к тем же инструментам', async () => {
    const handled: string[] = []
    const toolCall = call('x1', 'run_command')
    const [res] = await dispatchToolTurn({
      toolCalls: [toolCall],
      context: context([]),
      hooks: null,
      addContext: vi.fn(),
      resolveHandler: (name) => ({
        mode: 'sequential',
        handle: async current => {
          handled.push(name)
          return result(current)
        },
      }),
    })
    expect(handled).toEqual(['run_command'])
    expect(res.result).toBe('run_command')
  })

  it('наличие durable browserTaskId само по себе не превращает обычный чат в browser-only run', async () => {
    const handled: string[] = []
    const toolCalls = [call('x1', 'run_command'), call('x2', 'write_file')]
    const ctx = {
      ...context([]),
      browserTaskId: 'bt-ordinary-chat',
      browserRunState: { active: false },
    } as ToolContext

    const [res] = await dispatchToolTurn({
      toolCalls,
      context: ctx,
      hooks: null,
      addContext: vi.fn(),
      resolveHandler: (name) => ({
        mode: 'sequential',
        handle: async current => {
          handled.push(name)
          return result(current)
        },
      }),
    })

    expect(handled).toEqual(['run_command', 'write_file'])
    expect(res.result).toBe('run_command')
  })

  it('успешное чтение подключённой вкладки включает browser-only gate только для следующего model turn', async () => {
    const events: unknown[] = []
    const state = { active: false }
    const ctx = {
      ...context(events),
      browserTaskId: 'bt-1',
      browserRunState: state,
    } as ToolContext
    const resolveHandler = (_name: string): ToolHandler => ({
      mode: 'sequential',
      handle: async toolCall => result(toolCall),
    })

    const [read] = await dispatchToolTurn({
      toolCalls: [call('b1', 'browser_read_page')],
      context: ctx,
      hooks: null,
      addContext: vi.fn(),
      resolveHandler,
    })
    expect(read.error).toBeUndefined()
    expect(state.active).toBe(true)

    const [command] = await dispatchToolTurn({
      toolCalls: [call('x1', 'run_command')],
      context: ctx,
      hooks: null,
      addContext: vi.fn(),
      resolveHandler,
    })
    expect(command.error).toMatch(/Browser run|capability envelope/i)
  })

  it('ошибка чтения вкладки не включает browser-only gate для обычного чата', async () => {
    const state = { active: false }
    const ctx = {
      ...context([]),
      browserTaskId: 'bt-ordinary-chat',
      browserRunState: state,
    } as ToolContext
    const resolveHandler = (name: string): ToolHandler => ({
      mode: 'sequential',
      handle: async toolCall => name === 'browser_read_page'
        ? { ...result(toolCall), error: 'Текущая вкладка не подключена' }
        : result(toolCall),
    })

    const [read] = await dispatchToolTurn({
      toolCalls: [call('b1', 'browser_read_page')],
      context: ctx,
      hooks: null,
      addContext: vi.fn(),
      resolveHandler,
    })
    expect(read.error).toMatch(/не подключена/i)
    expect(state.active).toBe(false)

    const [command] = await dispatchToolTurn({
      toolCalls: [call('x1', 'run_command')],
      context: ctx,
      hooks: null,
      addContext: vi.fn(),
      resolveHandler,
    })
    expect(command.error).toBeUndefined()
    expect(command.result).toBe('run_command')
  })

  it('сохраняет индекс результатов и контракт scheduling для read/sequential/write', async () => {
    const started: string[] = []
    const finished: string[] = []
    const resolvers = new Map<string, () => void>()
    const calls = [call('r1', 'read-a'), call('s1', 'sequential'), call('w1', 'write-a'), call('r2', 'read-b')]
    const modes: Record<string, ToolHandler['mode']> = {
      'read-a': 'parallel-read',
      sequential: 'sequential',
      'write-a': 'confirm-write',
      'read-b': 'parallel-read',
    }
    const resolveHandler = (name: string): ToolHandler => ({
      mode: modes[name],
      handle: async toolCall => {
        started.push(name)
        if (name !== 'sequential') {
          await new Promise<void>(resolve => resolvers.set(name, resolve))
        }
        finished.push(name)
        return result(toolCall)
      },
    })

    const pending = dispatchToolTurn({
      toolCalls: calls,
      context: context([]),
      hooks: null,
      addContext: vi.fn(),
      resolveHandler,
    })

    await vi.waitFor(() => expect(started).toEqual(['read-a', 'sequential', 'write-a', 'read-b']))
    expect(finished).toEqual(['sequential'])
    resolvers.get('read-b')?.()
    resolvers.get('read-a')?.()
    resolvers.get('write-a')?.()

    await expect(pending).resolves.toEqual(calls.map(result))
    expect(finished).toEqual(['sequential', 'read-b', 'read-a', 'write-a'])
  })

  it('после Stop не запускает следующий sequential tool и сохраняет парный ToolResult', async () => {
    const ctrl = new AbortController()
    const started: string[] = []
    const calls = [call('m1', 'mcp_long'), call('m2', 'mcp_next')]
    const ctx = { ...context([]), signal: ctrl.signal } as ToolContext
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve })
    const resolveHandler = (name: string): ToolHandler => ({
      mode: 'sequential',
      handle: async toolCall => {
        started.push(name)
        if (name === 'mcp_long') {
          markFirstStarted()
          await new Promise<void>(resolve => {
            if (ctrl.signal.aborted) resolve()
            else ctrl.signal.addEventListener('abort', () => resolve(), { once: true })
          })
          return { id: toolCall.id, name: toolCall.name, result: '', error: 'MCP request aborted' }
        }
        return result(toolCall)
      },
    })

    const pending = dispatchToolTurn({
      toolCalls: calls,
      context: ctx,
      hooks: null,
      addContext: vi.fn(),
      resolveHandler,
    })
    await firstStarted
    ctrl.abort()
    const results = await pending

    expect(started).toEqual(['mcp_long'])
    expect(results).toHaveLength(2)
    expect(results[0].error).toMatch(/aborted/i)
    expect(results[1]).toMatchObject({ id: 'm2', name: 'mcp_next' })
    expect(results[1].error).toMatch(/остановлен|aborted/i)
  })

  it('после Stop выполняет PostToolUse для уже запущенного tool, но не для заблокированного следующего', async () => {
    const ctrl = new AbortController()
    const calls = [call('m1', 'mcp_long'), call('m2', 'mcp_next')]
    const hookEvents: string[] = []
    const hooks = {} as CompiledHooks
    const invokeHooks = vi.fn(async (event: string, _hooks: CompiledHooks, payload: { tool_name?: string }) => {
      hookEvents.push(`${event}:${payload.tool_name}`)
      return { block: false }
    })

    const results = await dispatchToolTurn({
      toolCalls: calls,
      context: { ...context([]), signal: ctrl.signal } as ToolContext,
      hooks,
      addContext: vi.fn(),
      resolveHandler: (name) => ({
        mode: 'sequential',
        handle: async toolCall => {
          if (name === 'mcp_long') ctrl.abort()
          return name === 'mcp_long'
            ? { id: toolCall.id, name: toolCall.name, result: '', error: 'MCP request aborted' }
            : result(toolCall)
        },
      }),
      invokeHooks: invokeHooks as never,
    })

    expect(results[1].error).toMatch(/остановлен|aborted/i)
    expect(hookEvents).toContain('PostToolUse:mcp_long')
    expect(hookEvents).not.toContain('PostToolUse:mcp_next')
  })

  it('PreToolUse блокирует вызов fail-closed, PostToolUse его не получает', async () => {
    const events: unknown[] = []
    const contexts: string[] = []
    const handled: string[] = []
    const hookEvents: string[] = []
    const calls = [call('blocked', 'write_file'), call('ok', 'read_file')]
    const hooks = {} as CompiledHooks
    const invokeHooks = vi.fn(async (event: string, _hooks: CompiledHooks, payload: { tool_name?: string }) => {
      hookEvents.push(`${event}:${payload.tool_name}`)
      if (event === 'PreToolUse' && payload.tool_name === 'write_file') {
        return { block: true, reason: 'policy denied', additionalContext: 'pre context' }
      }
      return event === 'PostToolUse'
        ? { block: false, additionalContext: 'post context' }
        : { block: false }
    })
    const resolveHandler = (name: string): ToolHandler => ({
      mode: 'parallel-read',
      handle: async toolCall => {
        handled.push(name)
        return result(toolCall)
      },
    })

    const results = await dispatchToolTurn({
      toolCalls: calls,
      context: context(events),
      hooks,
      addContext: value => contexts.push(value),
      resolveHandler,
      invokeHooks: invokeHooks as never,
    })

    expect(handled).toEqual(['read_file'])
    expect(results[0].error).toBe('policy denied')
    expect(results[1].result).toBe('read_file')
    expect(events).toEqual([expect.objectContaining({
      id: 42,
      event: expect.objectContaining({ type: 'tool-blocked', callId: 'blocked', reason: 'policy denied' }),
    })])
    expect(hookEvents).toEqual([
      'PreToolUse:write_file',
      'PreToolUse:read_file',
      'PostToolUse:read_file',
    ])
    expect(contexts).toEqual(['pre context', 'post context'])
  })
})
