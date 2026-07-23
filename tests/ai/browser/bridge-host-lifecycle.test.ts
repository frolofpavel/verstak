// bridge-host-lifecycle.test.ts — packaged assets + registry lifecycle (EXT-B1).

import { describe, it, expect, afterEach } from 'vitest'
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
import {
  buildHostCmdContent,
  buildHostManifest,
  validateHostManifest,
  installNativeHost,
  uninstallNativeHost,
  readInstalledManifest,
  readNativeMessagingRegistry,
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
  // Always cleanup registry keys we may have written (safe HKCU only).
  try { uninstallNativeHost() } catch { /* ignore */ }
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
    }
  })
})
