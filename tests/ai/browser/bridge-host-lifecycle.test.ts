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
import { createServer } from 'node:net'

const registryProcess = vi.hoisted(() => {
  const values = new Map<string, string>()
  const spawnSync = vi.fn((command: string, args: readonly string[] = [], options?: { encoding?: string }) => {
    if (command !== 'reg.exe') {
      throw new Error(`unexpected process in registry unit adapter: ${command}`)
    }
    const operation = args[0]
    const key = args[1]
    if (operation === 'add' && key) {
      const valueIndex = args.indexOf('/d')
      values.set(key, valueIndex >= 0 ? String(args[valueIndex + 1] || '') : '')
      return { status: 0, stdout: '', stderr: '' }
    }
    if (operation === 'query' && key) {
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
      values.delete(key)
      return { status: 0, stdout: '', stderr: '' }
    }
    return { status: 1, stdout: '', stderr: 'unsupported reg.exe test invocation' }
  })
  return { values, spawnSync }
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
  readInstalledManifest,
  readNativeMessagingRegistry,
  decodeRegistryOutput,
  chromeRegistryKey,
  edgeRegistryKey,
  NATIVE_HOST_NAME,
  EXTENSION_ORIGIN,
  EXTENSION_ID,
} from '../../../electron/ai/browser/bridge'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')

const temps: string[] = []
afterEach(() => {
  // Registry lifecycle is fully in-memory in this unit suite. Never delete a
  // user's installed NativeMessagingHosts while running ordinary tests.
  registryProcess.values.clear()
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

  it('package.json extraResources includes host.mjs, host.cmd, host json, browser-extension', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const extras = pkg.build?.extraResources as Array<{ from: string; to: string }>
    expect(Array.isArray(extras)).toBe(true)
    const tos = extras.map((e) => e.to)
    expect(tos).toContain('browser-bridge/host.mjs')
    expect(tos).toContain('browser-bridge/host.cmd')
    expect(tos).toContain('browser-bridge/ru.verstak.browser_bridge.json')
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
    const missingEndpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\verstak-missing-${process.pid}-${Date.now()}`
      : join(tmpdir(), `verstak-missing-${process.pid}-${Date.now()}.sock`)
    const child = spawn(process.execPath, [join(ROOT, 'electron', 'ai', 'browser', 'bridge', 'host-runtime.mjs')], {
      env: { ...process.env, VERSTAK_BRIDGE_ENDPOINT: missingEndpoint },
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

    const child = spawn(process.execPath, [join(ROOT, 'electron', 'ai', 'browser', 'bridge', 'host-runtime.mjs')], {
      env: { ...process.env, VERSTAK_BRIDGE_ENDPOINT: endpoint },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    try {
      const body = Buffer.from(JSON.stringify({ v: 1, type: 'hello', requestId: 'queued-h1' }), 'utf8')
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
      expect(echoed).toMatchObject({ type: 'hello', requestId: 'queued-h1' })
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

describe('install / repair / uninstall lifecycle', () => {
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
    })
    expect(result.ok, result.error).toBe(true)
    expect(existsSync(join(installDir, 'host.cmd'))).toBe(true)
    expect(existsSync(join(installDir, 'host.mjs'))).toBe(true)
    expect(existsSync(join(installDir, `${NATIVE_HOST_NAME}.json`))).toBe(true)

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
      expect(registryProcess.spawnSync.mock.calls.every(([command]) => command === 'reg.exe')).toBe(true)
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
})
