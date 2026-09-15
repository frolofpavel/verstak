import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildUninstallScript } from '../../electron/installer/engine'
import { resolveNativeHostPolicy } from '../../electron/ai/browser/bridge'
import {
  isStableOwnershipConfirmed,
  migrateStableInstallOwnershipOnStartup as migrateActual,
} from '../../electron/installer/stable-ownership'
import { nativeHostOwnerMarker } from '../../shared/contracts/native-host-owner'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { acquireNativeHostOwnershipLease } from '../../electron/ai/browser/bridge/host-lifecycle'

let mutexName: string
beforeEach(() => { mutexName = `Local\\Verstak.MigrationTest.${randomUUID()}` })
const migrateStableInstallOwnershipOnStartup = (input: Parameters<typeof migrateActual>[0]) => migrateActual({
  ...input, acquireOwnershipLease: () => acquireNativeHostOwnershipLease({ mutexName }),
})

const temps: string[] = []

function legacyInstalledFixture(): {
  installDir: string
  executablePath: string
  markerPath: string
  uninstallPath: string
} {
  const installDir = mkdtempSync(join(tmpdir(), 'verstak-old-helper-target-start-'))
  temps.push(installDir)
  const executablePath = join(installDir, 'Verstak.exe')
  const markerPath = join(installDir, '.verstak-install-owner.json')
  const uninstallPath = join(installDir, 'Uninstall Verstak.ps1')
  // Production shape after a pre-R1 helper copied the new target payload: the
  // target exe is current, while ownership artifacts are still legacy.
  writeFileSync(executablePath, 'MZ-target-version', 'utf8')
  writeFileSync(uninstallPath, '# legacy destructive uninstaller\n', 'utf8')
  return { installDir, executablePath, markerPath, uninstallPath }
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('stable ownership forward migration on target startup', () => {
  it.skipIf(process.platform !== 'win32')('startup protects ownership writes and rollback from destructive interleaving', () => {
    const fixture = legacyInstalledFixture()
    const observations: number[] = []
    const result = migrateStableInstallOwnershipOnStartup({
      isPackaged: true, platform: 'win32', ...fixture, appVersion: '2.8.2',
      registeredInstallLocation: fixture.installDir, failAfterWrite: 'marker',
      onPhase: () => {
        const probe = `$m = [Threading.Mutex]::new($false, '${mutexName}'); $owned = $false
try { $owned = $m.WaitOne(0); if ($owned) { Remove-Item -LiteralPath '${fixture.uninstallPath}' -Force; exit 7 }; exit 0 }
finally { if ($owned) { $m.ReleaseMutex() }; $m.Dispose() }`
        observations.push(spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probe],
          { encoding: 'utf8', windowsHide: true }).status ?? -1)
      },
    } as Parameters<typeof migrateStableInstallOwnershipOnStartup>[0])
    expect(observations).toEqual([0, 0])
    expect(result).toMatchObject({ status: 'failed', rolledBack: true })
    expect(readFileSync(fixture.uninstallPath, 'utf8')).toContain('legacy')
  }, 60_000)
  it('repairs the first upgrade performed by a pre-R1 source helper before host policy runs', () => {
    const fixture = legacyInstalledFixture()

    const result = migrateStableInstallOwnershipOnStartup({
      isPackaged: true,
      platform: 'win32',
      installDir: fixture.installDir,
      executablePath: fixture.executablePath,
      appVersion: '2.8.2',
      registeredInstallLocation: fixture.installDir,
    })

    expect(result).toMatchObject({ status: 'migrated' })
    expect(JSON.parse(readFileSync(fixture.markerPath, 'utf8'))).toEqual(
      nativeHostOwnerMarker('2.8.2', fixture.installDir, fixture.executablePath),
    )
    expect(readFileSync(fixture.uninstallPath, 'utf8')).toBe(buildUninstallScript(fixture.installDir))
  })

  it.each([
    ['raw unpacked', { isPackaged: false }],
    ['portable', { portableExecutableFile: 'D:\\Verstak Portable.exe' }],
    ['packaged smoke', { smoke: '1' }],
    ['foreign InstallLocation', { registeredInstallLocation: 'C:\\Program Files\\Another Verstak' }],
  ])('does not legitimize %s startup', (_case, override) => {
    const fixture = legacyInstalledFixture()
    const legacyUninstaller = readFileSync(fixture.uninstallPath)

    const result = migrateStableInstallOwnershipOnStartup({
      isPackaged: true,
      platform: 'win32',
      installDir: fixture.installDir,
      executablePath: fixture.executablePath,
      appVersion: '2.8.2',
      registeredInstallLocation: fixture.installDir,
      ...override,
    })

    expect(result.status).toBe('skipped')
    expect(existsSync(fixture.markerPath)).toBe(false)
    expect(readFileSync(fixture.uninstallPath)).toEqual(legacyUninstaller)
  })

  it('restores exact legacy bytes when the ownership pair cannot commit', () => {
    const fixture = legacyInstalledFixture()
    const legacyUninstaller = readFileSync(fixture.uninstallPath)

    const result = migrateStableInstallOwnershipOnStartup({
      isPackaged: true,
      platform: 'win32',
      installDir: fixture.installDir,
      executablePath: fixture.executablePath,
      appVersion: '2.8.2',
      registeredInstallLocation: fixture.installDir,
      failAfterWrite: 'marker',
    })

    expect(result).toMatchObject({ status: 'failed', rolledBack: true })
    expect(existsSync(fixture.markerPath)).toBe(false)
    expect(readFileSync(fixture.uninstallPath)).toEqual(legacyUninstaller)
  })

  it('rolls migrated files back when HKCU ownership changes during startup', () => {
    const fixture = legacyInstalledFixture()
    const legacyUninstaller = readFileSync(fixture.uninstallPath)

    const result = migrateStableInstallOwnershipOnStartup({
      isPackaged: true,
      platform: 'win32',
      installDir: fixture.installDir,
      executablePath: fixture.executablePath,
      appVersion: '2.8.2',
      registeredInstallLocation: fixture.installDir,
      registeredInstallLocationAfter: 'C:\\Program Files\\Successor Verstak',
    })

    expect(result).toMatchObject({ status: 'failed', rolledBack: true })
    expect(result.reason).toContain('InstallLocation changed')
    expect(existsSync(fixture.markerPath)).toBe(false)
    expect(readFileSync(fixture.uninstallPath)).toEqual(legacyUninstaller)
  })

  it.each([
    ['foreign', 'C:\\Program Files\\Successor Verstak'],
    ['missing', ''],
  ])('valid local marker cannot authorize Native Host when HKCU ownership is %s', (_case, registryOwner) => {
    const fixture = legacyInstalledFixture()
    writeFileSync(
      fixture.markerPath,
      `${JSON.stringify(nativeHostOwnerMarker('2.8.2', fixture.installDir, fixture.executablePath), null, 2)}\n`,
      'utf8',
    )
    writeFileSync(fixture.uninstallPath, buildUninstallScript(fixture.installDir), 'utf8')

    const migration = migrateStableInstallOwnershipOnStartup({
      isPackaged: true,
      platform: 'win32',
      installDir: fixture.installDir,
      executablePath: fixture.executablePath,
      appVersion: '2.8.2',
      registeredInstallLocation: registryOwner,
    })
    const policy = resolveNativeHostPolicy({
      isPackaged: true,
      installedOwnerMarker: true,
      installedRegistryOwner: isStableOwnershipConfirmed(migration),
    })

    expect(migration.status).toBe('skipped')
    expect(policy).toMatchObject({ mode: 'disabled', canRegister: false })
  })

  it('never exposes partial marker bytes when interrupted after atomic staging', () => {
    const fixture = legacyInstalledFixture()
    const legacyUninstaller = readFileSync(fixture.uninstallPath)

    const result = migrateStableInstallOwnershipOnStartup({
      isPackaged: true,
      platform: 'win32',
      installDir: fixture.installDir,
      executablePath: fixture.executablePath,
      appVersion: '2.8.2',
      registeredInstallLocation: fixture.installDir,
      failAfterStage: 'marker',
    })

    expect(result).toMatchObject({ status: 'failed', rolledBack: true })
    expect(existsSync(fixture.markerPath)).toBe(false)
    expect(readFileSync(fixture.uninstallPath)).toEqual(legacyUninstaller)
    expect(readdirSync(fixture.installDir).some(name => name.includes('.atomic-next-'))).toBe(false)
  })
})
