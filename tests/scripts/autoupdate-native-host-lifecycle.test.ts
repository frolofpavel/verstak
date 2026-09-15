import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { buildUninstallScript } from '../../electron/installer/engine'
import { nativeHostOwnerMarker } from '../../shared/contracts/native-host-owner'

const require = createRequire(import.meta.url)
const helper = require('../../scripts/verstak-auto-update-helper.cjs') as {
  acquireStableOwnershipLease(options?: { mutexName?: string }): { release(): void }
  buildOwnerMarker(version: string, installDir: string): Record<string, unknown>
  buildSafeUninstallScript(installDir: string): string
  captureStableInstallProof(input: {
    installDir: string
    sourceVersion: string
    registeredInstallLocation: string
    env?: Record<string, string>
  }): {
    markerPath: string
    uninstallPath: string
    markerBytes: Buffer | null
    uninstallBytes: Buffer
  }
  stageStableOwnershipArtifacts(input: {
    acquireOwnershipLease?: () => { release(): void }
    proof: ReturnType<typeof helper.captureStableInstallProof>
    targetVersion: string
    registeredInstallLocation: string
    failAfterWrite?: 'marker' | 'uninstaller'
    failAfterStage?: 'marker' | 'uninstaller'
  }): {
    marker: Record<string, unknown>
    commit(): void
    rollback(): void
  }
  snapshotDirectoryTree(root: string): Array<Record<string, unknown>>
  robocopyMirrorDirectory(
    sourceDir: string,
    destinationDir: string,
    input?: {
      runCommand?: (command: string, args: string[]) => { status: number | null, stdout?: string, stderr?: string }
      label?: string
    },
  ): void
  waitForProcessExit(
    parentPid: number,
    input?: {
      runCommand?: (command: string, args: string[]) => { status: number | null, stdout?: string, stderr?: string }
      now?: () => number
      sleep?: (milliseconds: number) => void
      maxWaitMs?: number
      pollIntervalMs?: number
      settleMs?: number
    },
  ): void
  stageInstallPayloadTransaction(input: {
    acquireOwnershipLease?: () => { release(): void }
    payloadRoot: string
    installDir: string
    targetVersion: string
    transactionRoot: string
    proof: ReturnType<typeof helper.captureStableInstallProof>
    registeredInstallLocation: string
    mirrorDirectory?: (sourceDir: string, destinationDir: string, label?: string) => void
    verifyPayload?: (payloadRoot: string, expectedVersion: string) => Record<string, unknown>
  }): {
    apply(): Record<string, unknown>
    commit(): void
    rollback(): void
  }
}

const temps: string[] = []
let mutexName: string
beforeEach(() => { mutexName = `Local\\Verstak.UpdateTest.${randomUUID()}` })
// Real OS lock with a per-test identity; the production CLI never overrides it.
const stagePayload = helper.stageInstallPayloadTransaction
helper.stageInstallPayloadTransaction = input => stagePayload({ ...input,
  acquireOwnershipLease: () => helper.acquireStableOwnershipLease({ mutexName }) })
const stageOwnership = helper.stageStableOwnershipArtifacts
helper.stageStableOwnershipArtifacts = input => stageOwnership({ ...input,
  acquireOwnershipLease: () => helper.acquireStableOwnershipLease({ mutexName }) })

function stableFixture(opts: { marker?: boolean } = {}): {
  installDir: string
  markerPath: string
  uninstallPath: string
} {
  const installDir = mkdtempSync(join(tmpdir(), 'verstak-autoupdate-owner-'))
  temps.push(installDir)
  const markerPath = join(installDir, '.verstak-install-owner.json')
  const uninstallPath = join(installDir, 'Uninstall Verstak.ps1')
  writeFileSync(join(installDir, 'Verstak.exe'), 'MZ-old', 'utf8')
  writeFileSync(uninstallPath, '# legacy destructive uninstaller\n', 'utf8')
  if (opts.marker) {
    writeFileSync(
      markerPath,
      JSON.stringify(nativeHostOwnerMarker('2.8.1', installDir, join(installDir, 'Verstak.exe')), null, 2),
      'utf8',
    )
  }
  return { installDir, markerPath, uninstallPath }
}

function readTree(root: string): Record<string, string> {
  const result: Record<string, string> = {}
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name)
      const key = relative(root, absolute).replace(/\\/g, '/')
      if (entry.isDirectory()) {
        result[`${key}/`] = '<dir>'
        visit(absolute)
      } else if (entry.isFile()) {
        result[key] = readFileSync(absolute).toString('base64')
      } else {
        throw new Error(`unsupported fixture entry: ${absolute}`)
      }
    }
  }
  visit(root)
  return result
}

