// bridge-host-lifecycle.test.ts — packaged assets + registry lifecycle (EXT-B1).

import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { withNativeHostOwnershipLock } from '../../../electron/ai/browser/bridge/host-lifecycle'

const registryProcess = vi.hoisted(() => {
  const values = new Map<string, string>()
  const addFailures = new Set<string>()
  const deleteFailures = new Set<string>()
  const queryFailures = new Set<string>()
  const queryStatusOneFailures = new Set<string>()
  const replaceBeforeDelete = new Map<string, string>()
  const replaceBeforeRestore = new Map<string, string>()
  const spawnSync = vi.fn((command: string, args: readonly string[] = [], options?: { encoding?: string }) => {
    if (command === 'powershell.exe') {
      const encodedIndex = args.indexOf('-EncodedCommand')
      const script = encodedIndex >= 0
        ? Buffer.from(String(args[encodedIndex + 1] || ''), 'base64').toString('utf16le')
        : ''
      const keyMatch = /\$keyBase64 = '([^']+)'/.exec(script)
      const subKey = keyMatch ? Buffer.from(keyMatch[1], 'base64').toString('utf8') : ''
      const key = subKey ? `HKCU\\${subKey}` : ''
      if (script.includes('VERSTAK_VERIFY_STABLE_OWNER_V1')) {
        return { status: 0, stdout: 'OWNED', stderr: '' }
      }
      if (script.includes('VERSTAK_QUERY_DEFAULT_V1')) {
        if (queryStatusOneFailures.has(key)) {
          return { status: 1, stdout: '', stderr: 'Invalid syntax.' }
        }
        if (queryFailures.has(key)) {
          return { status: 5, stdout: '', stderr: 'Access is denied.' }
        }
        const value = values.get(key)
        return value === undefined
          ? { status: 0, stdout: 'ABSENT', stderr: '' }
          : { status: 0, stdout: `PRESENT ${Buffer.from(value, 'utf8').toString('base64')}`, stderr: '' }
      }
      if (script.includes('VERSTAK_DELETE_IF_MATCH_V1')) {
        const expectedMatch = /\$expectedBase64 = '([^']+)'/.exec(script)
        const expected = expectedMatch
          ? Buffer.from(expectedMatch[1], 'base64').toString('utf8')
          : ''
        const successor = replaceBeforeDelete.get(key)
        if (successor) values.set(key, successor)
        if (deleteFailures.has(key)) {
          return { status: 5, stdout: '', stderr: 'Access is denied.' }
        }
        const current = values.get(key)
        if (current === undefined) return { status: 0, stdout: 'ABSENT', stderr: '' }
        const normalize = (value: string) => value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
        if (normalize(current) !== normalize(expected)) {
          return {
            status: 0,
            stdout: `SUCCESSOR ${Buffer.from(current, 'utf8').toString('base64')}`,
            stderr: '',
          }
        }
        values.delete(key)
        return { status: 0, stdout: 'DELETED', stderr: '' }
      }
      if (script.includes('VERSTAK_RESTORE_IF_UNCHANGED_V2')) {
        const state = (name: string) => new RegExp(`\\$${name} = '([^']+)'`).exec(script)?.[1] ?? ''
        const decoded = (name: string) => {
          const value = state(name)
          return value ? Buffer.from(value, 'base64').toString('utf8') : ''
        }
        const previousState = state('previousState')
        const expectedState = state('expectedState')
        const previousValue = decoded('previousValueBase64')
        const expectedValue = decoded('expectedValueBase64')
        const replacement = replaceBeforeRestore.get(key)
        if (replacement) values.set(key, replacement)
        const current = values.get(key)
        const normalize = (value: string) => value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
        const matchesExpected = expectedState === 'any'
          || (expectedState === 'absent' && current === undefined)
          || (expectedState === 'present' && current !== undefined && normalize(current) === normalize(expectedValue))
        if (!matchesExpected) return { status: 0, stdout: 'SUCCESSOR', stderr: '' }
        if (previousState === 'present') {
          if (addFailures.has(key)) return { status: 5, stdout: '', stderr: 'Access is denied.' }
          values.set(key, previousValue)
        } else {
          if (deleteFailures.has(key)) return { status: 5, stdout: '', stderr: 'Access is denied.' }
          values.delete(key)
        }
        return { status: 0, stdout: 'RESTORED', stderr: '' }
      }
      return { status: 9, stdout: '', stderr: 'unsupported PowerShell registry protocol' }
    }
    if (command !== 'reg.exe') {
      throw new Error(`unexpected process in registry unit adapter: ${command}`)
    }
    const operation = args[0]
    const key = args[1]
    if (operation === 'add' && key) {
      if (addFailures.has(key)) {
        return { status: 5, stdout: '', stderr: 'Access is denied.' }
      }
      const valueIndex = args.indexOf('/d')
      values.set(key, valueIndex >= 0 ? String(args[valueIndex + 1] || '') : '')
      return { status: 0, stdout: '', stderr: '' }
    }
    if (operation === 'query' && key) {
      if (queryStatusOneFailures.has(key)) {
        return options?.encoding === 'buffer'
          ? { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('Invalid syntax.', 'utf8') }
          : { status: 1, stdout: '', stderr: 'Invalid syntax.' }
      }
      if (queryFailures.has(key)) {
        return options?.encoding === 'buffer'
          ? { status: 5, stdout: Buffer.alloc(0), stderr: Buffer.from('Access is denied.', 'utf8') }
          : { status: 5, stdout: '', stderr: 'Access is denied.' }
      }
      const value = values.get(key)
      if (value === undefined) {
        return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
      }
      const stdout = Buffer.from(`${key}\r\n    (Default)    REG_SZ    ${value}\r\n`, 'utf8')
      return options?.encoding === 'buffer'
        ? { status: 0, stdout, stderr: Buffer.alloc(0) }
        : { status: 0, stdout: stdout.toString('utf8'), stderr: '' }
    }
    if (operation === 'delete' && key) {
      const successor = replaceBeforeDelete.get(key)
      if (successor) values.set(key, successor)
      if (deleteFailures.has(key)) {
        return { status: 5, stdout: '', stderr: 'Access is denied.' }
      }
      values.delete(key)
      return { status: 0, stdout: '', stderr: '' }
    }
    return { status: 1, stdout: '', stderr: 'unsupported reg.exe test invocation' }
  })
  return {
    values,
    addFailures,
    deleteFailures,
    queryFailures,
    queryStatusOneFailures,
    replaceBeforeDelete,
    replaceBeforeRestore,
    spawnSync,
  }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: registryProcess.spawnSync }
})
import {
  buildHostCmdContent,
  buildHostManifest,
  validateHostManifest,
  installNativeHost,
  uninstallNativeHost,
  removeNativeMessagingRegistry,
  readInstalledManifest,
  readNativeMessagingRegistry,
  decodeRegistryOutput,
  chromeRegistryKey,
  edgeRegistryKey,
  NATIVE_HOST_NAME,
  EXTENSION_ORIGIN,
  EXTENSION_ID,
  BROWSER_EXTENSION_VERSION,
  BRIDGE_PROTOCOL_VERSION,
  NATIVE_HOST_METADATA_FILE,
  validateInstalledHostBundle,
  type BrowserBridgeVersions,
  type NativeMessagingRegistryAdapter,
} from '../../../electron/ai/browser/bridge'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')

