// host-lifecycle.ts — Windows HKCU registration Native Messaging host (EXT-B1).
//
// install / upgrade / repair / uninstall + readback для тестов.
// Никаких приватных ключей. allowed_origins — только наш EXTENSION_ID.

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  NATIVE_HOST_NAME,
} from './constants'

export interface HostManifest {
  name: string
  description: string
  path: string
  type: 'stdio'
  allowed_origins: string[]
}

export interface HostInstallResult {
  ok: boolean
  hostName: string
  manifestPath: string
  hostLauncherPath: string
  registryKeys: string[]
  error?: string
}

/** Pure: построить JSON host-manifest (для package + install). */
export function buildHostManifest(hostLauncherAbsolutePath: string): HostManifest {
  return {
    name: NATIVE_HOST_NAME,
    description: 'Verstak Browser Bridge (Connected Eyes)',
    path: hostLauncherAbsolutePath.replace(/\//g, '\\'),
    type: 'stdio',
    allowed_origins: [EXTENSION_ORIGIN],
  }
}

/** Pure: только наш origin, без wildcards. */
export function validateHostManifest(m: unknown): { ok: true; manifest: HostManifest } | { ok: false; reason: string } {
  if (!m || typeof m !== 'object') return { ok: false, reason: 'not object' }
  const o = m as Record<string, unknown>
  if (o.name !== NATIVE_HOST_NAME) return { ok: false, reason: 'bad name' }
  if (o.type !== 'stdio') return { ok: false, reason: 'type must be stdio' }
  if (typeof o.path !== 'string' || !o.path) return { ok: false, reason: 'path required' }
  if (!Array.isArray(o.allowed_origins) || o.allowed_origins.length !== 1) {
    return { ok: false, reason: 'allowed_origins must be exactly one origin' }
  }
  if (o.allowed_origins[0] !== EXTENSION_ORIGIN) {
    return { ok: false, reason: `allowed_origins must be ${EXTENSION_ORIGIN}` }
  }
  // Reject wildcards / all_urls style
  for (const origin of o.allowed_origins) {
    if (typeof origin !== 'string' || origin.includes('*') || origin.includes('all_urls')) {
      return { ok: false, reason: 'wildcard origins forbidden' }
    }
  }
  return {
    ok: true,
    manifest: {
      name: NATIVE_HOST_NAME,
      description: String(o.description ?? ''),
      path: String(o.path),
      type: 'stdio',
      allowed_origins: [EXTENSION_ORIGIN],
    },
  }
}

export function chromeRegistryKey(): string {
  return `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
}

export function edgeRegistryKey(): string {
  return `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
}

/**
 * Записать default value registry key → path to host manifest JSON.
 * reg.exe надёжнее PS Set-ItemProperty '(default)' на RU Windows.
 */
export function writeNativeMessagingRegistry(manifestPath: string): { ok: boolean; keys: string[]; error?: string } {
  const keys = [chromeRegistryKey(), edgeRegistryKey()]
  if (process.platform !== 'win32') {
    return { ok: true, keys: [] } // no-op off Windows (dev/CI)
  }
  const mp = manifestPath.replace(/\//g, '\\')
  const errors: string[] = []
  for (const key of keys) {
    // /ve = default value; /f = force overwrite
    const r = spawnSync(
      'reg.exe',
      ['add', key, '/ve', '/t', 'REG_SZ', '/d', mp, '/f'],
      { encoding: 'utf8', shell: false, windowsHide: true },
    )
    if (r.status !== 0) {
      errors.push(`${key}: ${(r.stderr || r.stdout || 'reg add failed').trim()}`)
    }
  }
  if (errors.length) return { ok: false, keys, error: errors.join('; ') }
  return { ok: true, keys }
}

/** Readback registry default values. */
export function readNativeMessagingRegistry(): Record<string, string | null> {
  const out: Record<string, string | null> = {
    [chromeRegistryKey()]: null,
    [edgeRegistryKey()]: null,
  }
  if (process.platform !== 'win32') return out
  for (const key of Object.keys(out)) {
    const r = spawnSync(
      'reg.exe',
      ['query', key, '/ve'],
      { encoding: 'utf8', shell: false, windowsHide: true },
    )
    if (r.status !== 0) {
      out[key] = null
      continue
    }
    // REG_SZ    C:\path\to\manifest.json
    const text = (r.stdout || '').trim()
    const m = text.match(/REG_SZ\s+(.+)$/im)
    out[key] = m ? m[1].trim() : null
  }
  return out
}

/** Удалить HKCU keys (uninstall / cleanup). */
export function removeNativeMessagingRegistry(): { ok: boolean; error?: string } {
  if (process.platform !== 'win32') return { ok: true }
  const keys = [chromeRegistryKey(), edgeRegistryKey()]
  for (const key of keys) {
    spawnSync(
      'reg.exe',
      ['delete', key, '/f'],
      { encoding: 'utf8', shell: false, windowsHide: true },
    )
  }
  return { ok: true }
}

/**
 * Windows host.cmd — запускает host.mjs через Electron-as-node
 * (ELECTRON_RUN_AS_NODE=1). Packaged path: resources/browser-bridge → ../../Verstak.exe.
 * Absolute electronExeAbsolute предпочтителен (bake at install) — не зависит от cwd.
 * System node — только dev fallback (allowNodeFallback=true).
 */
export function buildHostCmdContent(opts: {
  hostMjsRelativeToCmd?: string
  /** Absolute path to Verstak.exe / Electron.exe (preferred for install). */
  electronExeAbsolute?: string
  /**
   * Relative to host.cmd directory.
   * Packaged layout: resources/browser-bridge/host.cmd → ../../Verstak.exe
   */
  electronExeRelativeToCmd?: string
  /** Dev-only: fallback to system node if Verstak.exe missing. Packaged = false. */
  allowNodeFallback?: boolean
}): string {
  const hostMjs = opts.hostMjsRelativeToCmd ?? 'host.mjs'
  // Packaged: browser-bridge lives under resources/, exe is two levels up.
  const electronRel = opts.electronExeRelativeToCmd ?? '..\\..\\Verstak.exe'
  const allowNode = opts.allowNodeFallback === true
  const absLine = opts.electronExeAbsolute
    ? `set "ELECTRON_EXE_ABS=${opts.electronExeAbsolute.replace(/\//g, '\\')}"\n`
    : 'set "ELECTRON_EXE_ABS="\n'
  const nodeFallback = allowNode
    ? `where node >nul 2>nul
if %ERRORLEVEL%==0 (
  node "%HOST_JS%"
  exit /b %ERRORLEVEL%
)
`
    : ''
  return `@echo off
setlocal
set "HOST_DIR=%~dp0"
set "HOST_JS=%HOST_DIR%${hostMjs}"
${absLine}if defined ELECTRON_EXE_ABS if exist "%ELECTRON_EXE_ABS%" (
  set ELECTRON_RUN_AS_NODE=1
  "%ELECTRON_EXE_ABS%" "%HOST_JS%"
  exit /b %ERRORLEVEL%
)
set "ELECTRON_EXE=%HOST_DIR%${electronRel}"
if exist "%ELECTRON_EXE%" (
  set ELECTRON_RUN_AS_NODE=1
  "%ELECTRON_EXE%" "%HOST_JS%"
  exit /b %ERRORLEVEL%
)
${nodeFallback}echo Verstak native host: Verstak.exe not found (packaged host must not rely on system Node) 1>&2
exit /b 1
`
}

export interface InstallHostOptions {
  /** Каталог, куда кладём host.cmd + host.mjs + host-manifest.json */
  installDir: string
  /** Содержимое host.mjs (или путь — копируем снаружи). */
  hostScriptSource: string
  /** Absolute path to Verstak.exe / Electron (baked into host.cmd). */
  electronExeAbsolute?: string
  /**
   * Relative electron exe from installDir for host.cmd.
   * Default packaged: ..\\..\\Verstak.exe (resources/browser-bridge → app root).
   */
  electronExeRelative?: string
  /** Dev-only system node fallback. Packaged installs must leave false. */
  allowNodeFallback?: boolean
  /** Если true — перезаписать (upgrade/repair). */
  force?: boolean
}

/**
 * install/upgrade/repair: пишет assets + HKCU + readback.
 * hostScriptSource — полный текст host.mjs.
 */
export function installNativeHost(opts: InstallHostOptions): HostInstallResult {
  const installDir = opts.installDir
  try {
    mkdirSync(installDir, { recursive: true })
    const hostLauncherPath = join(installDir, 'host.cmd')
    const hostMjsPath = join(installDir, 'host.mjs')
    const manifestPath = join(installDir, `${NATIVE_HOST_NAME}.json`)

    writeFileSync(hostMjsPath, opts.hostScriptSource, 'utf8')
    writeFileSync(
      hostLauncherPath,
      buildHostCmdContent({
        hostMjsRelativeToCmd: 'host.mjs',
        electronExeAbsolute: opts.electronExeAbsolute,
        electronExeRelativeToCmd: opts.electronExeRelative ?? '..\\..\\Verstak.exe',
        allowNodeFallback: opts.allowNodeFallback === true,
      }),
      'utf8',
    )

    const manifest = buildHostManifest(hostLauncherPath)
    const validated = validateHostManifest(manifest)
    if (!validated.ok) {
      return {
        ok: false,
        hostName: NATIVE_HOST_NAME,
        manifestPath,
        hostLauncherPath,
        registryKeys: [],
        error: validated.reason,
      }
    }
    writeFileSync(manifestPath, JSON.stringify(validated.manifest, null, 2), 'utf8')

    const reg = writeNativeMessagingRegistry(manifestPath)
    if (!reg.ok) {
      return {
        ok: false,
        hostName: NATIVE_HOST_NAME,
        manifestPath,
        hostLauncherPath,
        registryKeys: reg.keys,
        error: reg.error,
      }
    }

    // Readback
    if (process.platform === 'win32') {
      const values = readNativeMessagingRegistry()
      const chromeVal = values[chromeRegistryKey()]
      if (!chromeVal || !chromeVal.toLowerCase().includes(NATIVE_HOST_NAME.toLowerCase())) {
        // soft: path might be absolute with different casing
        if (!chromeVal || !existsSync(chromeVal)) {
          return {
            ok: false,
            hostName: NATIVE_HOST_NAME,
            manifestPath,
            hostLauncherPath,
            registryKeys: reg.keys,
            error: `registry readback failed: ${JSON.stringify(values)}`,
          }
        }
      }
    }

    return {
      ok: true,
      hostName: NATIVE_HOST_NAME,
      manifestPath,
      hostLauncherPath,
      registryKeys: reg.keys,
    }
  } catch (err) {
    return {
      ok: false,
      hostName: NATIVE_HOST_NAME,
      manifestPath: join(installDir, `${NATIVE_HOST_NAME}.json`),
      hostLauncherPath: join(installDir, 'host.cmd'),
      registryKeys: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** uninstall cleanup: registry + optional files. */
export function uninstallNativeHost(installDir?: string): { ok: boolean; error?: string } {
  const reg = removeNativeMessagingRegistry()
  if (installDir && existsSync(installDir)) {
    try {
      rmSync(join(installDir, 'host.cmd'), { force: true })
      rmSync(join(installDir, 'host.mjs'), { force: true })
      rmSync(join(installDir, `${NATIVE_HOST_NAME}.json`), { force: true })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  return reg
}

/** Для dev: install рядом с userData. */
export function resolveDevHostInstallDir(userData: string): string {
  return join(userData, 'browser-bridge-host')
}

export function readInstalledManifest(manifestPath: string): HostManifest | null {
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const v = validateHostManifest(raw)
    return v.ok ? v.manifest : null
  } catch {
    return null
  }
}

export { EXTENSION_ID, EXTENSION_ORIGIN, NATIVE_HOST_NAME }