function exactMirror(sourceDir: string, destinationDir: string): void {
  rmSync(destinationDir, { recursive: true, force: true })
  mkdirSync(dirname(destinationDir), { recursive: true })
  cpSync(sourceDir, destinationDir, { recursive: true })
}

function payloadTransactionFixture(): {
  root: string
  installDir: string
  payloadRoot: string
  transactionRoot: string
  markerPath: string
  uninstallPath: string
} {
  const root = mkdtempSync(join(tmpdir(), 'verstak-autoupdate-payload-'))
  temps.push(root)
  const installDir = join(root, 'stable')
  const payloadRoot = join(root, 'payload')
  const transactionRoot = join(root, 'transaction')
  const markerPath = join(installDir, '.verstak-install-owner.json')
  const uninstallPath = join(installDir, 'Uninstall Verstak.ps1')

  mkdirSync(join(installDir, 'resources', 'app.asar.unpacked'), { recursive: true })
  mkdirSync(join(installDir, 'locales'), { recursive: true })
  writeFileSync(join(installDir, 'Verstak.exe'), 'MZ-source', 'utf8')
  writeFileSync(join(installDir, 'version.txt'), '2.8.1', 'utf8')
  writeFileSync(join(installDir, 'resources', 'app.asar'), 'source-asar', 'utf8')
  writeFileSync(join(installDir, 'resources', 'app.asar.unpacked', 'obsolete.node'), 'old-native', 'utf8')
  writeFileSync(join(installDir, 'locales', 'old.pak'), 'old-locale', 'utf8')
  writeFileSync(join(installDir, 'obsolete.dll'), 'obsolete', 'utf8')
  writeFileSync(uninstallPath, '# source uninstaller\n', 'utf8')
  writeFileSync(
    markerPath,
    `${JSON.stringify(nativeHostOwnerMarker('2.8.1', installDir, join(installDir, 'Verstak.exe')), null, 2)}\n`,
    'utf8',
  )

  mkdirSync(join(payloadRoot, 'resources', 'app.asar.unpacked'), { recursive: true })
  mkdirSync(join(payloadRoot, 'locales'), { recursive: true })
  writeFileSync(join(payloadRoot, 'Verstak.exe'), 'MZ-target', 'utf8')
  writeFileSync(join(payloadRoot, 'version.txt'), '2.8.2', 'utf8')
  writeFileSync(join(payloadRoot, 'resources', 'app.asar'), 'target-asar', 'utf8')
  writeFileSync(join(payloadRoot, 'resources', 'app.asar.unpacked', 'target.node'), 'new-native', 'utf8')
  writeFileSync(join(payloadRoot, 'locales', 'en-US.pak'), 'target-en', 'utf8')
  writeFileSync(join(payloadRoot, 'locales', 'ru.pak'), 'target-ru', 'utf8')

  return { root, installDir, payloadRoot, transactionRoot, markerPath, uninstallPath }
}

