#!/usr/bin/env node
// Fail-closed Browser Employee package inspection. Reads only the isolated
// artifact tree; never opens or changes HKCU and never reads browser state.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

// These are release identities, not convenient lookup defaults. A deliberate
// migration must update every producer/consumer and this fail-closed contract.
const RELEASE_NATIVE_HOST_NAME = 'ru.verstak.browser_bridge'
const RELEASE_HOST_METADATA_FILE = 'host-metadata.json'

const sha256 = value => createHash('sha256').update(value).digest('hex')
const normalized = value => String(value).replace(/\\/g, '/')

function numericConstant(source, name) {
  const match = source.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*(\\d+)`))
  return match ? Number(match[1]) : null
}

function stringConstant(source, name) {
  const match = source.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*['\"]([^'\"]+)['\"]`))
  return match?.[1] ?? null
}

function extensionOriginConstant(source, extensionId) {
  const match = source.match(/(?:export\s+)?const\s+EXTENSION_ORIGIN\s*=\s*`([^`]+)`/)
  if (!match || match[1] !== 'chrome-extension://${EXTENSION_ID}/') return null
  return `chrome-extension://${extensionId}/`
}

function codeWithoutCommentsOrStrings(source) {
  let output = ''
  let state = 'code'
  let quote = ''
  for (let i = 0; i < source.length; i += 1) {
    const current = source[i]
    const next = source[i + 1]
    if (state === 'line-comment') {
      if (current === '\n') {
        state = 'code'
        output += '\n'
      } else output += ' '
      continue
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        output += '  '
        i += 1
        state = 'code'
      } else output += current === '\n' ? '\n' : ' '
      continue
    }
    if (state === 'string') {
      if (current === '\\') {
        output += ' '
        if (i + 1 < source.length) {
          output += source[i + 1] === '\n' ? '\n' : ' '
          i += 1
        }
      } else if (current === quote) {
        output += ' '
        state = 'code'
      } else output += current === '\n' ? '\n' : ' '
      continue
    }
    if (current === '/' && next === '/') {
      output += '  '
      i += 1
      state = 'line-comment'
    } else if (current === '/' && next === '*') {
      output += '  '
      i += 1
      state = 'block-comment'
    } else if (current === "'" || current === '"' || current === '`') {
      output += ' '
      state = 'string'
      quote = current
    } else output += current
  }
  return output
}

export function deriveChromeExtensionId(publicKeyB64) {
  if (typeof publicKeyB64 !== 'string' || !publicKeyB64.trim()) {
    throw new Error('manifest.key missing')
  }
  const compact = publicKeyB64.replace(/\s+/g, '')
  const keyBytes = Buffer.from(compact, 'base64')
  if (!keyBytes.length || keyBytes.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) {
    throw new Error('manifest.key is not canonical base64')
  }
  const digest = createHash('sha256').update(keyBytes).digest()
  const alphabet = 'abcdefghijklmnop'
  let id = ''
  for (const byte of digest.subarray(0, 16)) {
    id += alphabet[(byte >> 4) & 0x0f]
    id += alphabet[byte & 0x0f]
  }
  return id
}

export function decideBrowserPackageGate({ haveSetup, payloadTreeDir, smokeUnpacked }) {
  if (payloadTreeDir && existsSync(join(payloadTreeDir, 'Verstak.exe'))) {
    return { kind: 'run', sourceDir: payloadTreeDir }
  }
  if (haveSetup) {
    return { kind: 'fail', reason: 'Setup.exe exists but its verified payload tree is unavailable' }
  }
  if (existsSync(join(smokeUnpacked, 'Verstak.exe'))) {
    return { kind: 'run', sourceDir: smokeUnpacked }
  }
  return { kind: 'skip', reason: 'Setup.exe is not built and release/win-unpacked is unavailable' }
}

function walk(root, dir = root) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(root, absolute))
    else if (entry.isFile()) out.push(normalized(relative(root, absolute)))
  }
  return out.sort()
}

