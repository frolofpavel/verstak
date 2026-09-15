import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hasStableInstallOwnerMarker,
  resolveDevUserDataOverride,
  resolveNativeHostPolicy,
} from '../../../electron/ai/browser/bridge'

describe('Browser Employee native-host ownership policy', () => {
  it('lets only a stable installed build own ordinary HKCU registration', () => {
    expect(resolveNativeHostPolicy({
      isPackaged: true,
      installedOwnerMarker: true,
      installedRegistryOwner: true,
    })).toEqual({
      mode: 'installed',
      canInstall: true,
      canRegister: true,
      reason: null,
    })
  })

  it('does not trust a stale local owner marker after HKCU ownership moved', () => {
    expect(resolveNativeHostPolicy({
      isPackaged: true,
      installedOwnerMarker: true,
      installedRegistryOwner: false,
    })).toMatchObject({
      mode: 'disabled',
      canInstall: false,
      canRegister: false,
    })
  })

  it('does not let a raw win-unpacked launch claim HKCU ownership', () => {
    expect(resolveNativeHostPolicy({ isPackaged: true })).toEqual({
      mode: 'disabled',
      canInstall: false,
      canRegister: false,
      reason: 'Эта unpacked-копия не установлена штатным установщиком и не может владеть Native Host',
    })
  })

  it('never registers or stages a portable extraction path', () => {
    expect(resolveNativeHostPolicy({
      isPackaged: true,
      portableExecutableFile: 'D:\\Tools\\Verstak-Portable.exe',
    })).toEqual({
      mode: 'portable',
      canInstall: false,
      canRegister: false,
      reason: 'Портативная сборка не регистрирует Native Host; установите стабильную версию Verstak',
    })
    expect(resolveNativeHostPolicy({
      isPackaged: true,
      portableExecutableDir: 'D:\\Tools\\Verstak-Portable',
      smoke: '1',
    })).toMatchObject({
      mode: 'portable',
      canInstall: false,
      canRegister: false,
    })
  })

  it('keeps dev Native Host disabled even with opt-in until its endpoint is bundle-bound', () => {
    expect(resolveNativeHostPolicy({ isPackaged: false })).toMatchObject({
      mode: 'disabled', canInstall: false, canRegister: false,
    })
    expect(resolveNativeHostPolicy({
      isPackaged: false,
      devNativeHostOptIn: '1',
    })).toMatchObject({ mode: 'disabled', canInstall: false, canRegister: false })
    expect(resolveNativeHostPolicy({
      isPackaged: false,
      devNativeHostOptIn: '1',
      devUserDataDir: 'C:\\Temp\\verstak-dev-isolated',
      defaultUserDataDir: 'C:\\Users\\Pavel\\AppData\\Roaming\\verstak',
      stableUserDataDir: 'C:\\Users\\Pavel\\AppData\\Roaming\\Verstak',
    })).toMatchObject({
      mode: 'disabled', canInstall: false, canRegister: false,
    })
  })

  it.each([
    ['relative path', '.\\tmp\\verstak-dev'],
    ['default userData with case and trailing separator', 'c:\\users\\pavel\\appdata\\roaming\\VERSTAK\\'],
    ['stable userData', 'D:\\StableData\\Verstak'],
    ['a child of stable userData', 'D:\\StableData\\Verstak\\dev'],
  ])('rejects dev isolation at %s', (_case, devUserDataDir) => {
    expect(resolveNativeHostPolicy({
      isPackaged: false,
      devNativeHostOptIn: '1',
      devUserDataDir,
      defaultUserDataDir: 'C:\\Users\\Pavel\\AppData\\Roaming\\verstak',
      stableUserDataDir: 'D:\\StableData\\Verstak\\',
    })).toMatchObject({
      mode: 'disabled', canInstall: false, canRegister: false,
    })
  })

  it('keeps a safe absolute DIR-only userData override independent from Native Host opt-in', () => {
    const input = {
      isPackaged: false,
      devUserDataDir: 'D:\\Verstak-Isolated\\mobile-dev',
      defaultUserDataDir: 'C:\\Users\\Pavel\\AppData\\Roaming\\verstak',
      stableUserDataDir: 'C:\\Users\\Pavel\\AppData\\Roaming\\VERSTAK',
    }
    expect(resolveDevUserDataOverride(input)).toBe('D:\\Verstak-Isolated\\mobile-dev')
    expect(resolveNativeHostPolicy(input)).toMatchObject({
      mode: 'disabled', canInstall: false, canRegister: false,
    })
  })

  it('rejects Win32 device namespaces and a junction alias into stable userData', () => {
    const root = mkdtempSync(join(tmpdir(), 'verstak-dev-path-policy-'))
    const stable = join(root, 'stable')
    const ordinary = join(root, 'ordinary')
    const alias = join(root, 'alias-to-stable')
    mkdirSync(stable)
    mkdirSync(ordinary)
    symlinkSync(stable, alias, 'junction')
    try {
      const base = {
        isPackaged: false,
        defaultUserDataDir: ordinary,
        stableUserDataDir: stable,
      }
      expect(resolveDevUserDataOverride({
        ...base,
        devUserDataDir: `\\\\?\\${stable}\\dev`,
      })).toBeNull()
      expect(resolveDevUserDataOverride({
        ...base,
        devUserDataDir: join(alias, 'dev'),
      })).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('main captures protected roots before setPath and wires the independent override into production startup', () => {
    const source = readFileSync(new URL('../../../electron/main.ts', import.meta.url), 'utf8')
    const captureDefault = source.indexOf("const defaultElectronUserDataDir = app.getPath('userData')")
    const resolveOverride = source.indexOf('const devUserDataOverride = resolveDevUserDataOverride({')
    const applyOverride = source.indexOf("app.setPath('userData', devUserDataOverride)")
    expect(captureDefault).toBeGreaterThan(-1)
    expect(resolveOverride).toBeGreaterThan(captureDefault)
    expect(applyOverride).toBeGreaterThan(resolveOverride)
    const overrideGuard = source.slice(source.lastIndexOf('if (', applyOverride), applyOverride)
    expect(overrideGuard).toContain('if (devUserDataOverride)')
    expect(overrideGuard).not.toContain('VERSTAK_DEV_NATIVE_HOST')
    expect(source).toContain('defaultUserDataDir: defaultElectronUserDataDir')
    expect(source).toContain('stableUserDataDir: stableElectronUserDataDir')
  })

  it('main gates both HKCU registration and endpoint publication on exact stable ownership', () => {
    const source = readFileSync(new URL('../../../electron/main.ts', import.meta.url), 'utf8')
    expect(source).toMatch(
      /installedRegistryOwner:\s*app\.isPackaged\s*&&\s*isStableOwnershipConfirmed\(ownershipMigration\)/,
    )
    expect(source).toMatch(
      /browserBridge\s*=\s*browserHostPolicy\.canRegister\s*\?\s*createBridgeServer\(/,
    )
  })

  it('allows packaged smoke to stage assets but never touch HKCU', () => {
    expect(resolveNativeHostPolicy({ isPackaged: true, smoke: '1' })).toEqual({
      mode: 'packaged-smoke', canInstall: true, canRegister: false, reason: null,
    })
  })

  it('owner marker is bound to the exact install directory, executable and current version', () => {
    const root = mkdtempSync(join(tmpdir(), 'verstak-owner-binding-'))
    const installedDir = join(root, 'installed')
    const copiedDir = join(root, 'copied')
    mkdirSync(installedDir)
    mkdirSync(copiedDir)
    const marker = {
      schemaVersion: 1,
      product: 'Verstak',
      appVersion: '2.8.2',
      installDir: installedDir,
      executablePath: join(installedDir, 'Verstak.exe'),
      ownsNativeHostRegistration: true,
    }
    writeFileSync(join(installedDir, 'Verstak.exe'), 'MZ', 'utf8')
    writeFileSync(join(copiedDir, 'Verstak.exe'), 'MZ', 'utf8')
    writeFileSync(join(installedDir, '.verstak-install-owner.json'), JSON.stringify(marker), 'utf8')
    writeFileSync(join(copiedDir, '.verstak-install-owner.json'), JSON.stringify(marker), 'utf8')
    try {
      expect(hasStableInstallOwnerMarker(
        installedDir,
        join(installedDir, 'Verstak.exe'),
        '2.8.2',
      )).toBe(true)
      expect(hasStableInstallOwnerMarker(
        copiedDir,
        join(copiedDir, 'Verstak.exe'),
        '2.8.2',
      )).toBe(false)
      expect(hasStableInstallOwnerMarker(
        installedDir,
        join(installedDir, 'Verstak.exe'),
        '2.8.3',
      )).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
