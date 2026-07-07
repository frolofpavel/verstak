import { describe, it, expect } from 'vitest'
import type { ToolCall } from '../../electron/ai/types'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { AgentMode } from '../../electron/ai/mode-policy'
import {
  spawnProcessHandler,
  processStatusHandler,
  readProcessHandler,
  stopProcessHandler,
} from '../../electron/ipc/tool-handlers/process'

interface FakeProcessHandle {
  id: string
  pid: number
  command: string
  cwd: string
  startedAt: number
  exitedAt?: number
  exitCode?: number
  status: 'running' | 'completed' | 'failed' | 'killed'
  outputTail: string
  notifyOnExit: boolean
}

function fakeRegistry() {
  const handles = new Map<string, FakeProcessHandle>()
  const calls: Array<{ command: string; cwd: string; timeout?: number; notifyOnExit?: boolean }> = []
  return {
    calls,
    spawn(command: string, opts: { cwd: string; timeout?: number; notifyOnExit?: boolean }) {
      calls.push({ command, ...opts })
      const handle: FakeProcessHandle = {
        id: `p-${calls.length}`,
        pid: 1000 + calls.length,
        command,
        cwd: opts.cwd,
        startedAt: Date.now(),
        status: 'running',
        outputTail: 'line1\nline2\nline3',
        notifyOnExit: opts.notifyOnExit === true,
      }
      handles.set(handle.id, handle)
      return { ...handle }
    },
    get(id: string) {
      const handle = handles.get(id)
      return handle ? { ...handle } : undefined
    },
    list() {
      return Array.from(handles.values()).map(h => ({ ...h }))
    },
    async kill(id: string) {
      const handle = handles.get(id)
      if (handle) handle.status = 'killed'
    },
    seed(handle: FakeProcessHandle) {
      handles.set(handle.id, handle)
    }
  }
}

function harness(mode: AgentMode, overrides: Partial<ToolContext> = {}) {
  const registry = fakeRegistry()
  const controller = new AbortController()
  const ctx = {
    sendId: 1,
    agentMode: mode,
    signal: controller.signal,
    projectPath: process.cwd(),
    sender: { send: () => {}, exec: async () => undefined },
    pendingCommands: new Map(),
    scopedKey: (sendId: unknown, callId: unknown) => `${sendId}:${callId}`,
    processRegistry: registry,
    tools: {
      classifyCommand: () => ({ allowed: true }),
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
    recordRunEvent: () => {},
    ...overrides,
  } as unknown as ToolContext
  return { ctx, registry, controller }
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: '1', name, args }
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('process tools', () => {
  it('spawn_process auto mode starts process and returns id immediately', async () => {
    const h = harness('auto')
    const res = await spawnProcessHandler.handle(call('spawn_process', {
      command: 'npm run dev',
      notify_on_exit: true,
      timeout_ms: 1000,
    }), h.ctx)
    expect(res.error).toBeFalsy()
    expect(res.result).toMatchObject({ process_id: 'p-1', pid: 1001, status: 'running' })
    expect(h.registry.calls[0]).toMatchObject({ command: 'npm run dev', notifyOnExit: true, timeout: 1000 })
  })

  it('spawn_process denylist blocks before registry spawn', async () => {
    const h = harness('auto', {
      tools: {
        classifyCommand: () => ({ allowed: false, reason: 'danger' }),
        runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      } as unknown as ToolContext['tools']
    })
    const res = await spawnProcessHandler.handle(call('spawn_process', { command: 'rm -rf /' }), h.ctx)
    expect(res.error).toContain('Blocked by safety policy')
    expect(h.registry.calls.length).toBe(0)
  })

  it('spawn_process ask mode waits for confirmation', async () => {
    const h = harness('ask')
    const pending = spawnProcessHandler.handle(call('spawn_process', { command: 'npm run dev' }), h.ctx)
    await tick()
    expect(h.registry.calls.length).toBe(0)
    h.ctx.pendingCommands.get('1:1')!.resolve(true)
    const res = await pending
    expect(res.error).toBeFalsy()
    expect(h.registry.calls.length).toBe(1)
  })

  it('spawn_process rejects cwd outside project', async () => {
    const h = harness('auto')
    const res = await spawnProcessHandler.handle(call('spawn_process', { command: 'npm run dev', cwd: '..' }), h.ctx)
    expect(res.error).toContain('cwd must stay inside project')
    expect(h.registry.calls.length).toBe(0)
  })

  it('process_status/read_process/stop_process operate on registry handles', async () => {
    const h = harness('auto')
    h.registry.seed({
      id: 'p-7',
      pid: 77,
      command: 'npm run dev',
      cwd: process.cwd(),
      startedAt: Date.now() - 500,
      status: 'running',
      outputTail: 'one\ntwo\nthree',
      notifyOnExit: false,
    })

    const status = await processStatusHandler.handle(call('process_status', { id: 'p-7' }), h.ctx)
    expect(status.result).toMatchObject({ process_id: 'p-7', status: 'running' })

    const read = await readProcessHandler.handle(call('read_process', { id: 'p-7', lines: 2 }), h.ctx)
    expect(read.result).toEqual({ tail: 'two\nthree' })

    const stopped = await stopProcessHandler.handle(call('stop_process', { id: 'p-7' }), h.ctx)
    expect(stopped.result).toEqual({ killed: true, status: 'killed' })
  })
})