function fixturePayloadVerifier(payloadRoot: string, expectedVersion: string): Record<string, unknown> {
  const actualVersion = readFileSync(join(payloadRoot, 'version.txt'), 'utf8')
  if (actualVersion !== expectedVersion) throw new Error(`fixture version ${actualVersion}, expected ${expectedVersion}`)
  if (!existsSync(join(payloadRoot, 'Verstak.exe'))) throw new Error('fixture Verstak.exe missing')
  if (!existsSync(join(payloadRoot, 'resources', 'app.asar'))) throw new Error('fixture app.asar missing')
  return { version: actualVersion }
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('auto-update stable Native Host ownership migration', () => {
  it('migrates a proven pre-R1 stable install to an exact marker and successor-safe uninstaller', () => {
    const fixture = stableFixture()
    const proof = helper.captureStableInstallProof({
      installDir: fixture.installDir,
      sourceVersion: '2.8.1',
      registeredInstallLocation: fixture.installDir,
    })
    const transaction = helper.stageStableOwnershipArtifacts({
      proof,
      targetVersion: '2.8.2',
      registeredInstallLocation: fixture.installDir,
    })

    expect(JSON.parse(readFileSync(fixture.markerPath, 'utf8'))).toEqual(
      nativeHostOwnerMarker('2.8.2', fixture.installDir, join(fixture.installDir, 'Verstak.exe')),
    )
    expect(readFileSync(fixture.uninstallPath, 'utf8')).toBe(buildUninstallScript(fixture.installDir))
    transaction.commit()
  })

  it.each(['marker', 'uninstaller'] as const)(
    'restores exact prior marker and uninstaller bytes when the %s write fails',
    (failAfterWrite) => {
      const fixture = stableFixture({ marker: true })
      const markerBefore = readFileSync(fixture.markerPath)
      const uninstallBefore = readFileSync(fixture.uninstallPath)
      const proof = helper.captureStableInstallProof({
        installDir: fixture.installDir,
        sourceVersion: '2.8.1',
        registeredInstallLocation: fixture.installDir,
      })

      expect(() => helper.stageStableOwnershipArtifacts({
        proof,
        targetVersion: '2.8.2',
        registeredInstallLocation: fixture.installDir,
        failAfterWrite,
      })).toThrow(/injected/i)
      expect(readFileSync(fixture.markerPath)).toEqual(markerBefore)
      expect(readFileSync(fixture.uninstallPath)).toEqual(uninstallBefore)
    },
  )

  it.each(['marker', 'uninstaller'] as const)(
    'preserves exact prior bytes when atomic %s staging fails after fsync but before replace',
    (failAfterStage) => {
      const fixture = stableFixture({ marker: true })
      const markerBefore = readFileSync(fixture.markerPath)
      const uninstallBefore = readFileSync(fixture.uninstallPath)
      const proof = helper.captureStableInstallProof({
        installDir: fixture.installDir,
        sourceVersion: '2.8.1',
        registeredInstallLocation: fixture.installDir,
      })

      expect(() => helper.stageStableOwnershipArtifacts({
        proof,
        targetVersion: '2.8.2',
        registeredInstallLocation: fixture.installDir,
        failAfterStage,
      })).toThrow(/injected atomic stage failure/i)
      expect(readFileSync(fixture.markerPath)).toEqual(markerBefore)
      expect(readFileSync(fixture.uninstallPath)).toEqual(uninstallBefore)
      expect(readdirSync(fixture.installDir).some(name => name.includes('.atomic-next-'))).toBe(false)
    },
  )

  it('keeps target ownership artifacts after the target-payload commit boundary', () => {
    const fixture = stableFixture({ marker: true })
    const proof = helper.captureStableInstallProof({
      installDir: fixture.installDir,
      sourceVersion: '2.8.1',
      registeredInstallLocation: fixture.installDir,
    })
    const transaction = helper.stageStableOwnershipArtifacts({
      proof,
      targetVersion: '2.8.2',
      registeredInstallLocation: fixture.installDir,
    })
    const targetMarker = readFileSync(fixture.markerPath)
    const targetUninstaller = readFileSync(fixture.uninstallPath)

    transaction.commit()
    transaction.rollback()

    expect(readFileSync(fixture.markerPath)).toEqual(targetMarker)
    expect(readFileSync(fixture.uninstallPath)).toEqual(targetUninstaller)
    expect(JSON.parse(targetMarker.toString('utf8'))).toMatchObject({ appVersion: '2.8.2' })
  })

  it('never lets an older rollback overwrite a successor ownership transaction', () => {
    const fixture = stableFixture({ marker: true })
    const proof = helper.captureStableInstallProof({
      installDir: fixture.installDir,
      sourceVersion: '2.8.1',
      registeredInstallLocation: fixture.installDir,
    })
    const transaction = helper.stageStableOwnershipArtifacts({
      proof,
      targetVersion: '2.8.2',
      registeredInstallLocation: fixture.installDir,
    })
    const successorMarker = `${JSON.stringify(
      nativeHostOwnerMarker('2.8.3', fixture.installDir, join(fixture.installDir, 'Verstak.exe')),
      null,
      2,
    )}\n`
    const safeUninstaller = readFileSync(fixture.uninstallPath)
    writeFileSync(fixture.markerPath, successorMarker, 'utf8')

    expect(() => transaction.rollback()).toThrow(/successor bytes preserved/i)
    expect(readFileSync(fixture.markerPath, 'utf8')).toBe(successorMarker)
    expect(readFileSync(fixture.uninstallPath)).toEqual(safeUninstaller)
  })

  it('does not legitimize a moved/copy install, raw unpacked directory, portable, or invalid marker', () => {
    const original = stableFixture({ marker: true })
    const movedDir = mkdtempSync(join(tmpdir(), 'verstak-autoupdate-moved-'))
    temps.push(movedDir)
    mkdirSync(movedDir, { recursive: true })
    writeFileSync(join(movedDir, 'Verstak.exe'), 'MZ-copy', 'utf8')
    writeFileSync(join(movedDir, 'Uninstall Verstak.ps1'), '# copied\n', 'utf8')
    writeFileSync(
      join(movedDir, '.verstak-install-owner.json'),
      readFileSync(original.markerPath),
    )
    expect(() => helper.captureStableInstallProof({
      installDir: movedDir,
      sourceVersion: '2.8.1',
      registeredInstallLocation: movedDir,
    })).toThrow(/marker is invalid/i)

    const raw = stableFixture()
    expect(() => helper.captureStableInstallProof({
      installDir: raw.installDir,
      sourceVersion: '2.8.1',
      registeredInstallLocation: 'C:\\Program Files\\Real Verstak',
    })).toThrow(/InstallLocation/i)
    expect(() => helper.captureStableInstallProof({
      installDir: raw.installDir,
      sourceVersion: '2.8.1',
      registeredInstallLocation: raw.installDir,
      env: { PORTABLE_EXECUTABLE_FILE: 'D:\\Verstak Portable.exe' },
    })).toThrow(/Portable/i)

    writeFileSync(raw.markerPath, '{"schemaVersion":1,"product":"Verstak"}', 'utf8')
    expect(() => helper.captureStableInstallProof({
      installDir: raw.installDir,
      sourceVersion: '2.8.1',
      registeredInstallLocation: raw.installDir,
    })).toThrow(/marker is invalid/i)
  })

  it('fails if registry or artifact preimage changes before the update swap', () => {
    const fixture = stableFixture({ marker: true })
    const proof = helper.captureStableInstallProof({
      installDir: fixture.installDir,
      sourceVersion: '2.8.1',
      registeredInstallLocation: fixture.installDir,
    })
    writeFileSync(fixture.uninstallPath, '# successor owns this file\n', 'utf8')

    expect(() => helper.stageStableOwnershipArtifacts({
      proof,
      targetVersion: '2.8.2',
      registeredInstallLocation: fixture.installDir,
    })).toThrow(/uninstaller changed/i)
    expect(() => helper.stageStableOwnershipArtifacts({
      proof: { ...proof, uninstallBytes: readFileSync(fixture.uninstallPath) },
      targetVersion: '2.8.2',
      registeredInstallLocation: 'C:\\Program Files\\Successor',
    })).toThrow(/InstallLocation changed/i)
  })

  it('mirrors the exact target tree, including locales, and deletes obsolete installed files', () => {
    const fixture = payloadTransactionFixture()
    const proof = helper.captureStableInstallProof({
      installDir: fixture.installDir,
      sourceVersion: '2.8.1',
      registeredInstallLocation: fixture.installDir,
    })
    const transaction = helper.stageInstallPayloadTransaction({
      payloadRoot: fixture.payloadRoot,
      installDir: fixture.installDir,
      targetVersion: '2.8.2',
      transactionRoot: fixture.transactionRoot,
      proof,
      registeredInstallLocation: fixture.installDir,
      mirrorDirectory: exactMirror,
      verifyPayload: fixturePayloadVerifier,
    })

    transaction.apply()
    transaction.commit()

    expect(readFileSync(join(fixture.installDir, 'Verstak.exe'), 'utf8')).toBe('MZ-target')
    expect(readFileSync(join(fixture.installDir, 'locales', 'en-US.pak'), 'utf8')).toBe('target-en')
    expect(readFileSync(join(fixture.installDir, 'locales', 'ru.pak'), 'utf8')).toBe('target-ru')
    expect(existsSync(join(fixture.installDir, 'locales', 'old.pak'))).toBe(false)
    expect(existsSync(join(fixture.installDir, 'obsolete.dll'))).toBe(false)
    expect(existsSync(join(fixture.installDir, 'resources', 'app.asar.unpacked', 'obsolete.node'))).toBe(false)
    expect(JSON.parse(readFileSync(fixture.markerPath, 'utf8'))).toMatchObject({ appVersion: '2.8.2' })
    expect(readFileSync(fixture.uninstallPath, 'utf8')).toBe(buildUninstallScript(fixture.installDir))
  })

  it.runIf(process.platform === 'win32')('excludes destructive interleaving throughout backup target mirror and rollback', () => {
    const fixture = payloadTransactionFixture()
    const proof = helper.captureStableInstallProof({ installDir: fixture.installDir,
      sourceVersion: '2.8.1', registeredInstallLocation: fixture.installDir })
    const observations: Array<{ phase: number; code: number | null }> = []
    let phase = 0
    const transaction = helper.stageInstallPayloadTransaction({
      payloadRoot: fixture.payloadRoot, installDir: fixture.installDir, targetVersion: '2.8.2',
      transactionRoot: fixture.transactionRoot, proof, registeredInstallLocation: fixture.installDir,
      verifyPayload: fixturePayloadVerifier,
      mirrorDirectory: (source, target) => {
        phase += 1
        const script = `$m = [Threading.Mutex]::new($false, '${mutexName}'); $owned = $false
try { $owned = $m.WaitOne(0); if ($owned) { Remove-Item -LiteralPath '${fixture.uninstallPath}' -Force; exit 7 }; exit 0 }
finally { if ($owned) { $m.ReleaseMutex() }; $m.Dispose() }`
        observations.push({ phase, code: spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
          { encoding: 'utf8', windowsHide: true }).status })
        if (phase === 3) throw new Error('injected mirror failure')
        exactMirror(source, target)
      },
    })
    expect(() => transaction.apply()).toThrow(/injected mirror failure/)
    expect(observations).toEqual([1, 2, 3, 4].map(value => ({ phase: value, code: 0 })))
    expect(readFileSync(fixture.uninstallPath, 'utf8')).toContain('source uninstaller')
  }, 60_000)

  it('restores the complete source tree after a partial target mirror failure', () => {
    const fixture = payloadTransactionFixture()
    const before = readTree(fixture.installDir)
    const proof = helper.captureStableInstallProof({
      installDir: fixture.installDir,
      sourceVersion: '2.8.1',
      registeredInstallLocation: fixture.installDir,
    })
    let mirrorCall = 0
    const mirrorWithPartialFailure = (sourceDir: string, destinationDir: string) => {
      mirrorCall += 1
      if (mirrorCall === 3) {
        writeFileSync(join(destinationDir, 'Verstak.exe'), 'MZ-mixed', 'utf8')
        rmSync(join(destinationDir, 'locales', 'old.pak'), { force: true })
        throw new Error('injected target robocopy failure')
      }
      exactMirror(sourceDir, destinationDir)
    }
    const transaction = helper.stageInstallPayloadTransaction({
      payloadRoot: fixture.payloadRoot,
      installDir: fixture.installDir,
      targetVersion: '2.8.2',
      transactionRoot: fixture.transactionRoot,
      proof,
      registeredInstallLocation: fixture.installDir,
      mirrorDirectory: mirrorWithPartialFailure,
      verifyPayload: fixturePayloadVerifier,
    })

    expect(() => transaction.apply()).toThrow(/injected target robocopy failure/i)
    expect(readTree(fixture.installDir)).toEqual(before)
    expect(mirrorCall).toBe(4)
  })

  it('rejects incomplete staging or a source payload that changes while being staged', () => {
    const incomplete = payloadTransactionFixture()
    const incompleteBefore = readTree(incomplete.installDir)
    const incompleteProof = helper.captureStableInstallProof({
      installDir: incomplete.installDir,
      sourceVersion: '2.8.1',
      registeredInstallLocation: incomplete.installDir,
    })
    expect(() => helper.stageInstallPayloadTransaction({
      payloadRoot: incomplete.payloadRoot,
      installDir: incomplete.installDir,
      targetVersion: '2.8.2',
      transactionRoot: incomplete.transactionRoot,
      proof: incompleteProof,
      registeredInstallLocation: incomplete.installDir,
      mirrorDirectory: (sourceDir, destinationDir) => {
        exactMirror(sourceDir, destinationDir)
        rmSync(join(destinationDir, 'locales', 'ru.pak'), { force: true })
      },
      verifyPayload: fixturePayloadVerifier,
    })).toThrow(/target staging readback mismatch/i)
    expect(readTree(incomplete.installDir)).toEqual(incompleteBefore)

    const changing = payloadTransactionFixture()
    const changingBefore = readTree(changing.installDir)
    const changingProof = helper.captureStableInstallProof({
      installDir: changing.installDir,
      sourceVersion: '2.8.1',
      registeredInstallLocation: changing.installDir,
    })
    expect(() => helper.stageInstallPayloadTransaction({
      payloadRoot: changing.payloadRoot,
      installDir: changing.installDir,
      targetVersion: '2.8.2',
      transactionRoot: changing.transactionRoot,
      proof: changingProof,
      registeredInstallLocation: changing.installDir,
      mirrorDirectory: (sourceDir, destinationDir) => {
        exactMirror(sourceDir, destinationDir)
        writeFileSync(join(sourceDir, 'late-change.bin'), 'racing writer', 'utf8')
      },
      verifyPayload: fixturePayloadVerifier,
    })).toThrow(/source payload changed during target staging/i)
    expect(readTree(changing.installDir)).toEqual(changingBefore)
  })

  it('restores the complete source tree when target verification fails after a successful mirror', () => {
    const fixture = payloadTransactionFixture()
    const before = readTree(fixture.installDir)
    const proof = helper.captureStableInstallProof({
      installDir: fixture.installDir,
      sourceVersion: '2.8.1',
      registeredInstallLocation: fixture.installDir,
    })
    let targetInstallVerification = 0
    const transaction = helper.stageInstallPayloadTransaction({
      payloadRoot: fixture.payloadRoot,
      installDir: fixture.installDir,
      targetVersion: '2.8.2',
      transactionRoot: fixture.transactionRoot,
      proof,
      registeredInstallLocation: fixture.installDir,
      mirrorDirectory: exactMirror,
      verifyPayload: (payloadRoot, expectedVersion) => {
        const verified = fixturePayloadVerifier(payloadRoot, expectedVersion)
        if (payloadRoot === fixture.installDir && expectedVersion === '2.8.2' && targetInstallVerification++ === 0) {
          throw new Error('injected target verification failure')
        }
        return verified
      },
    })

    expect(() => transaction.apply()).toThrow(/injected target verification failure/i)
    expect(readTree(fixture.installDir)).toEqual(before)
    expect(readFileSync(fixture.markerPath, 'utf8')).toContain('"appVersion": "2.8.1"')
  })

  it('detects a silent non-mirror result and rolls back instead of accepting mixed bytes', () => {
    const fixture = payloadTransactionFixture()
    const before = readTree(fixture.installDir)
    const proof = helper.captureStableInstallProof({
      installDir: fixture.installDir,
      sourceVersion: '2.8.1',
      registeredInstallLocation: fixture.installDir,
    })
    let mirrorCall = 0
    const mirrorWithSilentOmission = (sourceDir: string, destinationDir: string) => {
      mirrorCall += 1
      exactMirror(sourceDir, destinationDir)
      if (mirrorCall === 3) rmSync(join(destinationDir, 'locales', 'ru.pak'), { force: true })
    }
    const transaction = helper.stageInstallPayloadTransaction({
      payloadRoot: fixture.payloadRoot,
      installDir: fixture.installDir,
      targetVersion: '2.8.2',
      transactionRoot: fixture.transactionRoot,
      proof,
      registeredInstallLocation: fixture.installDir,
      mirrorDirectory: mirrorWithSilentOmission,
      verifyPayload: fixturePayloadVerifier,
    })

    expect(() => transaction.apply()).toThrow(/target tree readback mismatch/i)
    expect(readTree(fixture.installDir)).toEqual(before)
  })

  it('does not mutate stable bytes when the full backup is incomplete or the source changes before apply', () => {
    const fixture = payloadTransactionFixture()
    const before = readTree(fixture.installDir)
    const proof = helper.captureStableInstallProof({
      installDir: fixture.installDir,
      sourceVersion: '2.8.1',
      registeredInstallLocation: fixture.installDir,
    })
    let mirrorCall = 0
    expect(() => helper.stageInstallPayloadTransaction({
      payloadRoot: fixture.payloadRoot,
      installDir: fixture.installDir,
      targetVersion: '2.8.2',
      transactionRoot: fixture.transactionRoot,
      proof,
      registeredInstallLocation: fixture.installDir,
      mirrorDirectory: (sourceDir, destinationDir) => {
        mirrorCall += 1
        exactMirror(sourceDir, destinationDir)
        if (mirrorCall === 2) rmSync(join(destinationDir, 'locales', 'old.pak'), { force: true })
      },
      verifyPayload: fixturePayloadVerifier,
    })).toThrow(/backup readback mismatch/i)
    expect(readTree(fixture.installDir)).toEqual(before)

    rmSync(fixture.transactionRoot, { recursive: true, force: true })
    const transaction = helper.stageInstallPayloadTransaction({
      payloadRoot: fixture.payloadRoot,
      installDir: fixture.installDir,
      targetVersion: '2.8.2',
      transactionRoot: fixture.transactionRoot,
      proof,
      registeredInstallLocation: fixture.installDir,
      mirrorDirectory: exactMirror,
      verifyPayload: fixturePayloadVerifier,
    })
    writeFileSync(join(fixture.installDir, 'successor.txt'), 'new updater', 'utf8')
    expect(() => transaction.apply()).toThrow(/source tree changed before apply/i)
    expect(readFileSync(join(fixture.installDir, 'successor.txt'), 'utf8')).toBe('new updater')
  })

  it('verifies rollback readback and reports rollback failure without hiding the original failure', () => {
    const fixture = payloadTransactionFixture()
    const proof = helper.captureStableInstallProof({
      installDir: fixture.installDir,
      sourceVersion: '2.8.1',
      registeredInstallLocation: fixture.installDir,
    })
    let mirrorCall = 0
    const transaction = helper.stageInstallPayloadTransaction({
      payloadRoot: fixture.payloadRoot,
      installDir: fixture.installDir,
      targetVersion: '2.8.2',
      transactionRoot: fixture.transactionRoot,
      proof,
      registeredInstallLocation: fixture.installDir,
      mirrorDirectory: (sourceDir, destinationDir) => {
        mirrorCall += 1
        if (mirrorCall === 3) {
          writeFileSync(join(destinationDir, 'Verstak.exe'), 'MZ-partial', 'utf8')
          throw new Error('primary copy failure')
        }
        if (mirrorCall === 4) {
          exactMirror(sourceDir, destinationDir)
          writeFileSync(join(destinationDir, 'Verstak.exe'), 'MZ-bad-rollback', 'utf8')
          return
        }
        exactMirror(sourceDir, destinationDir)
      },
      verifyPayload: fixturePayloadVerifier,
    })

    expect(() => transaction.apply()).toThrow(/primary copy failure.*rollback failed.*readback mismatch/i)
  })

  it('rejects a transaction workspace overlapping the stable install or source payload', () => {
    const fixture = payloadTransactionFixture()
    const before = readTree(fixture.installDir)
    const proof = helper.captureStableInstallProof({
      installDir: fixture.installDir,
      sourceVersion: '2.8.1',
      registeredInstallLocation: fixture.installDir,
    })
    const input = {
      payloadRoot: fixture.payloadRoot,
      installDir: fixture.installDir,
      targetVersion: '2.8.2',
      proof,
      registeredInstallLocation: fixture.installDir,
      mirrorDirectory: exactMirror,
      verifyPayload: fixturePayloadVerifier,
    }

    expect(() => helper.stageInstallPayloadTransaction({
      ...input,
      transactionRoot: join(fixture.installDir, 'unsafe-transaction'),
    })).toThrow(/separate from the stable install/i)
    expect(() => helper.stageInstallPayloadTransaction({
      ...input,
      transactionRoot: join(fixture.payloadRoot, 'unsafe-transaction'),
    })).toThrow(/separate from the source payload/i)
    expect(readTree(fixture.installDir)).toEqual(before)
  })

  it('uses robocopy mirror semantics, accepts codes through 7, and rejects code 8', () => {
    const calls: Array<{ command: string, args: string[] }> = []
    helper.robocopyMirrorDirectory('C:\\payload', 'C:\\stable', {
      label: 'target payload',
      runCommand: (command, args) => {
        calls.push({ command, args })
        return { status: 7 }
      },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('robocopy')
    expect(calls[0]?.args).toContain('/MIR')
    expect(calls[0]?.args).toContain('/COPY:DAT')
    expect(calls[0]?.args).toContain('/DCOPY:DAT')
    expect(calls[0]?.args).toContain('/XJ')
    expect(calls[0]?.args).not.toContain('/XD')
    expect(calls[0]?.args).not.toContain('locales')

    expect(() => helper.robocopyMirrorDirectory('C:\\payload', 'C:\\stable', {
      runCommand: () => ({ status: 8, stderr: 'copy failed' }),
    })).toThrow(/code 8.*copy failed/i)
  })

  it.runIf(process.platform === 'win32')('performs a real robocopy mirror with locales and obsolete deletion', () => {
    const root = mkdtempSync(join(tmpdir(), 'verstak-autoupdate-robocopy-'))
    temps.push(root)
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    mkdirSync(join(source, 'locales'), { recursive: true })
    mkdirSync(join(destination, 'locales'), { recursive: true })
    writeFileSync(join(source, 'locales', 'ru.pak'), 'new-locale', 'utf8')
    writeFileSync(join(source, 'current.bin'), 'current', 'utf8')
    writeFileSync(join(destination, 'locales', 'old.pak'), 'old-locale', 'utf8')
    writeFileSync(join(destination, 'obsolete.bin'), 'obsolete', 'utf8')

    helper.robocopyMirrorDirectory(source, destination, { label: 'test target' })

    expect(readTree(destination)).toEqual(readTree(source))
    expect(existsSync(join(destination, 'locales', 'ru.pak'))).toBe(true)
    expect(existsSync(join(destination, 'locales', 'old.pak'))).toBe(false)
    expect(existsSync(join(destination, 'obsolete.bin'))).toBe(false)
  })

  it('fails closed on parent wait timeout or a still-live Verstak process', () => {
    expect(() => helper.waitForProcessExit(42, {
      runCommand: () => ({ status: 124, stderr: 'wait timeout' }),
      maxWaitMs: 1_000,
      sleep: () => undefined,
    })).toThrow(/parent process.*timeout/i)

    let clock = 0
    expect(() => helper.waitForProcessExit(0, {
      runCommand: () => ({ status: 0, stdout: '7788\n' }),
      now: () => clock,
      sleep: (milliseconds) => { clock += milliseconds },
      maxWaitMs: 1_000,
      pollIntervalMs: 250,
      settleMs: 100,
    })).toThrow(/Verstak process is still running/i)
  })

  it.runIf(process.platform === 'win32')('runs valid PowerShell waits and proves an absent process with exit zero', () => {
    let calls = 0
    helper.waitForProcessExit(2147483647, {
      runCommand: (command, args) => {
        calls += 1
        // Preserve the production command, only isolate the queried process name.
        const isolated = args.map(value => value.replace("'Verstak'", "'Verstak-never-running-regression'"))
        return spawnSync(command, isolated, { encoding: 'utf8', windowsHide: true })
      },
      sleep: () => undefined,
      maxWaitMs: 30_000,
    })
    expect(calls).toBe(3)
  }, 30_000)

  it.runIf(process.platform === 'win32')('fails closed on a real PowerShell process-query exception', () => {
    expect(() => helper.waitForProcessExit(0, {
      runCommand: (command, args) => spawnSync(command, args.map(value => value.includes('Get-Process')
        ? `function Get-Process { throw 'injected query denied' }\n${value}` : value),
      { encoding: 'utf8', windowsHide: true }),
      sleep: () => undefined,
    })).toThrow(/Failed to prove Verstak process exit.*injected query denied/i)
  })

  it('requires two empty process observations before allowing stable payload mutation', () => {
    let clock = 0
    let queryCount = 0
    helper.waitForProcessExit(0, {
      runCommand: () => {
        queryCount += 1
        return { status: 0, stdout: '' }
      },
      now: () => clock,
      sleep: (milliseconds) => { clock += milliseconds },
      maxWaitMs: 1_000,
      pollIntervalMs: 25,
      settleMs: 100,
    })
    expect(queryCount).toBe(2)
    expect(clock).toBe(100)
  })

  it('production wiring waits and re-proves before one payload plus ownership transaction', () => {
    const serviceSource = readFileSync(new URL('../../electron/autoupdate/service.ts', import.meta.url), 'utf8')
    const helperSource = readFileSync(new URL('../../scripts/verstak-auto-update-helper.cjs', import.meta.url), 'utf8')
    expect(serviceSource).toContain('`--source-version=${app.getVersion()}`')
    expect(serviceSource).toContain('const installHelper = payloadHelperPath(root)')
    expect(helperSource).toContain('sourceVersion,\n    parentPid:')
    const waitIndex = helperSource.indexOf("waitForProcessExit(Number(opts['parent-pid'] || 0))")
    const sourceReproofIndex = helperSource.indexOf('verifyPayloadRoot(installDir, sourceVersion)', waitIndex)
    const ownershipReproofIndex = helperSource.indexOf(
      'assertStableInstallProofUnchanged({ proof: stableProof })',
      sourceReproofIndex,
    )
    const stageIndex = helperSource.indexOf(
      'payloadTransaction = stageInstallPayloadTransaction({',
      ownershipReproofIndex,
    )
    const applyIndex = helperSource.indexOf('payloadTransaction.apply()', stageIndex)
    const commitIndex = helperSource.indexOf('payloadTransaction.commit()', applyIndex)
    const launchIndex = helperSource.indexOf('launchApp(installDir)', commitIndex)
    expect(waitIndex).toBeGreaterThan(-1)
    expect(sourceReproofIndex).toBeGreaterThan(waitIndex)
    expect(ownershipReproofIndex).toBeGreaterThan(sourceReproofIndex)
    expect(stageIndex).toBeGreaterThan(ownershipReproofIndex)
    expect(applyIndex).toBeGreaterThan(stageIndex)
    expect(commitIndex).toBeGreaterThan(applyIndex)
    expect(launchIndex).toBeGreaterThan(commitIndex)
  })
})
