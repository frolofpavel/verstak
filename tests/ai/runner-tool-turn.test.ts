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
  it('R3: browser-derived artifact is blocked without a server-owned handoff', async () => {
    const handled: string[] = []
    const [artifact] = await dispatchToolTurn({
      toolCalls: [call('a1', 'generate_html')],
      context: {
        ...context([]),
        browserTaskId: 'bt-r3', runId: 'run-r3',
        browserRunState: { active: true, contextExposed: true },
        computerRunState: { active: false, contextExposed: false },
      } as ToolContext,
      hooks: null,
      addContext: vi.fn(),
      resolveHandler: name => ({
        mode: 'sequential',
        handle: async toolCall => { handled.push(name); return result(toolCall) },
      }),
    })
    expect(handled).toEqual([])
    expect(artifact.error).toMatch(/handoff|Browser run|capability envelope/i)
  })

  it('security pin: ordinary browser read cannot mint an R3 artifact handoff', async () => {
    const handled: string[] = []
    const state = { active: false, contextExposed: false, screenshotExposed: false }
    const ctx = {
      ...context([]), browserTaskId: 'bt-ordinary', runId: 'run-ordinary',
      browserRunState: state, computerRunState: { active: false, contextExposed: false },
    } as unknown as ToolContext
    const resolveHandler = (name: string): ToolHandler => ({
      mode: 'sequential',
      handle: async current => { handled.push(name); return result(current) },
    })
    await dispatchToolTurn({ toolCalls: [call('b1', 'browser_read_page')], context: ctx, hooks: null, addContext: vi.fn(), resolveHandler })
    const [artifact] = await dispatchToolTurn({ toolCalls: [call('a1', 'generate_html')], context: ctx, hooks: null, addContext: vi.fn(), resolveHandler })
    expect(artifact.error).toMatch(/handoff|capability envelope/i)
    expect(handled).toEqual(['browser_read_page'])
    expect((state as any).r3Handoff).toBeUndefined()
  })

  it('R3: browser -> task artifact -> Computer uses one server-owned lineage and fresh composer consent', async () => {
    const handled: string[] = []
    const addContext = vi.fn()
    const persistR3HandoffCheckpoint = vi.fn()
    const browserRunState = { active: false, contextExposed: false, screenshotExposed: false, r3HandoffAllowed: true }
    const computerRunState = { active: true, contextExposed: false }
    const ctx = {
      ...context([]),
      browserTaskId: 'bt-r3', runId: 'run-r3',
      browserRunState, computerRunState,
      computerUseAllowedActions: ['observe', 'click'],
      persistR3HandoffCheckpoint,
    } as unknown as ToolContext
    const resolveHandler = (name: string): ToolHandler => ({
      mode: 'sequential',
      handle: async toolCall => {
        handled.push(name)
        if (name === 'browser_read_page') {
          return { ...result(toolCall), result: { finalUrl: 'https://example.test/report?token=secret', account: 'cab-7', observationText: 'row A\nrow B' } }
        }
        if (name === 'generate_html') {
          const state = (ctx as any).browserRunState.r3Handoff
          state.phase = 'artifact-ready'
          state.checkpoint.resultRefs = [{ kind: 'artifact', ref: 'C:/repo/.verstak/artifacts/report.html', checksum: 'sha256:abc' }]
          return { ...result(toolCall), result: 'HTML artifact saved: C:/repo/.verstak/artifacts/report.html' }
        }
        return result(toolCall)
      },
    })

    const [read] = await dispatchToolTurn({ toolCalls: [call('b1', 'browser_read_page')], context: ctx, hooks: null, addContext, resolveHandler })
    expect(read.error).toBeUndefined()
    expect((browserRunState as any).r3Handoff).toMatchObject({ browserTaskId: 'bt-r3', runId: 'run-r3', phase: 'browser-ready' })
    expect(persistR3HandoffCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ phase: 'browser-ready' }))

    const [artifact] = await dispatchToolTurn({ toolCalls: [call('a1', 'generate_html')], context: ctx, hooks: null, addContext, resolveHandler })
    expect(artifact.error).toBeUndefined()

    const [computer] = await dispatchToolTurn({ toolCalls: [call('c1', 'computer_observe')], context: ctx, hooks: null, addContext, resolveHandler })
    expect(computer.error).toBeUndefined()
    expect(handled).toEqual(['browser_read_page', 'generate_html', 'computer_observe'])
    expect(addContext).toHaveBeenCalledWith(expect.stringContaining('[VERSTAK_R3_HANDOFF_V1]'))
  })

  it('R3 mutation pin: completed browser handoff cannot replay a browser mutation', async () => {
    const handled: string[] = []
    const ctx = {
      ...context([]), browserTaskId: 'bt-r3', runId: 'run-r3',
      browserRunState: {
        active: true, contextExposed: true, r3HandoffAllowed: true,
        r3Handoff: {
          version: 1, browserTaskId: 'bt-r3', runId: 'run-r3', phase: 'artifact-ready',
          checkpoint: { version: 1, goal: 'browser-to-artifact-to-computer', constraints: [], confirmedActions: [], environment: {}, pendingApproval: null, resultRefs: [] },
        },
      },
      computerRunState: { active: true, contextExposed: false },
      computerUseAllowedActions: ['observe'],
    } as unknown as ToolContext
    const [replay] = await dispatchToolTurn({
      toolCalls: [call('b2', 'browser_click')], context: ctx, hooks: null, addContext: vi.fn(),
      resolveHandler: name => ({ mode: 'sequential', handle: async current => { handled.push(name); return result(current) } }),
    })
    expect(handled).toEqual([])
    expect(replay.error).toMatch(/повтор|replay|handoff|Computer Use/i)
  })
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

  it('browser page context cannot cross into any Computer Use capability', async () => {
    const handled: string[] = []
    const ctx = {
      ...context([]),
      browserRunState: { active: true },
      computerRunState: { active: false },
    } as ToolContext
    const calls = [call('c1', 'computer_observe'), call('c2', 'computer_click')]
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

    expect(handled).toEqual([])
    expect(results.every(item => /Browser run|capability envelope/i.test(item.error ?? ''))).toBe(true)
  })

  it('browser page context cannot escape through desktop-wide capture tools', async () => {
    const handled: string[] = []
    const ctx = {
      ...context([]),
      browserTaskId: 'bt-1',
      browserRunState: { active: true, contextExposed: true },
      computerRunState: { active: false },
    } as ToolContext
    const results = await dispatchToolTurn({
      toolCalls: [call('s1', 'screen_capture'), call('s2', 'screen_info')],
      context: ctx,
      hooks: null,
      addContext: vi.fn(),
      resolveHandler: name => ({
        mode: 'parallel-read',
        handle: async toolCall => {
          handled.push(name)
          return result(toolCall)
        },
      }),
    })

    expect(handled).toEqual([])
    expect(results.every(item => /Browser run|capability envelope/i.test(item.error ?? ''))).toBe(true)
  })

  it('desktop observation enables an untrusted-surface gate for the next turn', async () => {
    const handled: string[] = []
    const state = { active: false, contextExposed: false }
    const ctx = {
      ...context([]),
      browserRunState: { active: false },
      computerRunState: state,
    } as ToolContext
    const resolveHandler = (name: string): ToolHandler => ({
      mode: 'sequential',
      handle: async toolCall => {
        handled.push(name)
        return name === 'computer_observe'
          ? { ...result(toolCall), result: { observation: { text: 'untrusted desktop text' } } }
          : result(toolCall)
      },
    })

    const [observed] = await dispatchToolTurn({
      toolCalls: [call('c1', 'computer_observe')],
      context: ctx,
      hooks: null,
      addContext: vi.fn(),
      resolveHandler,
    })
    expect(observed.error).toBeUndefined()
    expect(state).toEqual({ active: true, contextExposed: true })

    const next = await dispatchToolTurn({
      toolCalls: [
        call('x1', 'run_command'), call('b1', 'browser_read_page'),
        call('f1', 'read_file'), call('a1', 'generate_docx'),
        call('c2', 'computer_click'),
      ],
      context: ctx,
      hooks: null,
      addContext: vi.fn(),
      resolveHandler,
    })
    expect(next[0].error).toMatch(/Computer Use|недоверенн/i)
    expect(next[1].error).toMatch(/Computer Use|недоверенн/i)
    expect(next[2].error).toMatch(/Computer Use|недоверенн/i)
    expect(next[3].error).toMatch(/Computer Use|недоверенн/i)
    expect(next[4].error).toBeUndefined()
    expect(handled).toEqual(['computer_observe', 'computer_click'])
  })

  it('an explicit Computer Use run blocks a first-turn generic screen capture before exposure', async () => {
    const handled: string[] = []
    const ctx = {
      ...context([]),
      browserRunState: { active: false },
      // Production runner initializes this from the original-user action grant.
      computerRunState: { active: true, contextExposed: false },
    } as ToolContext

    const [capture] = await dispatchToolTurn({
      toolCalls: [call('screen-1', 'screen_capture')],
      context: ctx,
      hooks: null,
      addContext: vi.fn(),
      resolveHandler: name => ({
        mode: 'parallel-read',
        handle: async toolCall => {
          handled.push(name)
          return result(toolCall)
        },
      }),
    })

    expect(handled).toEqual([])
    expect(capture.error).toMatch(/Computer Use|недоверенн/i)
  })

  it('any successful browser-visible result enables its cross-capability gate', async () => {
    const handled: string[] = []
    const state = { active: false, contextExposed: false, screenshotExposed: false }
    const ctx = {
      ...context([]),
      browserRunState: state,
      computerRunState: { active: false },
    } as ToolContext
    const resolveHandler = (name: string): ToolHandler => ({
      mode: 'sequential',
      handle: async toolCall => {
        handled.push(name)
        return name === 'browser_screenshot'
          ? { ...result(toolCall), result: { screenshotAttached: true } }
          : result(toolCall)
      },
    })
    await dispatchToolTurn({
      toolCalls: [call('b1', 'browser_screenshot')], context: ctx, hooks: null,
      addContext: vi.fn(), resolveHandler,
    })
    expect(state).toEqual({ active: true, contextExposed: true, screenshotExposed: true })

    const [computer] = await dispatchToolTurn({
      toolCalls: [call('c1', 'computer_observe')], context: ctx, hooks: null,
      addContext: vi.fn(), resolveHandler,
    })
    expect(computer.error).toMatch(/Browser run|capability envelope/i)
    expect(handled).toEqual(['browser_screenshot'])
  })

  it('pre-blocks cross-tools in the same batch as an untrusted desktop observation', async () => {
    const handled: string[] = []
    const ctx = {
      ...context([]),
      browserRunState: { active: false },
      computerRunState: { active: false, contextExposed: false },
    } as ToolContext
    const calls = [call('c1', 'computer_observe'), call('x1', 'run_command'), call('x2', 'connector_send')]
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

    expect(handled).toEqual(['computer_observe'])
    expect(results[1].error).toMatch(/Computer Use|недоверенн/i)
    expect(results[2].error).toMatch(/Computer Use|недоверенн/i)
  })

  it('does not trust an MCP tool that only collides with the computer_ prefix', async () => {
    const handled: string[] = []
    const ctx = {
      ...context([]),
      browserRunState: { active: false },
      computerRunState: { active: true, contextExposed: true },
    } as ToolContext

    const [collision] = await dispatchToolTurn({
      toolCalls: [call('mcp-collision', 'computer_upload')],
      context: ctx,
      hooks: null,
      addContext: vi.fn(),
      resolveHandler: name => ({
        mode: 'confirm-write',
        handle: async toolCall => {
          handled.push(name)
          return result(toolCall)
        },
      }),
    })

    expect(collision.error).toMatch(/Computer Use|недоверенн/i)
    expect(handled).toEqual([])
  })

  it('durable computer context blocks command, connector, browser and MCP classes before handlers', async () => {
    const handled: string[] = []
    const toolCalls = [
      call('cmd', 'run_command'),
      call('connector', 'connector_query'),
      call('browser', 'browser_read_page'),
      call('mcp', 'mcp_external_send'),
    ]
    const results = await dispatchToolTurn({
      toolCalls,
      context: {
        ...context([]),
        browserRunState: { active: false },
        computerRunState: { active: true, contextExposed: true },
      } as ToolContext,
      hooks: null,
      addContext: vi.fn(),
      resolveHandler: name => ({
        mode: 'sequential',
        handle: async toolCall => {
          handled.push(name)
          return result(toolCall)
        },
      }),
    })

    expect(handled).toEqual([])
    expect(results).toHaveLength(toolCalls.length)
    for (const blocked of results) expect(blocked.error).toMatch(/Computer Use|недоверенн/i)
  })

  it('blocks desktop-derived cross-tools before external PreToolUse hooks can observe their arguments', async () => {
    const secret = 'desktop-private-value-never-leaves-envelope'
    const preInputs: unknown[] = []
    const ctx = {
      ...context([]),
      browserRunState: { active: false },
      computerRunState: { active: true, contextExposed: true },
    } as ToolContext
    const calls: ToolCall[] = [{ id: 'x1', name: 'run_command', args: { command: `send ${secret}` } }]

    const [blocked] = await dispatchToolTurn({
      toolCalls: calls,
      context: ctx,
      hooks: {} as CompiledHooks,
      addContext: vi.fn(),
      resolveHandler: () => ({ mode: 'sequential', handle: async current => result(current) }),
      invokeHooks: vi.fn(async (event, _hooks, payload) => {
        if (event === 'PreToolUse') preInputs.push(payload)
        return { block: false }
      }),
    })

    expect(blocked.error).toMatch(/Computer Use|недоверенн/i)
    expect(preInputs).toEqual([])
    expect(JSON.stringify(preInputs)).not.toContain(secret)
  })

  it('pre-blocks Computer Use in the same batch as browser page observation', async () => {
    const handled: string[] = []
    const ctx = {
      ...context([]),
      browserRunState: { active: false },
      computerRunState: { active: false },
    } as ToolContext
    const calls = [call('b1', 'browser_screenshot'), call('c1', 'computer_observe')]
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

    expect(handled).toEqual(['browser_screenshot'])
    expect(results[1].error).toMatch(/Browser run|capability envelope/i)
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
