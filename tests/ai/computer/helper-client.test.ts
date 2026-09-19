import { EventEmitter } from 'node:events'
import { readFileSync, realpathSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMPUTER_PROTOCOL_VERSION,
  MAX_COMPUTER_MESSAGE_BYTES,
  makeComputerRequest,
  parseComputerMessage,
} from '../../../electron/ai/computer/protocol'
import {
  ComputerHelperCancelledError,
  ComputerHelperClient,
  ComputerHelperProtocolError,
  ComputerUnknownEffectError,
  queryOwnerStartTime100ns,
  requireSystemPowerShellPath,
  resolveSystemPowerShellPath,
  type ComputerHelperChild,
} from '../../../electron/ai/computer/helper-client'

type Wire = Record<string, unknown> & { requestId: string; type: string }

const SYSTEM_POWERSHELL_CANDIDATE = win32.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
)
const SYSTEM_POWERSHELL = process.platform === 'win32'
  ? realpathSync.native(SYSTEM_POWERSHELL_CANDIDATE)
  : SYSTEM_POWERSHELL_CANDIDATE

class FakeChild extends EventEmitter implements ComputerHelperChild {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly writes: Wire[] = []
  readonly stdin: Writable
  killed = false
  exitOnKill = true
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  onWrite?: (message: Wire) => void

  constructor() {
    super()
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const message = JSON.parse(Buffer.from(chunk).toString('utf8').trim()) as Wire
        this.writes.push(message)
        this.onWrite?.(message)
        callback()
      },
    })
  }

  reply(request: Wire, body: Record<string, unknown> = {}): void {
    this.stdout.write(`${JSON.stringify({
      v: COMPUTER_PROTOCOL_VERSION,
      type: request.type,
      requestId: request.requestId,
      ok: true,
      ...body,
    })}\n`)
  }

  fail(request: Wire, code: string, message: string): void {
    this.stdout.write(`${JSON.stringify({
      v: COMPUTER_PROTOCOL_VERSION,
      type: 'error',
      requestId: request.requestId,
      ok: false,
      code,
      message,
    })}\n`)
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true
    if (this.exitOnKill) {
      this.signalCode = typeof signal === 'string' ? signal : null
      this.exitCode = 1
      this.emit('exit', 1, this.signalCode)
    }
    return true
  }

  exit(code = 1): void {
    this.exitCode = code
    this.emit('exit', code, null)
  }
}

const identity = { pid: 123, processStartTime100ns: '987654321', hwnd: '4242' }
const titleFingerprint = 'b'.repeat(64)

function createClient(child: FakeChild, options: Record<string, unknown> = {}): ComputerHelperClient {
  return new ComputerHelperClient({
    helperPath: 'C:\\reviewed\\helper.ps1',
    appVersion: '2.9.1',
    spawn: vi.fn(() => child),
    requestTimeoutMs: 100,
    stopAckTimeoutMs: 40,
    resolveOwnerStartTime100ns: () => '1337133713371337',
    ...options,
  })
}

function autoHello(child: FakeChild): void {
  child.onWrite = request => {
      if (request.type === 'hello') {
      child.reply(request, {
        protocolVersion: COMPUTER_PROTOCOL_VERSION,
        helperVersion: '2.9.1',
        appVersion: '2.9.1',
        inputMonitorReady: true,
      })
    }
  }
}