export function checkBrowserBridgePackage({ root, sourceDir }) {
  const failures = []
  const evidence = {}
  const fail = message => failures.push(message)
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const sourceExtensionDir = join(root, 'browser-extension')
  const packagedResources = join(sourceDir, 'resources')
  const packagedHostDir = join(packagedResources, 'browser-bridge')
  const packagedExtensionDir = join(packagedResources, 'browser-extension')
  const exe = join(sourceDir, 'Verstak.exe')
  const desktopConstants = readFileSync(join(root, 'electron', 'ai', 'browser', 'bridge', 'constants.ts'), 'utf8')
  const desktopExtensionId = stringConstant(desktopConstants, 'EXTENSION_ID')
  const desktopExtensionPublicKey = stringConstant(desktopConstants, 'EXTENSION_PUBLIC_KEY_B64')
  const desktopHostName = stringConstant(desktopConstants, 'NATIVE_HOST_NAME')
  const desktopMetadataFile = stringConstant(desktopConstants, 'NATIVE_HOST_METADATA_FILE')
  const hostNameForPaths = desktopHostName || RELEASE_NATIVE_HOST_NAME
  const metadataFileForPaths = desktopMetadataFile || RELEASE_HOST_METADATA_FILE

  if (!existsSync(exe)) fail('Verstak.exe missing')
  else evidence.exeSha256 = sha256(readFileSync(exe))

  const metadataPath = join(packagedHostDir, metadataFileForPaths)
  const extensionManifestPath = join(packagedExtensionDir, 'manifest.json')
  if (!existsSync(metadataPath)) fail(`${metadataFileForPaths} missing`)
  if (!existsSync(extensionManifestPath)) fail('browser-extension/manifest.json missing')
  if (failures.length) return { ok: false, failures, evidence }

  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
  const extensionManifest = JSON.parse(readFileSync(extensionManifestPath, 'utf8'))
  const sourceExtensionManifest = JSON.parse(readFileSync(join(sourceExtensionDir, 'manifest.json'), 'utf8'))
  const serverSource = readFileSync(join(root, 'electron', 'ai', 'browser', 'bridge', 'server.ts'), 'utf8')
  const sourceClient = readFileSync(join(sourceExtensionDir, 'bridge-client.mjs'), 'utf8')
  const packagedClientPath = join(packagedExtensionDir, 'bridge-client.mjs')
  const packagedClient = existsSync(packagedClientPath) ? readFileSync(packagedClientPath, 'utf8') : ''
  const sourceHostRuntime = readFileSync(join(root, 'electron', 'ai', 'browser', 'bridge', 'host-runtime.mjs'), 'utf8')
  const packagedHostRuntimePath = join(packagedHostDir, 'host.mjs')
  const packagedHostRuntime = existsSync(packagedHostRuntimePath) ? readFileSync(packagedHostRuntimePath, 'utf8') : ''
  const desktopProtocolVersion = numericConstant(desktopConstants, 'BRIDGE_PROTOCOL_VERSION')
  const desktopExtensionVersion = stringConstant(desktopConstants, 'BROWSER_EXTENSION_VERSION')
  const sourceClientProtocolVersion = numericConstant(sourceClient, 'BRIDGE_PROTOCOL_VERSION')
  const sourceClientExtensionVersion = stringConstant(sourceClient, 'BROWSER_EXTENSION_VERSION')
  const packagedClientProtocolVersion = numericConstant(packagedClient, 'BRIDGE_PROTOCOL_VERSION')
  const packagedClientExtensionVersion = stringConstant(packagedClient, 'BROWSER_EXTENSION_VERSION')
  const sourceHostProtocolVersion = numericConstant(sourceHostRuntime, 'BRIDGE_PROTOCOL_VERSION')
  const packagedHostProtocolVersion = numericConstant(packagedHostRuntime, 'BRIDGE_PROTOCOL_VERSION')
  const sourceClientHostName = stringConstant(sourceClient, 'NATIVE_HOST_NAME')
  const packagedClientHostName = stringConstant(packagedClient, 'NATIVE_HOST_NAME')
  const sourceClientExtensionId = stringConstant(sourceClient, 'EXTENSION_ID_EXPECTED')
  const packagedClientExtensionId = stringConstant(packagedClient, 'EXTENSION_ID_EXPECTED')
  const sourceHostName = stringConstant(sourceHostRuntime, 'NATIVE_HOST_NAME')
  const packagedHostName = stringConstant(packagedHostRuntime, 'NATIVE_HOST_NAME')
  const sourceHostMetadataFile = stringConstant(sourceHostRuntime, 'HOST_METADATA_FILE')
  const packagedHostMetadataFile = stringConstant(packagedHostRuntime, 'HOST_METADATA_FILE')
  let derivedExtensionId = null
  try {
    derivedExtensionId = deriveChromeExtensionId(sourceExtensionManifest.key)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  if (sourceExtensionManifest.key !== desktopExtensionPublicKey) {
    fail('manifest.key does not match desktop extension public key')
  }
  if (extensionManifest.key !== desktopExtensionPublicKey) fail('packaged manifest.key mismatch')
  if (derivedExtensionId !== desktopExtensionId) fail('manifest.key derived extension id mismatch')
  if (desktopHostName !== RELEASE_NATIVE_HOST_NAME) fail('desktop native host release identity mismatch')
  if (desktopMetadataFile !== RELEASE_HOST_METADATA_FILE) fail('desktop native host metadata file mismatch')
  if (sourceClientHostName !== desktopHostName) fail('source extension native host name mismatch')
  if (packagedClientHostName !== desktopHostName) fail('packaged extension native host name mismatch')
  if (sourceClientExtensionId !== derivedExtensionId) fail('source extension id constant mismatch')
  if (packagedClientExtensionId !== derivedExtensionId) fail('packaged extension id constant mismatch')
  if (sourceHostName !== desktopHostName) fail('source host runtime name mismatch')
  if (packagedHostName !== desktopHostName) fail('packaged host runtime name mismatch')
  if (sourceHostMetadataFile !== desktopMetadataFile) fail('source host metadata file mismatch')
  if (packagedHostMetadataFile !== desktopMetadataFile) fail('packaged host metadata file mismatch')
  const desktopExtensionOrigin = extensionOriginConstant(desktopConstants, desktopExtensionId)
  const expectedExtensionOrigin = derivedExtensionId ? `chrome-extension://${derivedExtensionId}/` : null
  if (desktopExtensionOrigin !== expectedExtensionOrigin) fail('desktop extension origin identity mismatch')
  if (desktopProtocolVersion == null || desktopExtensionVersion == null) fail('desktop bridge constants missing')
  if (sourceClientProtocolVersion !== desktopProtocolVersion) fail('source extension protocol constant mismatch')
  if (packagedClientProtocolVersion !== desktopProtocolVersion) fail('packaged extension protocol constant mismatch')
  if (sourceHostProtocolVersion !== desktopProtocolVersion) fail('source host protocol constant mismatch')
  if (packagedHostProtocolVersion !== desktopProtocolVersion) fail('packaged host protocol constant mismatch')
  if (sourceClientExtensionVersion !== desktopExtensionVersion) fail('source extension version constant mismatch')
  if (packagedClientExtensionVersion !== desktopExtensionVersion) fail('packaged extension version constant mismatch')
  if (extensionManifest.version !== desktopExtensionVersion) fail('extension manifest/runtime version mismatch')
  const serverCode = codeWithoutCommentsOrStrings(serverSource)
  if (
    !/\bmsg\s*\.\s*extensionVersion\s*!==\s*BROWSER_EXTENSION_VERSION\b/.test(serverCode)
    || !/\bmsg\s*\.\s*hostVersion\s*!==\s*deps\s*\.\s*appVersion\b/.test(serverCode)
  ) fail('desktop server version handshake guard missing')
  const expectedTriplet = {
    protocolVersion: desktopProtocolVersion,
    appVersion: pkg.version,
    extensionVersion: desktopExtensionVersion,
    hostVersion: pkg.version,
  }
  for (const [key, value] of Object.entries(expectedTriplet)) {
    if (metadata[key] !== value) fail(`version triplet ${key}: ${String(metadata[key])} != ${value}`)
  }
  if (metadata.schemaVersion !== 1) fail(`metadata schemaVersion=${String(metadata.schemaVersion)}`)
  evidence.versionTriplet = expectedTriplet
  evidence.runtimeVersions = {
    desktopProtocolVersion,
    desktopExtensionVersion,
    sourceClientProtocolVersion,
    sourceClientExtensionVersion,
    packagedClientProtocolVersion,
    packagedClientExtensionVersion,
    sourceHostProtocolVersion,
    packagedHostProtocolVersion,
    desktopExtensionId,
    derivedExtensionId,
    desktopHostName,
    desktopMetadataFile,
  }

  const sourceHostFiles = {
    'host.cmd': join(root, 'resources', 'browser-bridge', 'host.cmd'),
    'host.mjs': join(root, 'electron', 'ai', 'browser', 'bridge', 'host-runtime.mjs'),
    [`${hostNameForPaths}.json`]: join(root, 'resources', 'browser-bridge', `${hostNameForPaths}.json`),
  }
  evidence.hostHashes = {}
  for (const [name, sourcePath] of Object.entries(sourceHostFiles)) {
    const packagedPath = join(packagedHostDir, name)
    if (!existsSync(packagedPath)) {
      fail(`${name} missing`)
      continue
    }
    const sourceBytes = readFileSync(sourcePath)
    const packagedBytes = readFileSync(packagedPath)
    const hash = sha256(packagedBytes)
    evidence.hostHashes[name] = hash
    if (!sourceBytes.equals(packagedBytes)) fail(`${name} differs from reviewed source`)
    if (metadata.files?.[name] !== hash) fail(`${name} metadata hash mismatch`)
  }

  const packagedHostManifestPath = join(packagedHostDir, `${hostNameForPaths}.json`)
  if (existsSync(packagedHostManifestPath)) {
    const hostManifest = JSON.parse(readFileSync(packagedHostManifestPath, 'utf8'))
    if (hostManifest.name !== desktopHostName) fail('native host manifest name mismatch')
    if (hostManifest.path !== 'host.cmd') fail('shipped native host path must be stable relative host.cmd')
    if (hostManifest.type !== 'stdio') fail('native host manifest type must be stdio')
    if (JSON.stringify(hostManifest.allowed_origins) !== JSON.stringify([expectedExtensionOrigin])) {
      fail('native host allowed_origins mismatch')
    }
  }
  const packagedHostCmdPath = join(packagedHostDir, 'host.cmd')
  if (existsSync(packagedHostCmdPath)) {
    const hostCmd = readFileSync(packagedHostCmdPath, 'utf8')
    if (/\bwhere node\b/i.test(hostCmd)) fail('packaged host.cmd contains system Node fallback')
    const exactHostScript = /^\s*set\s+"HOST_JS=%HOST_DIR%host\.mjs"\s*$/im.test(hostCmd)
    const exactElectron = /^\s*set\s+"ELECTRON_EXE=%HOST_DIR%\.\.\\\.\.\\Verstak\.exe"\s*$/im.test(hostCmd)
    const exactLaunch = /^\s*"%ELECTRON_EXE%"\s+"%HOST_JS%"\s*$/im.test(hostCmd)
    if (!exactHostScript || !exactElectron || !exactLaunch) {
      fail('packaged host.cmd must execute exact host.mjs through Verstak.exe')
    }
  }

  const sourceExtensionFiles = walk(sourceExtensionDir).filter(name => !name.toLowerCase().endsWith('.md'))
  const packagedExtensionFiles = walk(packagedExtensionDir)
  if (JSON.stringify(sourceExtensionFiles) !== JSON.stringify(packagedExtensionFiles)) {
    fail('packaged extension file list differs from reviewed source')
  } else {
    for (const name of sourceExtensionFiles) {
      if (!readFileSync(join(sourceExtensionDir, name)).equals(readFileSync(join(packagedExtensionDir, name)))) {
        fail(`browser-extension/${name} differs from reviewed source`)
      }
    }
  }
  evidence.extensionFileCount = packagedExtensionFiles.length
  evidence.exeBytes = existsSync(exe) ? statSync(exe).size : 0
  return { ok: failures.length === 0, failures, evidence }
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = arg('root', process.cwd())
  const sourceDir = arg('source', join(root, 'release', 'win-unpacked'))
  try {
    const result = checkBrowserBridgePackage({ root, sourceDir })
    if (result.ok) {
      console.log(`[browser-package] PASS ${JSON.stringify(result.evidence)}`)
      process.exit(0)
    }
    console.error(`[browser-package] FAIL ${result.failures.join('; ')}`)
    process.exit(1)
  } catch (error) {
    console.error(`[browser-package] FAIL ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
