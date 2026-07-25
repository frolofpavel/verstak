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
    projectPath: 'C:\\repo',
  } as unknown as ToolContext
}

describe('dispatchToolTurn', () => {
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