function stopFailureWaitsForConfirmedExactChildExit(source: string): boolean {
  const stop = source.match(/async\s+stop\s*\(\s*\)[\s\S]*?(?=\n\s*async\s+shutdown\s*\()/)?.[0] ?? ''
  return /const\s+exactChildExit\s*=\s*this\.waitForExactChildExit\s*\(\s*exactChild\s*\)/.test(stop)
    && /let\s+exitConfirmed\s*=\s*await\s+this\.terminateExactChildAndWait\s*\(/.test(stop)
    && /if\s*\(\s*!exitConfirmed\s*\)\s*{\s*[\s\S]*?await\s+exactChildExit\s*;?[\s\S]*?exitConfirmed\s*=\s*true\s*;?\s*}/.test(stop)
}

function requestTimeoutAlwaysTerminatesExactGeneration(source: string): boolean {
  const request = source.match(/private\s+async\s+request\s*\([\s\S]*?(?=\n\s*private\s+ensureChild\s*\()/)?.[0] ?? ''
  const timeout = request.match(/timer:\s*setTimeout\s*\(\s*\(\)\s*=>\s*{[\s\S]*?\n\s*},\s*timeoutMs\s*\)/)?.[0] ?? ''
  return /this\.settlePending\s*\(/.test(timeout)
    && /this\.terminateExactChild\s*\(\s*generation\s*\)/.test(timeout)
    && !/if\s*\(\s*pending\.effectTransferred\s*\)[^{\n]*this\.terminateExactChild/.test(timeout)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe.runIf(process.platform === 'win32')('computer helper wire protocol', () => {
  it('rejects malformed, unknown-version and oversize messages fail-closed', () => {
    expect(parseComputerMessage('{')).toMatchObject({ ok: false, code: 'malformed_json' })
    expect(parseComputerMessage(JSON.stringify({ v: 999, type: 'ping', requestId: 'r' })))
      .toMatchObject({ ok: false, code: 'bad_version' })
    expect(parseComputerMessage('x'.repeat(MAX_COMPUTER_MESSAGE_BYTES + 1)))
      .toMatchObject({ ok: false, code: 'oversize' })
    expect(parseComputerMessage(JSON.stringify({
      v: COMPUTER_PROTOCOL_VERSION,
      type: 'ping',
      requestId: 'r',
      shell: 'whoami',
    }))).toMatchObject({ ok: false, code: 'forbidden_field' })
    expect(makeComputerRequest('ping', 'fixed-id', {
      v: 999,
      type: 'shutdown',
      requestId: 'replaced-id',
    })).toMatchObject({
      v: COMPUTER_PROTOCOL_VERSION,
      type: 'ping',
      requestId: 'fixed-id',
    })
  })

  it('spawns lazily with the exact reviewed PowerShell invocation and pins handshake versions', async () => {
    const child = new FakeChild()
    autoHello(child)
    const order: string[] = []
    const resolveOwnerStartTime100ns = vi.fn(() => {
      order.push('owner-identity')
      return '1337133713371337'
    })
    const spawn = vi.fn(() => {
      order.push('helper-spawn')
      return child
    })
    const client = new ComputerHelperClient({
      helperPath: 'C:\\reviewed path\\helper.ps1',
      appVersion: '2.9.1',
      spawn,
      resolveOwnerStartTime100ns,
    })

    expect(spawn).not.toHaveBeenCalled()
    await expect(client.hello()).resolves.toMatchObject({ helperVersion: '2.9.1' })
    expect(resolveOwnerStartTime100ns).toHaveBeenCalledWith(process.pid)
    expect(order).toEqual(['owner-identity', 'helper-spawn'])
    expect(spawn).toHaveBeenCalledWith(SYSTEM_POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', 'C:\\reviewed path\\helper.ps1',
      '-OwnerPid', String(process.pid),
      '-OwnerStartTime100ns', '1337133713371337',
    ], expect.objectContaining({ windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }))
    await client.shutdown()
  })

  it('resolves only the canonical absolute System32 PowerShell and rejects PATH/CWD aliases', () => {
    expect(win32.isAbsolute(SYSTEM_POWERSHELL)).toBe(true)
    expect(resolveSystemPowerShellPath()).toBe(SYSTEM_POWERSHELL)
    expect(() => requireSystemPowerShellPath('powershell.exe'))
      .toThrow(ComputerHelperProtocolError)
    expect(() => requireSystemPowerShellPath(win32.join(process.cwd(), 'powershell.exe')))
      .toThrow(ComputerHelperProtocolError)
  })

  it('queries the exact owner creation FILETIME as a canonical decimal string without Number conversion', () => {
    const spawnSync = vi.fn(() => ({
      pid: 42,
      output: [],
      stdout: '134047193123456789',
      stderr: '',
      status: 0,
      signal: null,
    }))

    expect(queryOwnerStartTime100ns(4242, spawnSync as never)).toBe('134047193123456789')
    expect(spawnSync).toHaveBeenCalledWith(SYSTEM_POWERSHELL, expect.arrayContaining([
      '-NoProfile', '-NonInteractive', '-Command', expect.stringMatching(/Get-Process -Id 4242[\s\S]*StartTime\.ToFileTimeUtc\(\)/),
    ]), expect.objectContaining({
      windowsHide: true,
      encoding: 'utf8',
      // Cold-starting canonical System32 PowerShell under the full parallel
      // suite can exceed one second. Keep the main-process wait bounded while
      // leaving enough room for the read-only exact owner identity query.
      timeout: 3_000,
      maxBuffer: expect.any(Number),
    }))
  })

  it.each([
    { stdout: '0134047193123456789', status: 0 },
    { stdout: '134047193123456789.0', status: 0 },
    { stdout: '', status: 1 },
  ])('fails closed on a missing or non-canonical owner creation FILETIME: $stdout', ({ stdout, status }) => {
    const spawnSync = vi.fn(() => ({
      pid: 42,
      output: [],
      stdout,
      stderr: 'not exposed',
      status,
      signal: null,
    }))
    expect(() => queryOwnerStartTime100ns(4242, spawnSync as never))
      .toThrow(ComputerHelperProtocolError)
  })

  it('does not spawn when the exact owner identity query fails', async () => {
    const child = new FakeChild()
    const spawn = vi.fn(() => child)
    const client = new ComputerHelperClient({
      helperPath: 'C:\\reviewed\\helper.ps1',
      appVersion: '2.9.1',
      spawn,
      resolveOwnerStartTime100ns: () => { throw new Error('owner unavailable') },
    })

    await expect(client.hello()).rejects.toThrow(/owner unavailable/i)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('requires the fresh helper candidate token and returns it only on the main-process contract', async () => {
    const child = new FakeChild()
    const candidateToken = `candidate-lease:${'a'.repeat(24)}`
    child.onWrite = request => {
      if (request.type === 'hello') child.reply(request, {
        protocolVersion: 1, helperVersion: '2.9.1', appVersion: '2.9.1', inputMonitorReady: true,
      })
      if (request.type === 'list_candidates') child.reply(request, {
        candidates: [{
          candidateId: 'legacy-deterministic-id', candidateToken, identity,
          processName: 'notepad', title: 'fresh candidate', titleFingerprint, elevated: false,
          productName: 'Windows Notepad', topLevelClassName: 'Notepad',
          geometry: { left: 1, top: 2, width: 300, height: 200 },
          visible: true, foreground: true,
          protectedProcess: false, secureSurface: false,
        }],
      })
      if (request.type === 'probe_binding') child.reply(request, {
        probe: {
          identity, title: 'fresh candidate', titleFingerprint,
          geometry: { left: 1, top: 2, width: 300, height: 200 }, dpi: 96,
          foreground: true, screenLocked: false, userInputEpoch: 1,
        },
      })
    }
    const client = createClient(child)

    const [candidate] = await client.listCandidates()
    expect(candidate).toMatchObject({
      candidateToken, productName: 'Windows Notepad', topLevelClassName: 'Notepad',
      geometry: { left: 1, top: 2, width: 300, height: 200 },
      visible: true, foreground: true,
    })
    await expect(client.probeBinding(identity, candidateToken)).resolves.toMatchObject({
      title: 'fresh candidate',
    })
    expect(child.writes.find(request => request.type === 'probe_binding'))
      .toMatchObject({ candidateToken })
    child.exit(0)
  })

  it.each([undefined, '  stale title  '])('rejects a missing or unnormalized helper probe title: %s', async title => {
    const child = new FakeChild()
    child.onWrite = request => {
      if (request.type === 'hello') child.reply(request, {
        protocolVersion: 1, helperVersion: '2.9.1', appVersion: '2.9.1', inputMonitorReady: true,
      })
      if (request.type === 'probe_binding') child.reply(request, {
        probe: {
          identity,
          ...(title === undefined ? {} : { title }),
          titleFingerprint,
          geometry: { left: 1, top: 2, width: 300, height: 200 }, dpi: 96,
          foreground: true, screenLocked: false, userInputEpoch: 1,
        },
      })
    }
    const client = createClient(child)

    await expect(client.probeBinding(identity)).rejects.toThrow(/probe metadata invalid/i)
    child.exit(0)
  })

  it.each([undefined, 'A'.repeat(64), 'b'.repeat(63)])(
    'rejects a missing or malformed complete-title fingerprint: %s',
    async fingerprint => {
      const child = new FakeChild()
      child.onWrite = request => {
        if (request.type === 'hello') child.reply(request, {
          protocolVersion: 1, helperVersion: '2.9.1', appVersion: '2.9.1', inputMonitorReady: true,
        })
        if (request.type === 'probe_binding') child.reply(request, {
          probe: {
            identity,
            title: 'Temporary canary',
            ...(fingerprint === undefined ? {} : { titleFingerprint: fingerprint }),
            geometry: { left: 1, top: 2, width: 300, height: 200 }, dpi: 96,
            foreground: true, screenLocked: false, userInputEpoch: 1,
          },
        })
      }
      const client = createClient(child)

      await expect(client.probeBinding(identity)).rejects.toThrow(/probe metadata invalid/i)
      child.exit(0)
    },
  )

  it('ACKs a cold Stop without spawning a helper', async () => {
    const child = new FakeChild()
    const spawn = vi.fn(() => child)
    const client = new ComputerHelperClient({
      helperPath: 'C:\\reviewed\\helper.ps1',
      appVersion: '2.9.1',
      spawn,
    })

    await expect(client.stop()).resolves.toEqual({ stopped: true })
    expect(spawn).not.toHaveBeenCalled()
    expect(child.writes).toEqual([])
  })

  it('bypasses a stalled handshake and bounds Stop on the existing exact child', async () => {
    const child = new FakeChild()
    const spawn = vi.fn(() => child)
    const client = new ComputerHelperClient({
      helperPath: 'C:\\reviewed\\helper.ps1',
      appVersion: '2.9.1',
      spawn,
      resolveOwnerStartTime100ns: () => '1337133713371337',
      requestTimeoutMs: 10_000,
      stopAckTimeoutMs: 30,
      shutdownTimeoutMs: 30,
    })
    const stalledHello = client.hello().then(() => 'resolved', () => 'rejected')
    await vi.waitFor(() => expect(child.writes.map(message => message.type)).toEqual(['hello']), {
      interval: 1,
      timeout: 50,
    })

    const startedAt = Date.now()
    await expect(client.stop()).rejects.toThrow(/Stop ACK/i)
    expect(Date.now() - startedAt).toBeLessThan(300)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(child.writes.map(message => message.type)).toEqual(['hello', 'stop'])
    expect(child.killed).toBe(true)
    await expect(stalledHello).resolves.toBe('rejected')
  })

  it.each(['hello', 'list', 'probe', 'prepare', 'ping'] as const)(
    'retires the exact child after a hung %s request and blocks a successor until exact exit',
    async requestKind => {
      const stalledChild = new FakeChild()
      stalledChild.exitOnKill = false
      stalledChild.onWrite = request => {
        if (request.type === 'hello' && requestKind !== 'hello') {
          stalledChild.reply(request, {
            protocolVersion: COMPUTER_PROTOCOL_VERSION,
            helperVersion: '2.9.1',
            appVersion: '2.9.1',
            inputMonitorReady: true,
          })
        }
      }
      const freshChild = new FakeChild()
      autoHello(freshChild)
      const spawn = vi.fn()
        .mockReturnValueOnce(stalledChild)
        .mockReturnValueOnce(freshChild)
      const client = new ComputerHelperClient({
        helperPath: 'C:\\reviewed\\helper.ps1',
        appVersion: '2.9.1',
        spawn,
        requestTimeoutMs: 20,
        resolveOwnerStartTime100ns: () => '1337133713371337',
      })
      const lifecycleEvents: string[] = []
      client.onEvent(event => lifecycleEvents.push(event.type))

      const stalled = requestKind === 'hello'
        ? client.hello()
        : requestKind === 'list'
          ? client.listCandidates()
          : requestKind === 'probe'
            ? client.probeBinding(identity)
            : requestKind === 'prepare'
              ? client.prepareAction({
                  attemptId: 'attempt-stalled-prepare',
                  identity,
                  action: { kind: 'click' },
                  resolvedElement: { backendRef: 'opaque-ref' },
                  expected: {
                    title: 'Temporary canary',
                    titleFingerprint,
                    geometry: { left: 1, top: 2, width: 300, height: 200 },
                    dpi: 120,
                    userInputEpoch: 10,
                    foreground: true,
                    screenLocked: false,
                  },
                })
              : client.ping()

      await expect(stalled).rejects.toBeInstanceOf(ComputerHelperProtocolError)
      expect(stalledChild.killed).toBe(true)
      expect(stalledChild.signalCode).toBeNull()
      expect(lifecycleEvents).toEqual(['helper-crashed'])
      await expect(client.hello()).rejects.toThrow(/still terminating/i)
      expect(spawn).toHaveBeenCalledTimes(1)

      stalledChild.exit(1)
      expect(lifecycleEvents).toEqual(['helper-crashed'])
      await expect(client.hello()).resolves.toMatchObject({ helperVersion: '2.9.1' })
      expect(spawn).toHaveBeenCalledTimes(2)
      freshChild.exit(0)
    },
  )

  it('mutation-pins unconditional exact-generation termination on every request timeout', () => {
    const source = readFileSync(join(process.cwd(), 'electron', 'ai', 'computer', 'helper-client.ts'), 'utf8')
    expect(requestTimeoutAlwaysTerminatesExactGeneration(source)).toBe(true)

    const transferredOnlyMutation = source.replace(
      /(?<indent>\s*)this\.terminateExactChild\(generation\)(?=\s*\n\s*},\s*timeoutMs\))/,
      '$<indent>if (pending.effectTransferred) this.terminateExactChild(generation)',
    )
    expect(transferredOnlyMutation).not.toBe(source)
    expect(requestTimeoutAlwaysTerminatesExactGeneration(transferredOnlyMutation)).toBe(false)
  })

  it('requires the stable opaque semantic fingerprint on observed elements', async () => {
    const child = new FakeChild()
    let observationCount = 0
    child.onWrite = request => {
      if (request.type === 'hello') child.reply(request, {
        protocolVersion: 1, helperVersion: '2.9.1', appVersion: '2.9.1',
        inputMonitorReady: true,
      })
      if (request.type === 'observe') {
        observationCount += 1
        const element = {
          backendRef: `element-${observationCount}`,
          ...(observationCount === 1 ? { semanticFingerprint: 'a'.repeat(64) } : {}),
          role: 'button',
          label: 'Safe action',
          isPassword: false,
          supportedActions: ['click'],
        }
        child.reply(request, {
          observation: {
            probe: {
              identity,
              title: 'Temporary canary',
              titleFingerprint,
              geometry: { left: 1, top: 2, width: 300, height: 200 },
              dpi: 120,
              foreground: true,
              screenLocked: false,
              userInputEpoch: 10,
            },
            elements: [element],
            omissions: [],
          },
        })
      }
    }
    const client = createClient(child)

    await expect(client.observe(identity)).resolves.toMatchObject({
      elements: [{ semanticFingerprint: 'a'.repeat(64) }],
    })
    await expect(client.observe(identity)).rejects.toThrow(/observation element invalid/i)
    child.exit(0)
  })

  it('normalizes unavailable nullable UIA state to omitted controller fields', async () => {
    const child = new FakeChild()
    child.onWrite = request => {
      if (request.type === 'hello') child.reply(request, {
        protocolVersion: 1, helperVersion: '2.9.1', appVersion: '2.9.1', inputMonitorReady: true,
      })
      if (request.type !== 'observe') return
      child.reply(request, {
        observation: {
          probe: {
            identity, title: 'Temporary canary', titleFingerprint,
            geometry: { left: 1, top: 2, width: 300, height: 200 }, dpi: 120,
            foreground: true, screenLocked: false, userInputEpoch: 10,
          },
          elements: [{
            backendRef: 'nullable-state', semanticFingerprint: 'a'.repeat(64),
            role: 'text', label: 'Read only', isPassword: false,
            supportedActions: [], valueState: null, scrollState: null,
          }],
          omissions: [],
        },
      })
    }
    const client = createClient(child)

    const observation = await client.observe(identity)
    expect(observation.elements[0]).not.toHaveProperty('valueState')
    expect(observation.elements[0]).not.toHaveProperty('scrollState')
    child.exit(0)
  })

  it('accepts only bounded PNG window captures and rejects oversized or non-PNG image payloads', async () => {
    const child = new FakeChild()
    let observationCount = 0
    const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lQj8WQAAAABJRU5ErkJggg=='
    child.onWrite = request => {
      if (request.type === 'hello') child.reply(request, {
        protocolVersion: 1, helperVersion: '2.9.1', appVersion: '2.9.1', inputMonitorReady: true,
      })
      if (request.type !== 'observe') return
      observationCount += 1
      child.reply(request, {
        observation: {
          probe: {
            identity, title: 'Temporary canary', titleFingerprint,
            geometry: { left: 1, top: 2, width: 300, height: 200 }, dpi: 120,
            foreground: true, screenLocked: false, userInputEpoch: 10,
          },
          elements: [], omissions: [],
          screenshotDataUrl: observationCount === 1
            ? `data:image/png;base64,${onePixelPng}`
            : observationCount === 2
              ? `data:image/png;base64,${Buffer.alloc(16_385).toString('base64')}`
              : 'data:image/svg+xml;base64,PHN2Zy8+',
        },
      })
    }
    const client = createClient(child)

    await expect(client.observe(identity)).resolves.toMatchObject({
      screenshotDataUrl: `data:image/png;base64,${onePixelPng}`,
    })
    await expect(client.observe(identity)).rejects.toThrow(/screenshot/i)
    await expect(client.observe(identity)).rejects.toThrow(/screenshot/i)
    child.exit(0)
  })

  it('runs prepare -> prepared -> commit and marks the exact transfer boundary', async () => {
    const child = new FakeChild()
    autoHello(child)
    child.onWrite = request => {
      if (request.type === 'hello') child.reply(request, {
        protocolVersion: 1, helperVersion: '2.9.1', appVersion: '2.9.1',
        inputMonitorReady: true,
      })
      if (request.type === 'prepare_action') child.reply(request, {
        preparedId: 'prepared-1',
        attemptId: 'attempt-1',
        method: 'uia',
        identity,
        requiresHitTest: false,
        chunkGuards: 'backend-enforced',
        targetCheckIntervalMs: 50,
      })
      if (request.type === 'commit_action') child.reply(request, {
        readback: {
          matched: true,
          dispatchAccepted: true,
          effectMatched: false,
          detail: 'dispatch accepted; effect not independently proven',
          postUserInputEpoch: 77,
        },
      })
      if (request.type === 'shutdown') child.reply(request)
    }
    const client = createClient(child)
    const prepared = await client.prepareAction({
      attemptId: 'attempt-1',
      identity,
      action: { kind: 'click' },
      resolvedElement: { backendRef: 'opaque-ref' },
      expected: {
        title: 'Temporary canary',
        titleFingerprint,
        geometry: { left: 1, top: 2, width: 300, height: 200 },
        dpi: 120,
        userInputEpoch: 10,
        foreground: true,
        screenLocked: false,
      },
    })
    const transferred = vi.fn()
    await expect(client.commitAction(prepared, { onTransferred: transferred }))
      .resolves.toEqual({
        readback: {
          matched: true,
          dispatchAccepted: true,
          effectMatched: false,
          detail: 'dispatch accepted; effect not independently proven',
          postUserInputEpoch: 77,
        },
      })
    expect(child.writes.map(message => message.type)).toEqual([
      'hello', 'prepare_action', 'commit_action',
    ])
    expect(transferred).toHaveBeenCalledTimes(1)
    expect(prepared).toMatchObject({ chunkGuards: 'backend-enforced', targetCheckIntervalMs: 50 })
    await client.shutdown()
  })

  it('keeps the helper-private expected-after ValuePattern token on a long UIA prepare', async () => {
    const child = new FakeChild()
    autoHello(child)
    const expectedAfterValueState = { fingerprint: 'e'.repeat(64), scalarLength: 17 }
    child.onWrite = request => {
      if (request.type === 'hello') child.reply(request, {
        protocolVersion: 1, helperVersion: '2.9.1', appVersion: '2.9.1',
        inputMonitorReady: true,
      })
      if (request.type === 'prepare_action') child.reply(request, {
        preparedId: 'prepared-long-type',
        attemptId: 'attempt-long-type',
        method: 'uia',
        identity,
        requiresHitTest: false,
        chunkGuards: 'backend-enforced',
        targetCheckIntervalMs: 50,
        expectedAfterValueState,
      })
      if (request.type === 'shutdown') child.reply(request)
    }
    const client = createClient(child)

    await expect(client.prepareAction({
      attemptId: 'attempt-long-type',
      identity,
      action: { kind: 'type' },
      resolvedElement: {
        backendRef: 'opaque-value-ref',
        expectedValueState: { fingerprint: 'c'.repeat(64), scalarLength: 0 },
      },
      textChunks: ['0123456789abcdef', 'Z'],
      expected: {
        title: 'Temporary canary',
        titleFingerprint,
        geometry: { left: 1, top: 2, width: 300, height: 200 },
        dpi: 120,
        userInputEpoch: 10,
        foreground: true,
        screenLocked: false,
      },
    })).resolves.toMatchObject({
      method: 'uia',
      chunkGuards: 'backend-enforced',
      targetCheckIntervalMs: 50,
      expectedAfterValueState,
    })
    await client.shutdown()
  })

  it('classifies helper exit after commit transfer as unknown effect and never retries', async () => {
    const child = new FakeChild()
    autoHello(child)
    child.onWrite = request => {
      if (request.type === 'hello') child.reply(request, {
        protocolVersion: 1, helperVersion: '2.9.1', appVersion: '2.9.1',
        inputMonitorReady: true,
      })
      if (request.type === 'commit_action') queueMicrotask(() => child.exit(7))
    }
    const client = createClient(child)
    const transferred = vi.fn()
    await expect(client.commitAction({
      preparedId: 'prepared-unknown',
      attemptId: 'attempt-unknown',
      method: 'uia',
      identity,
      requiresHitTest: false,
    }, { onTransferred: transferred })).rejects.toBeInstanceOf(ComputerUnknownEffectError)
    expect(transferred).toHaveBeenCalledTimes(1)
    expect(child.writes.filter(message => message.type === 'commit_action')).toHaveLength(1)
  })

  it.each([
    ['stdout error', (child: FakeChild) => child.stdout.emit('error', new Error('stdout pipe failed'))],
    ['stdin error', (child: FakeChild) => child.stdin.emit('error', new Error('stdin pipe failed'))],
    ['child-process error', (child: FakeChild) => child.emit('error', new Error('child process failed'))],
  ] as const)(
    'retires a transferred commit generation on %s and waits for the exact child exit',
    async (_label, failTransport) => {
      const failedChild = new FakeChild()
      failedChild.exitOnKill = false
      autoHello(failedChild)
      const successorChild = new FakeChild()
      autoHello(successorChild)
      const spawn = vi.fn()
        .mockReturnValueOnce(failedChild)
        .mockReturnValueOnce(successorChild)
      const client = new ComputerHelperClient({
        helperPath: 'C:\\reviewed\\helper.ps1',
        appVersion: '2.9.1',
        spawn,
        requestTimeoutMs: 1_000,
        resolveOwnerStartTime100ns: () => '1337133713371337',
      })
      const lifecycleEvents: string[] = []
      client.onEvent(event => lifecycleEvents.push(event.type))
      const transferred = vi.fn()

      const commit = client.commitAction({
        preparedId: 'prepared-pipe-error',
        attemptId: 'attempt-pipe-error',
        method: 'uia',
        identity,
        requiresHitTest: false,
      }, { onTransferred: transferred })
      await vi.waitFor(() => {
        expect(failedChild.writes.some(message => message.type === 'commit_action')).toBe(true)
      }, { interval: 1, timeout: 50 })
      expect(transferred).toHaveBeenCalledTimes(1)

      failTransport(failedChild)

      await expect(commit).rejects.toBeInstanceOf(ComputerUnknownEffectError)
      expect(failedChild.killed).toBe(true)
      expect(lifecycleEvents).toEqual(['helper-crashed'])
      await expect(client.hello()).rejects.toThrow(/still terminating/i)
      expect(spawn).toHaveBeenCalledTimes(1)

      let stopSettled = false
      const stopped = client.stop().then(result => {
        stopSettled = true
        return result
      })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(stopSettled).toBe(false)

      failedChild.exit(1)
      await expect(stopped).resolves.toEqual({ stopped: true })
      expect(lifecycleEvents).toEqual(['helper-crashed'])
      await expect(client.hello()).resolves.toMatchObject({ helperVersion: '2.9.1' })
      expect(spawn).toHaveBeenCalledTimes(2)
      successorChild.exit(0)
    },
  )

  it('cancellation before commit is definite and cannot become an unknown effect', async () => {
    const child = new FakeChild()
    autoHello(child)
    const client = createClient(child)
    const controller = new AbortController()
    controller.abort()
    await expect(client.commitAction({
      preparedId: 'never-sent',
      attemptId: 'attempt-cancelled',
      method: 'uia',
      identity,
      requiresHitTest: false,
    }, { signal: controller.signal })).rejects.toBeInstanceOf(ComputerHelperCancelledError)
    expect(child.writes.some(message => message.type === 'commit_action')).toBe(false)
    await client.shutdown()
  })

  it('ACKs cancel and Stop; missing Stop ACK kills only the exact helper child', async () => {
    const child = new FakeChild()
    autoHello(child)
    child.onWrite = request => {
      if (request.type === 'hello') child.reply(request, {
        protocolVersion: 1, helperVersion: '2.9.1', appVersion: '2.9.1',
        inputMonitorReady: true,
      })
      if (request.type === 'cancel') child.reply(request, { cancelled: true })
      if (request.type === 'shutdown') child.reply(request)
    }
    const client = createClient(child)
    await expect(client.cancel('attempt-1')).resolves.toMatchObject({ cancelled: true })
    await expect(client.stop()).rejects.toThrow(/Stop ACK/i)
    expect(child.killed).toBe(true)
    expect(child.signalCode).toBe('SIGTERM')
  })

  it('lets Stop overtake an outstanding observation and receive its own ACK', async () => {
    const child = new FakeChild()
    autoHello(child)
    child.onWrite = request => {
      if (request.type === 'hello') child.reply(request, {
        protocolVersion: 1, helperVersion: '2.9.1', appVersion: '2.9.1',
        inputMonitorReady: true,
      })
      if (request.type === 'stop') {
        child.reply(request, { stopped: true })
        const observe = child.writes.find(message => message.type === 'observe')
        if (observe) child.fail(observe, 'observe_cancelled', 'observation cancelled')
      }
    }
    const client = createClient(child, { requestTimeoutMs: 1_000 })
    const observed = client.observe(identity).then(() => 'resolved', () => 'rejected')
    await vi.waitFor(() => {
      expect(child.writes.some(message => message.type === 'observe')).toBe(true)
    }, { interval: 1, timeout: 50 })

    await expect(client.stop()).resolves.toEqual({ stopped: true })
    await expect(observed).resolves.toBe('rejected')
    expect(child.writes.map(message => message.type)).toEqual(['hello', 'observe', 'stop'])
    expect(child.killed).toBe(false)
    child.exit(0)
  })

  it('rejects a malformed Stop response and terminates the exact helper child', async () => {
    const child = new FakeChild()
    child.onWrite = request => {
      if (request.type === 'hello') child.reply(request, {
        protocolVersion: 1, helperVersion: '2.9.1', appVersion: '2.9.1',
        inputMonitorReady: true,
      })
      if (request.type === 'stop') child.reply(request)
    }
    const client = createClient(child)
    await client.hello()

    await expect(client.stop()).rejects.toThrow(/malformed Stop ACK/i)
    expect(child.killed).toBe(true)
    expect(child.signalCode).toBe('SIGTERM')
  })

  it('does not finish Stop failure handling before the exact helper child exits', async () => {
    const child = new FakeChild()
    child.exitOnKill = false
    autoHello(child)
    const client = createClient(child, { shutdownTimeoutMs: 100 })
    await client.hello()
    vi.useFakeTimers()
    try {
      let settled = false
      const stopped = client.stop().then(
        () => { settled = true; return 'resolved' },
        () => { settled = true; return 'rejected' },
      )

      // Advance well beyond the supported-matrix 500ms target. A child that
      // ignored termination must keep Stop (and every successor) fail-closed.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(child.killed).toBe(true)
      expect(settled).toBe(false)

      child.exit(1)
      await expect(stopped).resolves.toBe('rejected')
    } finally {
      vi.useRealTimers()
      if (child.exitCode == null && child.signalCode == null) child.exit(1)
    }
  })

  it('keeps Stop pending while a timed-out transferred commit exact child is still terminating', async () => {
    const child = new FakeChild()
    child.exitOnKill = false
    autoHello(child)
    const client = createClient(child, { requestTimeoutMs: 20 })
    const commit = client.commitAction({
      preparedId: 'prepared-timeout',
      attemptId: 'attempt-timeout',
      method: 'uia',
      identity,
      requiresHitTest: false,
    })

    await expect(commit).rejects.toBeInstanceOf(ComputerUnknownEffectError)
    expect(child.killed).toBe(true)
    let settled = false
    const stopped = client.stop().then(result => {
      settled = true
      return result
    })
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(settled).toBe(false)

    child.exit(1)
    await expect(stopped).resolves.toEqual({ stopped: true })
  })

  it('does not finish shutdown before its exact child has actually exited', async () => {
    const child = new FakeChild()
    child.exitOnKill = false
    autoHello(child)
    const client = createClient(child, { shutdownTimeoutMs: 20 })
    await client.hello()

    let settled = false
    const shutdown = client.shutdown().then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(child.killed).toBe(true)
    expect(settled).toBe(false)

    child.exit(1)
    await shutdown
    expect(settled).toBe(true)
  })

  it('mutation-pins exact-child exit confirmation after the Stop target budget', () => {
    const source = readFileSync(join(process.cwd(), 'electron', 'ai', 'computer', 'helper-client.ts'), 'utf8')
    expect(stopFailureWaitsForConfirmedExactChildExit(source)).toBe(true)

    const earlyFailureMutation = source.replace(
      'await exactChildExit',
      'void exactChildExit /* mutated: successor may open while child lives */',
    )
    expect(earlyFailureMutation).not.toBe(source)
    expect(stopFailureWaitsForConfirmedExactChildExit(earlyFailureMutation)).toBe(false)
  })

  it('never lets a late duplicate request id settle its successor', async () => {
    const firstChild = new FakeChild()
    autoHello(firstChild)
    const successorChild = new FakeChild()
    successorChild.onWrite = request => {
      if (request.type === 'hello') successorChild.reply(request, {
        protocolVersion: COMPUTER_PROTOCOL_VERSION,
        helperVersion: '2.9.1',
        appVersion: '2.9.1',
        inputMonitorReady: true,
      })
      if (request.type === 'shutdown') successorChild.reply(request)
    }
    const spawn = vi.fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(successorChild)
    const client = new ComputerHelperClient({
      helperPath: 'C:\\reviewed\\helper.ps1',
      appVersion: '2.9.1',
      spawn,
      resolveOwnerStartTime100ns: () => '1337133713371337',
      requestIdFactory: () => 'same-logical-id',
      requestTimeoutMs: 25,
    })
    const first = client.ping()
    const firstRejection = expect(first).rejects.toThrow(/timeout/i)
    await vi.waitFor(() => {
      expect(firstChild.writes.filter(message => message.type === 'ping')).toHaveLength(1)
    }, { interval: 1, timeout: 20 })
    const firstWire = firstChild.writes.find(message => message.type === 'ping')!
    await firstRejection

    const second = client.ping()
    await vi.waitFor(() => {
      expect(successorChild.writes.filter(message => message.type === 'ping')).toHaveLength(1)
    }, { interval: 1, timeout: 20 })
    const secondWire = successorChild.writes.find(message => message.type === 'ping')!
    expect(secondWire.requestId).not.toBe(firstWire.requestId)
    firstChild.reply(firstWire, { nonce: 'late' })
    successorChild.reply(secondWire, { nonce: 'fresh' })
    await expect(second).resolves.toMatchObject({ nonce: 'fresh' })
    await client.shutdown()
  })

  it('fails the generation on malformed or oversized stdout and caps redacted stderr', async () => {
    const child = new FakeChild()
    autoHello(child)
    const client = createClient(child, { stderrLimitBytes: 96 })
    await client.hello()
    child.stderr.write('token=super-')
    child.stderr.write(`secret-value ${'x'.repeat(500)}`)
    await vi.waitFor(() => {
      expect(client.getRedactedStderr()).toContain('redacted')
    }, { interval: 1, timeout: 50 })
    const pending = client.ping()
    await vi.waitFor(() => {
      expect(child.writes.some(message => message.type === 'ping')).toBe(true)
    }, { interval: 1, timeout: 50 })
    child.stdout.write('{broken}\n')
    await expect(pending).rejects.toBeInstanceOf(ComputerHelperProtocolError)
    const diagnostic = client.getRedactedStderr()
    expect(diagnostic).toContain('redacted')
    expect(Buffer.byteLength(diagnostic, 'utf8')).toBeLessThanOrEqual(96)
    expect(diagnostic).not.toContain('super-secret-value')
    expect(child.killed).toBe(true)

    const oversizedChild = new FakeChild()
    autoHello(oversizedChild)
    const oversizedClient = createClient(oversizedChild)
    await oversizedClient.hello()
    const oversizedPending = oversizedClient.ping()
    oversizedChild.stdout.write(`${'x'.repeat(MAX_COMPUTER_MESSAGE_BYTES + 1)}\n`)
    await expect(oversizedPending).rejects.toBeInstanceOf(ComputerHelperProtocolError)
    expect(oversizedChild.killed).toBe(true)
  })
})
