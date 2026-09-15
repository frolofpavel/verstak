import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// @ts-expect-error Runtime release checker is intentionally plain ESM.
import * as packageCheckerModule from '../../scripts/check-browser-bridge-package.mjs'

const packageChecker = packageCheckerModule as unknown as {
  checkBrowserBridgePackage: (input: { root: string; sourceDir: string }) => {
    ok: boolean
    failures: string[]
    evidence: Record<string, unknown>
  }
  deriveChromeExtensionId?: (publicKeyB64: string) => string
  decideBrowserPackageGate?: (input: {
    haveSetup: boolean
    payloadTreeDir: string | null
    smokeUnpacked: string
  }) => { kind: 'run'; sourceDir: string } | { kind: 'fail' | 'skip'; reason: string }
}
const { checkBrowserBridgePackage } = packageChecker

const ROOT = process.cwd()
const temps: string[] = []

function copyFile(sourceRoot: string, fixtureRoot: string, relativePath: string): void {
  const destination = join(fixtureRoot, relativePath)
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(join(sourceRoot, relativePath), destination)
}

function sourceRootFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'verstak-browser-source-'))
  temps.push(root)
  for (const relativePath of [
    'package.json',
    'electron/ai/browser/bridge/constants.ts',
    'electron/ai/browser/bridge/server.ts',
    'electron/ai/browser/bridge/host-runtime.mjs',
  ]) copyFile(ROOT, root, relativePath)
  cpSync(join(ROOT, 'browser-extension'), join(root, 'browser-extension'), { recursive: true })
  cpSync(join(ROOT, 'resources', 'browser-bridge'), join(root, 'resources', 'browser-bridge'), { recursive: true })
  return root
}

function packagedFixture(root = ROOT): string {
  const sourceDir = mkdtempSync(join(tmpdir(), 'verstak-browser-package-'))
  temps.push(sourceDir)
  const resources = join(sourceDir, 'resources')
  const hostDir = join(resources, 'browser-bridge')
  mkdirSync(hostDir, { recursive: true })
  writeFileSync(join(sourceDir, 'Verstak.exe'), 'MZ-fixture')
  cpSync(join(root, 'electron', 'ai', 'browser', 'bridge', 'host-runtime.mjs'), join(hostDir, 'host.mjs'))
  for (const name of ['host.cmd', 'host-metadata.json', 'ru.verstak.browser_bridge.json']) {
    cpSync(join(root, 'resources', 'browser-bridge', name), join(hostDir, name))
  }
  cpSync(join(root, 'browser-extension'), join(resources, 'browser-extension'), { recursive: true })
  rmSync(join(resources, 'browser-extension', 'README.md'), { force: true })
  return sourceDir
}

