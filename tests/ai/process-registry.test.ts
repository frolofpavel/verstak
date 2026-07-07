import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProcessRegistry } from '../../electron/ai/process-registry'

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

const tempDirs: string[] = []

function quoteArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

function nodeCommand(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'verstak-proc-test-'))
  tempDirs.push(dir)
  const file = join(dir, 'script.js')
  writeFileSync(file, script, 'utf8')
  return `${quoteArg(process.execPath)} ${quoteArg(file)}`
}

async function waitFor<T>(fn: () => T, predicate: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const started = Date.now()
  let value = fn()
  while (!predicate(value)) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise(resolve => setTimeout(resolve, 25))
    value = fn()
  }
  return value
}

describe('ProcessRegistry', () => {
  const registries: ProcessRegistry[] = []

  afterEach(async () => {
    for (const registry of registries) {
      for (const processHandle of registry.list({ status: 'running' })) {
        await registry.kill(processHandle.id)
      }
      registry.stopSweeper()
    }
    registries.length = 0
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function createRegistry(deps: ConstructorParameters<typeof ProcessRegistry>[0] = {}) {
    const registry = new ProcessRegistry(deps)
    registries.push(registry)
    return registry
  }

  it('spawn returns a running handle immediately and records completion', async () => {
    const registry = createRegistry()
    const handle = registry.spawn(nodeCommand("setTimeout(() => console.log('done'), 100)"), { cwd: process.cwd() })
    expect(handle.id).toBeTruthy()
    expect(handle.pid).toBeGreaterThan(0)
    expect(handle.status).toBe('running')

    const done = await waitFor(() => registry.get(handle.id), value => value?.status === 'completed')
    expect(done?.exitCode).toBe(0)
    expect(done?.outputTail).toContain('done')
  })

  it('bounds outputTail and keeps surrogate pairs intact', () => {
    const registry = createRegistry()
    const handle = registry.spawn(nodeCommand('setTimeout(() => {}, 500)'), { cwd: process.cwd() })
    registry.appendOutput(handle.id, 'x'.repeat(40 * 1024) + '😀')
    const updated = registry.get(handle.id)!
    expect(Array.from(updated.outputTail).length).toBeLessThanOrEqual(30 * 1024)
    expect(updated.outputTail.endsWith('😀')).toBe(true)
  })

  it('redacts stdout/stderr before storing in tail', async () => {
    const registry = createRegistry()
    const handle = registry.spawn(nodeCommand("console.log('key=AKIAIOSFODNN7EXAMPLE')"), { cwd: process.cwd() })
    const done = await waitFor(() => registry.get(handle.id), value => value?.status === 'completed')
    expect(done?.outputTail).toContain('[REDACTED:aws-access-key]')
    expect(done?.outputTail).not.toContain('AKIAIOSFODNN7EXAMPLE')
  })

  it('queues notifyOnExit completion once with redacted tail', async () => {
    const registry = createRegistry()
    const handle = registry.spawn(nodeCommand("console.log('key=AKIAIOSFODNN7EXAMPLE')"), {
      cwd: process.cwd(),
      notifyOnExit: true,
    })
    await waitFor(() => registry.get(handle.id), value => value?.status === 'completed')

    const completions = registry.drainCompletions()
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ id: handle.id, status: 'completed', exitCode: 0 })
    expect(completions[0].outputTail).toContain('[REDACTED:aws-access-key]')
    expect(completions[0].outputTail).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(registry.drainCompletions()).toEqual([])
  })

  it('does not queue completion when notifyOnExit is false', async () => {
    const registry = createRegistry()
    const handle = registry.spawn(nodeCommand("console.log('done')"), { cwd: process.cwd() })
    await waitFor(() => registry.get(handle.id), value => value?.status === 'completed')
    expect(registry.drainCompletions()).toEqual([])
  })

  it('drains completions by owner without leaking other sendIds', async () => {
    const registry = createRegistry()
    const first = registry.spawn(nodeCommand("console.log('first')"), {
      cwd: process.cwd(),
      notifyOnExit: true,
      owner: { sendId: 1, runId: 'r1', chatId: 10 },
    })
    const second = registry.spawn(nodeCommand("console.log('second')"), {
      cwd: process.cwd(),
      notifyOnExit: true,
      owner: { sendId: 2, runId: 'r2', chatId: 20 },
    })
    await waitFor(() => registry.get(first.id), value => value?.status === 'completed')
    await waitFor(() => registry.get(second.id), value => value?.status === 'completed')

    const firstOnly = registry.drainCompletions({ ownerSendId: 1 })
    expect(firstOnly).toHaveLength(1)
    expect(firstOnly[0]).toMatchObject({ id: first.id, owner: { sendId: 1, runId: 'r1', chatId: 10 } })

    const remaining = registry.drainCompletions()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatchObject({ id: second.id, owner: { sendId: 2, runId: 'r2', chatId: 20 } })
  })

  it('kill marks process as killed and calls tree kill', async () => {
    const killTree = vi.fn()
    const registry = createRegistry({ treeKill: killTree, getHostStartTime: () => 'same-start' })
    const handle = registry.spawn(nodeCommand('setTimeout(() => {}, 5000)'), { cwd: process.cwd() })
    await registry.kill(handle.id)
    const killed = registry.get(handle.id)!
    expect(killTree).toHaveBeenCalledTimes(1)
    expect(killed.status).toBe('killed')
  })

  it('pid reuse guard blocks kill when host start time changed', async () => {
    let token = 'start-a'
    const killTree = vi.fn()
    const registry = createRegistry({
      treeKill: killTree,
      getHostStartTime: () => token,
    })
    const handle = registry.spawn(nodeCommand('setInterval(() => {}, 1000)'), { cwd: process.cwd() })
    token = 'start-b'
    await registry.kill(handle.id)
    const guarded = registry.get(handle.id)!
    expect(killTree).not.toHaveBeenCalled()
    expect(guarded.status).toBe('failed')
    expect(guarded.outputTail).toContain('pid reuse guard')
  })

  it('prunes finished processes after ttl', () => {
    let now = 1_000
    const registry = createRegistry({ now: () => now })
    const handle = registry.spawn(nodeCommand('setInterval(() => {}, 1000)'), { cwd: process.cwd() })
    registry.markExited(handle.id, 0)
    now += 10_000
    expect(registry.pruneFinished(1_000)).toBe(1)
    expect(registry.get(handle.id)).toBeUndefined()
  })
})