const temps: string[] = []
const versions = (appVersion = '2.8.2'): BrowserBridgeVersions => ({
  protocolVersion: BRIDGE_PROTOCOL_VERSION,
  appVersion,
  extensionVersion: BROWSER_EXTENSION_VERSION,
  hostVersion: appVersion,
})

function memoryRegistry(
  values = new Map<string, string>(),
  failNextWrite = false,
): NativeMessagingRegistryAdapter {
  return {
    write(manifestPath) {
      values.set(chromeRegistryKey(), manifestPath)
      if (failNextWrite) return { ok: false, keys: [chromeRegistryKey()], error: 'fixture write failed' }
      values.set(edgeRegistryKey(), manifestPath)
      return { ok: true, keys: [chromeRegistryKey(), edgeRegistryKey()] }
    },
    snapshot: () => ({
      [chromeRegistryKey()]: values.has(chromeRegistryKey())
        ? { state: 'present' as const, value: values.get(chromeRegistryKey())! }
        : { state: 'absent' as const },
      [edgeRegistryKey()]: values.has(edgeRegistryKey())
        ? { state: 'present' as const, value: values.get(edgeRegistryKey())! }
        : { state: 'absent' as const },
    }),
    read: () => ({
      [chromeRegistryKey()]: values.get(chromeRegistryKey()) ?? null,
      [edgeRegistryKey()]: values.get(edgeRegistryKey()) ?? null,
    }),
    remove() {
      values.clear()
      return { ok: true }
    },
    restore(snapshot, expectedCurrent) {
      const normalize = (value: string) => value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
      for (const [key, entry] of Object.entries(snapshot)) {
        const current = values.has(key)
          ? { state: 'present' as const, value: values.get(key)! }
          : { state: 'absent' as const }
        const expected = expectedCurrent?.[key]
        const matchesExpected = !expected
          || (expected.state === current.state && (
            expected.state === 'absent'
            || (current.state === 'present' && normalize(expected.value) === normalize(current.value))
          ))
        if (!matchesExpected) continue
        if (entry.state === 'present') values.set(key, entry.value)
        else values.delete(key)
      }
      return { ok: true }
    },
  }
}
afterEach(() => {
  // Registry lifecycle is fully in-memory in this unit suite. Never delete a
  // user's installed NativeMessagingHosts while running ordinary tests.
  registryProcess.values.clear()
  registryProcess.addFailures.clear()
  registryProcess.deleteFailures.clear()
  registryProcess.queryFailures.clear()
  registryProcess.queryStatusOneFailures.clear()
  registryProcess.replaceBeforeDelete.clear()
  registryProcess.replaceBeforeRestore.clear()
  registryProcess.spawnSync.mockClear()
  for (const d of temps.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('packaged browser-bridge assets', () => {
  it('resources/browser-bridge/* и host-runtime.mjs существуют', () => {
    expect(existsSync(join(ROOT, 'resources', 'browser-bridge', 'ru.verstak.browser_bridge.json'))).toBe(true)
    expect(existsSync(join(ROOT, 'resources', 'browser-bridge', 'host.cmd'))).toBe(true)
    expect(existsSync(join(ROOT, 'electron', 'ai', 'browser', 'bridge', 'host-runtime.mjs'))).toBe(true)
    expect(existsSync(join(ROOT, 'resources', 'browser-bridge', NATIVE_HOST_METADATA_FILE))).toBe(true)
    const extensionManifest = JSON.parse(readFileSync(join(ROOT, 'browser-extension', 'manifest.json'), 'utf8'))
    expect(extensionManifest.version).toBe(BROWSER_EXTENSION_VERSION)
    expect(readFileSync(join(ROOT, 'browser-extension', 'bridge-client.mjs'), 'utf8'))
      .toContain(`BROWSER_EXTENSION_VERSION = '${BROWSER_EXTENSION_VERSION}'`)
  })

  it('template host manifest: only our origin, name matches', () => {
    const raw = JSON.parse(
      readFileSync(join(ROOT, 'resources', 'browser-bridge', 'ru.verstak.browser_bridge.json'), 'utf8'),
    )
    expect(raw.name).toBe(NATIVE_HOST_NAME)
    expect(raw.type).toBe('stdio')
    expect(raw.allowed_origins).toEqual([EXTENSION_ORIGIN])
    expect(raw.allowed_origins[0]).toContain(EXTENSION_ID)
    expect(JSON.stringify(raw)).not.toContain('<all_urls>')
    expect(JSON.stringify(raw)).not.toContain('*://')
  })

  it('package.json Windows extraResources includes host.mjs, host.cmd, host json, browser-extension', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const extras = pkg.build?.win?.extraResources as Array<{ from: string; to: string }>
    expect(Array.isArray(extras)).toBe(true)
    expect(pkg.build?.extraResources).toBeUndefined()
    const tos = extras.map((e) => e.to)
    expect(tos).toContain('browser-bridge/host.mjs')
    expect(tos).toContain('browser-bridge/host.cmd')
    expect(tos).toContain('browser-bridge/ru.verstak.browser_bridge.json')
    expect(tos).toContain(`browser-bridge/${NATIVE_HOST_METADATA_FILE}`)
    expect(tos).toContain('browser-extension')
    // Every "from" path exists
    for (const e of extras) {
      if (e.from.includes('browser-bridge') || e.from.includes('browser-extension') || e.from.includes('host-runtime')) {
        expect(existsSync(join(ROOT, e.from)), `missing extraResource from=${e.from}`).toBe(true)
      }
    }
  })

  it('packaged host.cmd uses ../../Verstak.exe and has no system node fallback', () => {
    const cmd = readFileSync(join(ROOT, 'resources', 'browser-bridge', 'host.cmd'), 'utf8')
    expect(cmd).toMatch(/\.\.\\\.\.\\Verstak\.exe/)
    expect(cmd).not.toMatch(/\bwhere node\b/i)
    expect(cmd).toMatch(/ELECTRON_RUN_AS_NODE=1/)
  })

  it('native host завершается при закрытом desktop pipe, чтобы Chrome создал свежий transport', async () => {
    const isolatedAppData = mkdtempSync(join(tmpdir(), 'verstak-host-closed-appdata-'))
    temps.push(isolatedAppData)
    const missingEndpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\verstak-missing-${process.pid}-${Date.now()}`
      : join(tmpdir(), `verstak-missing-${process.pid}-${Date.now()}.sock`)
    const child = spawn(process.execPath, [join(ROOT, 'electron', 'ai', 'browser', 'bridge', 'host-runtime.mjs')], {
      env: {
        ...process.env,
        APPDATA: isolatedAppData,
        NODE_ENV: 'test',
        VERSTAK_BROWSER_HOST_DEV_ISOLATED: '1',
        VERSTAK_BRIDGE_ENDPOINT: missingEndpoint,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const body = Buffer.from(JSON.stringify({ v: 1, type: 'hello', requestId: 'h1' }), 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32LE(body.length, 0)
    child.stdin.write(Buffer.concat([header, body]))

    const exitCode = await Promise.race([
      new Promise<number | null>(resolveExit => child.once('exit', resolveExit)),
      new Promise<'timeout'>(resolveTimeout => setTimeout(() => resolveTimeout('timeout'), 1500)),
    ])
    if (exitCode === 'timeout') child.kill()
    expect(exitCode).not.toBe('timeout')
  })

  it('ignores an ambient endpoint override outside an explicit isolated test/dev contract', async () => {
    if (process.platform !== 'win32') return
    const endpoint = `\\\\.\\pipe\\verstak-host-ambient-${process.pid}-${Date.now()}`
    const server = createServer(socket => socket.on('data', chunk => socket.write(chunk)))
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(endpoint, resolveListen)
    })

    const hostDir = mkdtempSync(join(tmpdir(), 'verstak-host-ambient-'))
    const isolatedAppData = mkdtempSync(join(tmpdir(), 'verstak-host-appdata-'))
    temps.push(hostDir, isolatedAppData)
    const hostRuntimePath = join(hostDir, 'host-runtime.mjs')
    writeFileSync(hostRuntimePath, readFileSync(join(ROOT, 'electron', 'ai', 'browser', 'bridge', 'host-runtime.mjs')))
    writeFileSync(join(hostDir, NATIVE_HOST_METADATA_FILE), JSON.stringify({
      schemaVersion: 1,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      hostVersion: '2.8.2',
    }), 'utf8')
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      APPDATA: isolatedAppData,
      VERSTAK_BRIDGE_ENDPOINT: endpoint,
    }
    delete childEnv.NODE_ENV
    delete childEnv.VERSTAK_DEV_NATIVE_HOST
    delete childEnv.VERSTAK_DEV_USER_DATA_DIR
    delete childEnv.VERSTAK_BROWSER_HOST_DEV_ISOLATED
    const child = spawn(process.execPath, [hostRuntimePath], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    try {
      const body = Buffer.from(JSON.stringify({ v: 1, type: 'hello', requestId: 'ambient-h1' }), 'utf8')
      const header = Buffer.alloc(4)
      header.writeUInt32LE(body.length, 0)
      child.stdin.write(Buffer.concat([header, body]))
      const response = await Promise.race([
        new Promise<Record<string, unknown>>((resolveFrame, rejectFrame) => {
          let buffered = Buffer.alloc(0)
          child.stdout.on('data', chunk => {
            buffered = Buffer.concat([buffered, Buffer.from(chunk)])
            if (buffered.length < 4) return
            const len = buffered.readUInt32LE(0)
            if (buffered.length < 4 + len) return
            try { resolveFrame(JSON.parse(buffered.subarray(4, 4 + len).toString('utf8'))) }
            catch (error) { rejectFrame(error) }
          })
          child.once('error', rejectFrame)
        }),
        new Promise<'timeout'>(resolveTimeout => setTimeout(() => resolveTimeout('timeout'), 1500)),
      ])
      expect(response).not.toBe('timeout')
      expect(response).toMatchObject({
        type: 'error',
        requestId: 'ambient-h1',
        code: 'desktop_offline',
      })
    } finally {
      try { child.stdin.end() } catch { /* ignore */ }
      if (!child.killed) child.kill()
      await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    }
  })

  it('первый Chrome frame до готовности pipe не теряется и доходит после connect', async () => {
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\verstak-host-queue-${process.pid}-${Date.now()}`
      : join(tmpdir(), `verstak-host-queue-${process.pid}-${Date.now()}.sock`)
    const server = createServer(socket => {
      // host-runtime is a byte-for-byte framed relay; echo proves its initial
      // Chrome frame reached the pipe and returned through stdout.
      socket.on('data', chunk => socket.write(chunk))
    })
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(endpoint, resolveListen)
    })

    const hostDir = mkdtempSync(join(tmpdir(), 'verstak-host-identity-'))
    temps.push(hostDir)
    const hostRuntimePath = join(hostDir, 'host-runtime.mjs')
    writeFileSync(
      hostRuntimePath,
      readFileSync(join(ROOT, 'electron', 'ai', 'browser', 'bridge', 'host-runtime.mjs')),
    )
    writeFileSync(join(hostDir, NATIVE_HOST_METADATA_FILE), JSON.stringify({
      schemaVersion: 1,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      hostVersion: '2.8.2',
    }), 'utf8')

    const child = spawn(process.execPath, [hostRuntimePath], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        VERSTAK_BROWSER_HOST_DEV_ISOLATED: '1',
        VERSTAK_BRIDGE_ENDPOINT: endpoint,
        // Chrome/native hosts inherit ambient env. It must never override the
        // version bound to the installed host bundle metadata.
        VERSTAK_BROWSER_HOST_VERSION: '999.0.0-forged',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    try {
      const body = Buffer.from(JSON.stringify({
        v: 1,
        type: 'hello',
        requestId: 'queued-h1',
        hostVersion: 'forged-by-extension',
      }), 'utf8')
      const header = Buffer.alloc(4)
      header.writeUInt32LE(body.length, 0)
      // Write immediately after spawn: the host may not have emitted pipe connect yet.
      child.stdin.write(Buffer.concat([header, body]))

      const echoed = await Promise.race([
        new Promise<Record<string, unknown>>((resolveFrame, rejectFrame) => {
          let buffered = Buffer.alloc(0)
          child.stdout.on('data', chunk => {
            buffered = Buffer.concat([buffered, Buffer.from(chunk)])
            if (buffered.length < 4) return
            const len = buffered.readUInt32LE(0)
            if (buffered.length < 4 + len) return
            try {
              resolveFrame(JSON.parse(buffered.subarray(4, 4 + len).toString('utf8')))
            } catch (err) {
              rejectFrame(err)
            }
          })
          child.once('error', rejectFrame)
        }),
        new Promise<'timeout'>(resolveTimeout => setTimeout(() => resolveTimeout('timeout'), 1500)),
      ])
      expect(echoed).not.toBe('timeout')
      expect(echoed).toMatchObject({
        type: 'hello',
        requestId: 'queued-h1',
        hostVersion: '2.8.2',
      })
    } finally {
      try { child.stdin.end() } catch { /* ignore */ }
      if (!child.killed) child.kill()
      await new Promise<void>(resolveClose => server.close(() => resolveClose()))
      if (process.platform !== 'win32') {
        try { rmSync(endpoint, { force: true }) } catch { /* ignore */ }
      }
    }
  })
})

describe('buildHostCmdContent', () => {
  it('packaged default: ../../Verstak.exe, no node fallback', () => {
    const cmd = buildHostCmdContent({})
    expect(cmd).toMatch(/\.\.\\\.\.\\Verstak\.exe/)
    expect(cmd).not.toMatch(/\bwhere node\b/)
    expect(cmd).toMatch(/ELECTRON_RUN_AS_NODE=1/)
  })

  it('bakes absolute electron path when provided', () => {
    const cmd = buildHostCmdContent({
      electronExeAbsolute: 'C:\\Apps\\Verstak\\Verstak.exe',
      allowNodeFallback: false,
    })
    expect(cmd).toContain('C:\\Apps\\Verstak\\Verstak.exe')
    expect(cmd).not.toMatch(/\bwhere node\b/)
  })

  it('dev allowNodeFallback includes node path', () => {
    const cmd = buildHostCmdContent({ allowNodeFallback: true })
    expect(cmd).toMatch(/\bwhere node\b/)
  })
})

describe('host manifest validate', () => {
  it('accepts our origin only', () => {
    const m = buildHostManifest('C:\\tmp\\host.cmd')
    const v = validateHostManifest(m)
    expect(v.ok).toBe(true)
  })

  it('rejects wildcard / foreign origin', () => {
    expect(validateHostManifest({
      name: NATIVE_HOST_NAME,
      type: 'stdio',
      path: 'x',
      allowed_origins: ['chrome-extension://other/'],
    }).ok).toBe(false)
    expect(validateHostManifest({
      name: NATIVE_HOST_NAME,
      type: 'stdio',
      path: 'x',
      allowed_origins: ['*://*/*'],
    }).ok).toBe(false)
  })
})

describe.runIf(process.platform === 'win32')('install / repair / uninstall lifecycle', () => {
  it('does not grant another local caller authority through process-global depth', () => {
    if (process.platform !== 'win32') return
    const mutexName = `Local\\Verstak.LeaseTest.${randomUUID()}`
    withNativeHostOwnershipLock(() => {
      expect(() => withNativeHostOwnershipLock(() => 'unsafe nested writer', { mutexName, acquireTimeoutMs: 100 }))
        .toThrow(/mutex.*timeout/i)
    }, { mutexName })
    expect(withNativeHostOwnershipLock(() => 'released', { mutexName })).toBe('released')
  }, 45_000)

  it('holds the OS mutex across the callback and releases it for a competing process', async () => {
    if (process.platform !== 'win32') return
    const root = mkdtempSync(join(tmpdir(), 'verstak-mutex-proof-'))
    temps.push(root)
    const mutexName = `Local\\Verstak.OwnershipTest.${randomUUID()}`
    const attempting = join(root, 'attempting')
    const entered = join(root, 'entered')
    const wait = new Int32Array(new SharedArrayBuffer(4))
    const script = `$ErrorActionPreference = 'Stop'
$root = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(root).toString('base64')}'))
$mutex = [Threading.Mutex]::new($false, '${mutexName}')
$owned = $false
try {
  [IO.File]::WriteAllText((Join-Path $root 'attempting'), 'ATTEMPT')
  try { $owned = $mutex.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) { exit 9 }
  [IO.File]::WriteAllText((Join-Path $root 'entered'), 'ENTERED')
} finally { if ($owned) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
`
    let exited: Promise<void> | undefined
    let result: string | undefined
    try {
      result = withNativeHostOwnershipLock(() => {
      const contender = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' })
      exited = new Promise<void>((resolve, reject) => {
        contender.once('error', reject)
        contender.once('exit', code => code === 0 ? resolve() : reject(new Error(`contender exit ${code}`)))
      })
      const deadline = Date.now() + 15000
      while (!existsSync(attempting) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 20)
      expect(existsSync(attempting)).toBe(true)
      Atomics.wait(wait, 0, 0, 150)
      expect(existsSync(entered)).toBe(false)
      return 'callback completed'
      }, { mutexName, acquireTimeoutMs: 15000 })
    } finally {
      // Registered immediately after spawn; exit cannot race listener setup.
      await exited
    }
    expect(result).toBe('callback completed')
    expect(exited).toBeDefined()
    expect(readFileSync(entered, 'utf8')).toBe('ENTERED')
  }, 45000)

  it('revalidates moved stable ownership inside the transaction before any host write', () => {
    const root = mkdtempSync(join(tmpdir(), 'verstak-host-owner-moved-'))
    temps.push(root)
    const installDir = join(root, 'host')
    const registry = memoryRegistry()
    let locked = false
    registry.withExclusive = work => {
      locked = true
      try { return work() } finally { locked = false }
    }
    registry.verifyStableOwner = vi.fn(() => {
      expect(locked).toBe(true)
      return { ok: false, error: 'InstallLocation moved to successor' }
    })
    registry.write = vi.fn(registry.write)
    const result = installNativeHost({
      installDir,
      electronExeAbsolute: join(root, 'Verstak.exe'),
      hostScriptSource: '// forbidden stale repair',
      versions: versions(),
      registerNativeMessaging: true,
      registry,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('InstallLocation moved')
    expect(registry.verifyStableOwner).toHaveBeenCalledWith(root)
    expect(registry.write).not.toHaveBeenCalled()
    expect(existsSync(installDir)).toBe(false)
  })

  it('fails within a bounded wait without running work when another process holds the mutex', async () => {
    if (process.platform !== 'win32') return
    const root = mkdtempSync(join(tmpdir(), 'verstak-mutex-timeout-'))
    temps.push(root)
    const mutexName = `Local\\Verstak.OwnershipTimeoutTest.${randomUUID()}`
    const ready = join(root, 'ready')
    const release = join(root, 'release')
    const script = `$ErrorActionPreference = 'Stop'
$root = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(root).toString('base64')}'))
$mutex = [Threading.Mutex]::new($false, '${mutexName}')
$owned = $false
try {
  try { $owned = $mutex.WaitOne(5000) } catch [Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) { exit 9 }
  [IO.File]::WriteAllText((Join-Path $root 'ready'), 'READY')
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (-not [IO.File]::Exists((Join-Path $root 'release')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 20 }
} finally { if ($owned) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
`
    const contender = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' })
    const exited = new Promise<void>((resolve, reject) => {
      contender.once('error', reject)
      contender.once('exit', code => code === 0 ? resolve() : reject(new Error(`contender exit ${code}`)))
    })
    const wait = new Int32Array(new SharedArrayBuffer(4))
    const deadline = Date.now() + 15000
    while (!existsSync(ready) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 20)
    const work = vi.fn()
    try {
      expect(existsSync(ready)).toBe(true)
      expect(() => withNativeHostOwnershipLock(work, { mutexName, acquireTimeoutMs: 100 }))
        .toThrow(/mutex.*timeout/i)
      expect(work).not.toHaveBeenCalled()
    } finally {
      writeFileSync(release, 'RELEASE', 'utf8')
      await exited
    }
    expect(withNativeHostOwnershipLock(() => 'available', { mutexName, acquireTimeoutMs: 5000 }))
      .toBe('available')
  }, 45000)

  it('декодирует кириллицу из OEM-вывода reg.exe', () => {
    const prefix = Buffer.from('    (Default)    REG_SZ    C:\\Users\\Pavel\\Progetc\\', 'ascii')
    const cyrillic = Buffer.from('8fe0aea5aae2eb', 'hex') // «Проекты» в CP866
    const suffix = Buffer.from('\\verstak\\host.json\r\n', 'ascii')
    expect(decodeRegistryOutput(Buffer.concat([prefix, cyrillic, suffix])))
      .toContain('C:\\Users\\Pavel\\Progetc\\Проекты\\verstak\\host.json')
  })

  it('install writes assets + optional HKCU + uninstall cleanup', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'verstak-nm-host-'))
    temps.push(installDir)
    const fakeExe = join(installDir, 'FakeVerstak.exe')
    writeFileSync(fakeExe, 'MZ', 'utf8')

    const result = installNativeHost({
      installDir,
      hostScriptSource: '// host test\nconsole.log("ok")\n',
      electronExeAbsolute: fakeExe,
      electronExeRelative: 'FakeVerstak.exe',
      allowNodeFallback: false,
      force: true,
      versions: versions(),
      registerNativeMessaging: true,
    })
    expect(result.ok, result.error).toBe(true)
    expect(existsSync(join(installDir, 'host.cmd'))).toBe(true)
    expect(existsSync(join(installDir, 'host.mjs'))).toBe(true)
    expect(existsSync(join(installDir, `${NATIVE_HOST_NAME}.json`))).toBe(true)
    expect(validateInstalledHostBundle(installDir, versions()).ok).toBe(true)

    const cmd = readFileSync(join(installDir, 'host.cmd'), 'utf8')
    expect(cmd).toContain(fakeExe.replace(/\//g, '\\'))
    expect(cmd).not.toMatch(/\bwhere node\b/)

    const man = readInstalledManifest(result.manifestPath)
    expect(man).toBeTruthy()
    expect(man!.allowed_origins).toEqual([EXTENSION_ORIGIN])
    expect(man!.path.toLowerCase()).toContain('host.cmd')

    // repair: reinstall overwrites
    const result2 = installNativeHost({
      installDir,
      hostScriptSource: '// host repair\n',
      electronExeAbsolute: fakeExe,
      allowNodeFallback: false,
      force: true,
      versions: versions(),
      registerNativeMessaging: true,
    })
    expect(result2.ok, result2.error).toBe(true)
    expect(readFileSync(join(installDir, 'host.mjs'), 'utf8')).toContain('repair')

    if (process.platform === 'win32') {
      const values = readNativeMessagingRegistry()
      const chrome = values[chromeRegistryKey()]
      const edge = values[edgeRegistryKey()]
      expect(chrome, 'chrome registry').toBeTruthy()
      expect(edge, 'edge registry').toBeTruthy()
      expect(chrome!.toLowerCase()).toContain(NATIVE_HOST_NAME.toLowerCase())
    }

    const un = uninstallNativeHost(installDir)
    expect(un.ok).toBe(true)
    expect(existsSync(join(installDir, 'host.cmd'))).toBe(false)
    expect(existsSync(join(installDir, 'host.mjs'))).toBe(false)

    if (process.platform === 'win32') {
      const after = readNativeMessagingRegistry()
      expect(after[chromeRegistryKey()]).toBeNull()
      expect(after[edgeRegistryKey()]).toBeNull()
      expect(registryProcess.spawnSync).toHaveBeenCalled()
      expect(registryProcess.spawnSync.mock.calls.every(([command]) => (
        command === 'reg.exe' || command === 'powershell.exe'
      ))).toBe(true)
    }
  })

  it('packaged smoke stages host assets without touching real Native Messaging registry', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'verstak-nm-smoke-'))
    temps.push(installDir)
    const fakeExe = join(installDir, 'FakeVerstak.exe')
    writeFileSync(fakeExe, 'MZ', 'utf8')

    const previousSmoke = process.env.VERSTAK_SMOKE
    process.env.VERSTAK_SMOKE = '1'
    try {
      const result = installNativeHost({
        installDir,
        hostScriptSource: '// packaged smoke host\n',
        electronExeAbsolute: fakeExe,
        allowNodeFallback: false,
        force: true,
        versions: versions(),
        registerNativeMessaging: false,
      })

      expect(result.ok, result.error).toBe(true)
      expect(result.registryKeys).toEqual([])
      expect(existsSync(join(installDir, 'host.cmd'))).toBe(true)
      expect(existsSync(join(installDir, 'host.mjs'))).toBe(true)
      expect(registryProcess.spawnSync).not.toHaveBeenCalled()
    } finally {
      if (previousSmoke === undefined) delete process.env.VERSTAK_SMOKE
      else process.env.VERSTAK_SMOKE = previousSmoke
    }
  })

  it('sandbox lifecycle: install -> update failure rollback -> update -> uninstall', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'verstak-nm-transaction-'))
    temps.push(installDir)
    const fakeExe = join(installDir, 'FakeVerstak.exe')
    writeFileSync(fakeExe, 'MZ', 'utf8')
    const registryValues = new Map<string, string>()
    const registry = memoryRegistry(registryValues)

    const initial = installNativeHost({
      installDir,
      hostScriptSource: '// host v1\n',
      electronExeAbsolute: fakeExe,
      allowNodeFallback: false,
      force: true,
      versions: versions('1.0.0'),
      registerNativeMessaging: true,
      registry,
    })
    expect(initial.ok, initial.error).toBe(true)
    const initialManifest = readFileSync(initial.manifestPath)
    const initialMetadata = readFileSync(initial.metadataPath)
    const initialRegistry = new Map(registryValues)

    const failedUpdate = installNativeHost({
      installDir,
      hostScriptSource: '// host broken update\n',
      electronExeAbsolute: fakeExe,
      allowNodeFallback: false,
      force: true,
      versions: versions('2.0.0'),
      registerNativeMessaging: true,
      registry: memoryRegistry(registryValues, true),
    })
    expect(failedUpdate).toMatchObject({ ok: false, rolledBack: true })
    expect(readFileSync(initial.manifestPath)).toEqual(initialManifest)
    expect(readFileSync(initial.metadataPath)).toEqual(initialMetadata)
    expect(readFileSync(join(installDir, 'host.mjs'), 'utf8')).toBe('// host v1\n')
    expect(registryValues).toEqual(initialRegistry)
    expect(validateInstalledHostBundle(installDir, versions('1.0.0')).ok).toBe(true)

    const updated = installNativeHost({
      installDir,
      hostScriptSource: '// host v2\n',
      electronExeAbsolute: fakeExe,
      allowNodeFallback: false,
      force: true,
      versions: versions('2.0.0'),
      registerNativeMessaging: true,
      registry,
    })
    expect(updated.ok, updated.error).toBe(true)
    expect(validateInstalledHostBundle(installDir, versions('2.0.0')).ok).toBe(true)

    expect(uninstallNativeHost(installDir, registry)).toEqual({ ok: true })
    expect(registryValues.size).toBe(0)
    expect(existsSync(updated.hostLauncherPath)).toBe(false)
    expect(existsSync(updated.metadataPath)).toBe(false)
  })

  it('an old uninstall cannot delete registry ownership of a successor install', () => {
    const oldDir = mkdtempSync(join(tmpdir(), 'verstak-nm-old-'))
    temps.push(oldDir)
    const successorDir = mkdtempSync(join(tmpdir(), 'verstak-nm-successor-'))
    temps.push(successorDir)
    const successorManifest = join(successorDir, `${NATIVE_HOST_NAME}.json`)
    writeFileSync(successorManifest, '{}', 'utf8')
    registryProcess.values.set(chromeRegistryKey(), successorManifest)
    registryProcess.values.set(edgeRegistryKey(), successorManifest)

    expect(uninstallNativeHost(oldDir).ok).toBe(true)
    expect(registryProcess.values.get(chromeRegistryKey())).toBe(successorManifest)
    expect(registryProcess.values.get(edgeRegistryKey())).toBe(successorManifest)
  })

  it('unknown registry ownership is fail-closed and never deleted', () => {
    const expectedManifest = 'C:\\Program Files\\Verstak\\resources\\browser-bridge\\ru.verstak.browser_bridge.json'

    expect(removeNativeMessagingRegistry(expectedManifest)).toEqual({ ok: true })

    const deletes = registryProcess.spawnSync.mock.calls.filter(([, args]) => args?.[0] === 'delete')
    expect(deletes).toEqual([])
  })

  it('reports a failed delete of an owned registry key', () => {
    const expectedManifest = 'C:\\Program Files\\Verstak\\resources\\browser-bridge\\ru.verstak.browser_bridge.json'
    registryProcess.values.set(chromeRegistryKey(), expectedManifest)
    registryProcess.values.set(edgeRegistryKey(), expectedManifest)
    registryProcess.deleteFailures.add(edgeRegistryKey())

    const result = removeNativeMessagingRegistry(expectedManifest)

    expect(result.ok).toBe(false)
    expect(result.error).toContain(edgeRegistryKey())
    expect(result.error).toContain('Access is denied.')
    // Chrome was deleted before Edge failed, then restored transactionally.
    expect(registryProcess.values.get(chromeRegistryKey())).toBe(expectedManifest)
    expect(registryProcess.values.get(edgeRegistryKey())).toBe(expectedManifest)
    const scripts = registryProcess.spawnSync.mock.calls.map(([command, args]) => {
      if (command !== 'powershell.exe') return `${args?.[0]}:${args?.[1]}`
      const encodedIndex = args?.indexOf('-EncodedCommand') ?? -1
      return encodedIndex >= 0
        ? Buffer.from(String(args?.[encodedIndex + 1] || ''), 'base64').toString('utf16le')
        : ''
    })
    const firstDelete = scripts.findIndex(script => script.includes('VERSTAK_DELETE_IF_MATCH_V1'))
    expect(scripts.filter(script => script.includes('VERSTAK_QUERY_DEFAULT_V1')).length).toBeGreaterThanOrEqual(2)
    expect(firstDelete).toBeGreaterThan(1)
    expect(scripts.some(script => (
      script.includes('VERSTAK_RESTORE_IF_UNCHANGED_V2')
      && script.includes(Buffer.from(chromeRegistryKey().slice('HKCU\\'.length), 'utf8').toString('base64'))
    ))).toBe(true)
    const restoreScript = scripts.find(script => script.includes('VERSTAK_RESTORE_IF_UNCHANGED_V2')) ?? ''
    expect(restoreScript).toContain('$currentKey.SetValue')
    expect(restoreScript).toContain('$currentKey.Flush()')
    expect(restoreScript).toContain('$restored = $currentKey.GetValue')
  })

  it('system rollback CAS preserves a successor that claims a deleted key', () => {
    const expectedManifest = 'C:\\Program Files\\Verstak-old\\resources\\browser-bridge\\ru.verstak.browser_bridge.json'
    const successorManifest = 'C:\\Program Files\\Verstak-new\\resources\\browser-bridge\\ru.verstak.browser_bridge.json'
    registryProcess.values.set(chromeRegistryKey(), expectedManifest)
    registryProcess.values.set(edgeRegistryKey(), expectedManifest)
    registryProcess.deleteFailures.add(edgeRegistryKey())
    registryProcess.replaceBeforeRestore.set(chromeRegistryKey(), successorManifest)

    const result = removeNativeMessagingRegistry(expectedManifest)

    expect(result.ok).toBe(false)
    expect(registryProcess.values.get(chromeRegistryKey())).toBe(successorManifest)
    expect(registryProcess.values.get(edgeRegistryKey())).toBe(expectedManifest)
  })

  it('does not collapse reg.exe status 1 with an error into registry absence', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'verstak-nm-query-status-one-'))
    temps.push(installDir)
    registryProcess.queryStatusOneFailures.add(chromeRegistryKey())

    const result = installNativeHost({
      installDir,
      hostScriptSource: '// query status one must fail closed\n',
      electronExeAbsolute: join(installDir, 'Verstak.exe'),
      versions: versions(),
      registerNativeMessaging: true,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Invalid syntax|snapshot|query/i)
    expect(registryProcess.spawnSync.mock.calls.some(([, args]) => args?.[0] === 'add')).toBe(false)
  })

  it('uninstall leaves host files intact when registry ownership removal fails', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'verstak-nm-uninstall-reg-fail-'))
    temps.push(installDir)
    const launcher = join(installDir, 'host.cmd')
    writeFileSync(launcher, '@echo off\n', 'utf8')
    const registry: NativeMessagingRegistryAdapter = {
      ...memoryRegistry(),
      remove: () => ({ ok: false, error: 'registry removal failed' }),
    }

    expect(uninstallNativeHost(installDir, registry)).toEqual({
      ok: false,
      error: 'registry removal failed',
    })
    expect(existsSync(launcher)).toBe(true)
  })

  it('file cleanup failure restores the exact registry and file snapshots', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'verstak-nm-uninstall-file-fail-'))
    temps.push(installDir)
    const manifestPath = join(installDir, `${NATIVE_HOST_NAME}.json`)
    const tracked = [
      ['host.cmd', '@echo off\r\n'],
      ['host.mjs', '// host\n'],
      [`${NATIVE_HOST_NAME}.json`, '{}\n'],
      [NATIVE_HOST_METADATA_FILE, '{"schemaVersion":1}\n'],
    ] as const
    for (const [name, contents] of tracked) writeFileSync(join(installDir, name), contents, 'utf8')
    const registryValues = new Map([
      [chromeRegistryKey(), manifestPath],
      [edgeRegistryKey(), manifestPath],
    ])
    const registry = memoryRegistry(registryValues)

    const result = uninstallNativeHost(installDir, registry, {
      removeFile(path: string) {
        if (path.endsWith('host.mjs')) throw new Error('injected file delete failure')
        rmSync(path, { force: true })
      },
    })

    expect(result).toMatchObject({ ok: false, rolledBack: true })
    expect(result.error).toMatch(/file cleanup failed.*rollback completed/i)
    expect(registryValues).toEqual(new Map([
      [chromeRegistryKey(), manifestPath],
      [edgeRegistryKey(), manifestPath],
    ]))
    for (const [name, contents] of tracked) {
      expect(readFileSync(join(installDir, name), 'utf8')).toBe(contents)
    }
  })

  it('file cleanup rollback uses CAS and never overwrites a successor owner', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'verstak-nm-uninstall-successor-'))
    temps.push(installDir)
    const manifestPath = join(installDir, `${NATIVE_HOST_NAME}.json`)
    for (const name of ['host.cmd', 'host.mjs', `${NATIVE_HOST_NAME}.json`, NATIVE_HOST_METADATA_FILE]) {
      writeFileSync(join(installDir, name), name, 'utf8')
    }
    const successor = 'C:\\Program Files\\Verstak-new\\resources\\browser-bridge\\ru.verstak.browser_bridge.json'
    const registryValues = new Map([
      [chromeRegistryKey(), manifestPath],
      [edgeRegistryKey(), manifestPath],
    ])
    const registry = memoryRegistry(registryValues)

    const result = uninstallNativeHost(installDir, registry, {
      removeFile(path: string) {
        if (path.endsWith('host.mjs')) {
          registryValues.set(chromeRegistryKey(), successor)
          throw new Error('injected file delete failure after successor claim')
        }
        rmSync(path, { force: true })
      },
    })

    expect(result).toMatchObject({ ok: false, rolledBack: true })
    expect(registryValues.get(chromeRegistryKey())).toBe(successor)
    expect(registryValues.get(edgeRegistryKey())).toBe(manifestPath)
  })

  it('reports a failed registry rollback honestly after file cleanup failure', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'verstak-nm-uninstall-rollback-fail-'))
    temps.push(installDir)
    const manifestPath = join(installDir, `${NATIVE_HOST_NAME}.json`)
    writeFileSync(join(installDir, 'host.cmd'), '@echo off\n', 'utf8')
    const baseRegistry = memoryRegistry(new Map([
      [chromeRegistryKey(), manifestPath],
      [edgeRegistryKey(), manifestPath],
    ]))
    const registry: NativeMessagingRegistryAdapter = {
      ...baseRegistry,
      restore: () => ({ ok: false, error: 'injected registry rollback failure' }),
    }

    const result = uninstallNativeHost(installDir, registry, {
      removeFile() { throw new Error('injected file delete failure') },
    })

    expect(result).toMatchObject({ ok: false, rolledBack: false })
    expect(result.error).toMatch(/file cleanup failed.*rollback.*registry rollback failure/i)
  })

  it('compare-before-delete preserves a successor that appears after preflight', () => {
    const oldManifest = 'C:\\Program Files\\Verstak-old\\resources\\browser-bridge\\ru.verstak.browser_bridge.json'
    const successorManifest = 'C:\\Program Files\\Verstak-new\\resources\\browser-bridge\\ru.verstak.browser_bridge.json'
    registryProcess.values.set(chromeRegistryKey(), oldManifest)
    registryProcess.values.set(edgeRegistryKey(), oldManifest)
    registryProcess.replaceBeforeDelete.set(chromeRegistryKey(), successorManifest)

    const result = removeNativeMessagingRegistry(oldManifest)

    expect(result.ok, result.error).toBe(true)
    expect(registryProcess.values.get(chromeRegistryKey())).toBe(successorManifest)
    expect(registryProcess.values.has(edgeRegistryKey())).toBe(false)
  })

  it('fails before registry write when the pre-install snapshot is unreadable', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'verstak-nm-snapshot-error-'))
    temps.push(installDir)
    registryProcess.queryFailures.add(chromeRegistryKey())

    const result = installNativeHost({
      installDir,
      hostScriptSource: '// snapshot must fail before writes\n',
      electronExeAbsolute: join(installDir, 'Verstak.exe'),
      versions: versions(),
      registerNativeMessaging: true,
    })

    expect(result).toMatchObject({ ok: false, rolledBack: true })
    expect(result.error).toMatch(/snapshot|query|Access is denied/i)
    const adds = registryProcess.spawnSync.mock.calls.filter(([, args]) => args?.[0] === 'add')
    expect(adds).toEqual([])
  })

  it('reports rollback failure when an absent snapshot cannot remove a partially written key', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'verstak-nm-rollback-error-'))
    temps.push(installDir)
    registryProcess.addFailures.add(edgeRegistryKey())
    registryProcess.deleteFailures.add(chromeRegistryKey())

    const result = installNativeHost({
      installDir,
      hostScriptSource: '// partial registry write\n',
      electronExeAbsolute: join(installDir, 'Verstak.exe'),
      versions: versions(),
      registerNativeMessaging: true,
    })

    expect(result).toMatchObject({ ok: false, rolledBack: false })
    expect(result.error).toMatch(/rollback.*Chrome|Chrome.*rollback/i)
    expect(registryProcess.values.has(chromeRegistryKey())).toBe(true)
  })
})