function rewriteMetadataHash(sourceDir: string, fileName: string): void {
  const hostDir = join(sourceDir, 'resources', 'browser-bridge')
  const metadataPath = join(hostDir, 'host-metadata.json')
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
  metadata.files[fileName] = createHash('sha256').update(readFileSync(join(hostDir, fileName))).digest('hex')
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Browser Employee packaged artifact checker', () => {
  it('pins exact host bytes, manifest, hashes and version triplet', () => {
    const result = checkBrowserBridgePackage({ root: ROOT, sourceDir: packagedFixture() })
    expect(result.ok, result.failures.join('; ')).toBe(true)
    expect(result.evidence).toMatchObject({
      versionTriplet: {
        protocolVersion: 1,
        appVersion: '2.8.2',
        extensionVersion: '0.2.0',
        hostVersion: '2.8.2',
      },
    })
  })

  it('fails when one packaged extension byte differs from reviewed source', () => {
    const sourceDir = packagedFixture()
    const background = join(sourceDir, 'resources', 'browser-extension', 'background.mjs')
    writeFileSync(background, `${readFileSync(background, 'utf8')}\n// injected drift\n`)
    const result = checkBrowserBridgePackage({ root: ROOT, sourceDir })
    expect(result.ok).toBe(false)
    expect(result.failures).toContain('browser-extension/background.mjs differs from reviewed source')
  })

  it('fails closed for missing and tampered native host files', () => {
    const missingSource = packagedFixture()
    rmSync(join(missingSource, 'resources', 'browser-bridge', 'host.mjs'))
    const missing = checkBrowserBridgePackage({ root: ROOT, sourceDir: missingSource })
    expect(missing.ok).toBe(false)
    expect(missing.failures).toContain('host.mjs missing')
    expect(missing.failures).toContain('packaged host protocol constant mismatch')

    const tamperedSource = packagedFixture()
    const host = join(tamperedSource, 'resources', 'browser-bridge', 'host.mjs')
    writeFileSync(host, readFileSync(host, 'utf8').replace(
      'const BRIDGE_PROTOCOL_VERSION = 1',
      'const BRIDGE_PROTOCOL_VERSION = 2',
    ))
    const tampered = checkBrowserBridgePackage({ root: ROOT, sourceDir: tamperedSource })
    expect(tampered.ok).toBe(false)
    expect(tampered.failures).toContain('packaged host protocol constant mismatch')
    expect(tampered.failures).toContain('host.mjs differs from reviewed source')
    expect(tampered.failures).toContain('host.mjs metadata hash mismatch')
  })

  it('fails when packaged client runtime or host metadata hash drifts', () => {
    const clientSource = packagedFixture()
    const client = join(clientSource, 'resources', 'browser-extension', 'bridge-client.mjs')
    writeFileSync(client, readFileSync(client, 'utf8').replace(
      "BROWSER_EXTENSION_VERSION = '0.2.0'",
      "BROWSER_EXTENSION_VERSION = '0.2.1'",
    ))
    const clientResult = checkBrowserBridgePackage({ root: ROOT, sourceDir: clientSource })
    expect(clientResult.ok).toBe(false)
    expect(clientResult.failures).toContain('packaged extension version constant mismatch')

    const metadataSource = packagedFixture()
    const metadataPath = join(metadataSource, 'resources', 'browser-bridge', 'host-metadata.json')
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
    metadata.files['host.cmd'] = '0'.repeat(64)
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
    const metadataResult = checkBrowserBridgePackage({ root: ROOT, sourceDir: metadataSource })
    expect(metadataResult.ok).toBe(false)
    expect(metadataResult.failures).toContain('host.cmd metadata hash mismatch')
  })

  it('derives the stable Chrome id from manifest.key and binds it to desktop identity', () => {
    expect(packageChecker.deriveChromeExtensionId).toBeTypeOf('function')
    const manifest = JSON.parse(readFileSync(join(ROOT, 'browser-extension', 'manifest.json'), 'utf8'))
    expect(packageChecker.deriveChromeExtensionId?.(manifest.key)).toBe('jbhddmgcngdchlgmilphmbbcccfigadb')

    const root = sourceRootFixture()
    const sourceDir = packagedFixture(root)
    const replacementKey = Buffer.from('production-shaped-public-key-mutation').toString('base64')
    for (const manifestPath of [
      join(root, 'browser-extension', 'manifest.json'),
      join(sourceDir, 'resources', 'browser-extension', 'manifest.json'),
    ]) {
      const changed = JSON.parse(readFileSync(manifestPath, 'utf8'))
      changed.key = replacementKey
      writeFileSync(manifestPath, JSON.stringify(changed, null, 2), 'utf8')
    }

    const result = checkBrowserBridgePackage({ root, sourceDir })
    expect(result.ok).toBe(false)
    expect(result.failures).toContain('manifest.key does not match desktop extension public key')
  })

  it('binds the extension runtime to the exact stable Native Host name', () => {
    const root = sourceRootFixture()
    const sourceDir = packagedFixture(root)
    for (const clientPath of [
      join(root, 'browser-extension', 'bridge-client.mjs'),
      join(sourceDir, 'resources', 'browser-extension', 'bridge-client.mjs'),
    ]) {
      writeFileSync(clientPath, readFileSync(clientPath, 'utf8').replace(
        "NATIVE_HOST_NAME = 'ru.verstak.browser_bridge'",
        "NATIVE_HOST_NAME = 'ru.verstak.missing_host'",
      ), 'utf8')
    }

    const result = checkBrowserBridgePackage({ root, sourceDir })
    expect(result.ok).toBe(false)
    expect(result.failures).toContain('source extension native host name mismatch')
  })

  it('rejects a byte-matched launcher that no longer executes host.mjs', () => {
    const root = sourceRootFixture()
    const sourceDir = packagedFixture(root)
    for (const launcherPath of [
      join(root, 'resources', 'browser-bridge', 'host.cmd'),
      join(sourceDir, 'resources', 'browser-bridge', 'host.cmd'),
    ]) {
      writeFileSync(launcherPath, readFileSync(launcherPath, 'utf8').replace(
        '"%ELECTRON_EXE%" "%HOST_JS%"',
        '"%ELECTRON_EXE%" "%HOST_JS%.missing"',
      ), 'utf8')
    }
    rewriteMetadataHash(sourceDir, 'host.cmd')

    const result = checkBrowserBridgePackage({ root, sourceDir })
    expect(result.ok).toBe(false)
    expect(result.failures).toContain('packaged host.cmd must execute exact host.mjs through Verstak.exe')
  })

  it('does not accept handshake guards that survive only inside comments', () => {
    const root = sourceRootFixture()
    const sourceDir = packagedFixture(root)
    const serverPath = join(root, 'electron', 'ai', 'browser', 'bridge', 'server.ts')
    const changed = readFileSync(serverPath, 'utf8')
      .replace(
        'msg.extensionVersion !== BROWSER_EXTENSION_VERSION',
        'false /* msg.extensionVersion !== BROWSER_EXTENSION_VERSION */',
      )
      .replace(
        'msg.hostVersion !== deps.appVersion',
        'false /* msg.hostVersion !== deps.appVersion */',
      )
    writeFileSync(serverPath, changed, 'utf8')

    const result = checkBrowserBridgePackage({ root, sourceDir })
    expect(result.ok).toBe(false)
    expect(result.failures).toContain('desktop server version handshake guard missing')
  })

  it('makes a built Setup fail closed when its verified payload tree is unavailable', () => {
    expect(packageChecker.decideBrowserPackageGate).toBeTypeOf('function')
    const unpacked = packagedFixture()
    expect(packageChecker.decideBrowserPackageGate?.({
      haveSetup: true,
      payloadTreeDir: null,
      smokeUnpacked: unpacked,
    })).toEqual({
      kind: 'fail',
      reason: 'Setup.exe exists but its verified payload tree is unavailable',
    })
    expect(packageChecker.decideBrowserPackageGate?.({
      haveSetup: false,
      payloadTreeDir: null,
      smokeUnpacked: unpacked,
    })).toEqual({ kind: 'run', sourceDir: unpacked })
  })

  it('wires the fail-closed artifact decision into the real release gate', () => {
    const releaseGate = readFileSync(join(ROOT, 'scripts', 'release-gate.mjs'), 'utf8')
    expect(releaseGate).toMatch(/import\s*\{\s*decideBrowserPackageGate\s*\}/)
    expect(releaseGate).toContain('const browserPackageDecision = decideBrowserPackageGate({')
    expect(releaseGate).not.toContain('Browser Employee package check пропущен: нет дерева артефакта')
  })
})
