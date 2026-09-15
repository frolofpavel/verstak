#!/usr/bin/env node
const { spawn, spawnSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')

const APP_ASAR_MIN_BYTES = 10_000_000
const OWNER_MARKER_NAME = '.verstak-install-owner.json'
const UNINSTALL_SCRIPT_NAME = 'Uninstall Verstak.ps1'
let atomicWriteSequence = 0

// Standalone helper equivalent of acquireNativeHostOwnershipLease. A dedicated
// PowerShell process holds the same OS mutex until Node completes or rolls back.
function acquireStableOwnershipLease({ mutexName = 'Local\\Verstak.StableOwnership.v1' } = {}) {
  if (process.platform !== 'win32') return { release() {} }
  const control = fs.mkdtempSync(path.join(os.tmpdir(), 'verstak-update-owner-'))
  const ready = path.join(control, 'ready')
  const release = path.join(control, 'release')
  const done = path.join(control, 'done')
  const errorFile = path.join(control, 'error')
  const timeout = 15000
  const script = `$ErrorActionPreference = 'Stop'
$control = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(control).toString('base64')}'))
$mutexName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(mutexName).toString('base64')}'))
$mutex = [Threading.Mutex]::new($false, $mutexName)
$owned = $false
try {
  $parentProcess = [Diagnostics.Process]::GetProcessById(${process.pid})
  try { $owned = $mutex.WaitOne(${timeout}) } catch [Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) { throw 'Stable ownership mutex timeout' }
  if ($parentProcess.HasExited -or [IO.File]::Exists((Join-Path $control 'release'))) { return }
  [IO.File]::WriteAllText((Join-Path $control 'ready'), 'ACQUIRED')
  while (-not [IO.File]::Exists((Join-Path $control 'release'))) {
    if ($parentProcess.HasExited) { break }
    Start-Sleep -Milliseconds 20
  }
} catch { [IO.File]::WriteAllText((Join-Path $control 'error'), $_.Exception.Message) }
finally {
  if ($owned) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
  [IO.File]::WriteAllText((Join-Path $control 'done'), 'DONE')
}`
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore', shell: false })
  holder.on('error', () => { /* bounded handshake handles launch failures */ })
  holder.unref()
  const wait = new Int32Array(new SharedArrayBuffer(4))
  const waitUntil = predicate => {
    const deadline = Date.now() + timeout + 10000
    while (!predicate()) {
      if (Date.now() >= deadline) return false
      Atomics.wait(wait, 0, 0, 20)
    }
    return true
  }
  let released = false
  const releaseLease = () => {
    if (released) return
    released = true
    try { fs.writeFileSync(release, 'RELEASE', 'utf8') } catch { holder.kill() }
    if (!holder.pid || waitUntil(() => {
      try { return fs.readFileSync(done, 'utf8') === 'DONE' } catch { return false }
    })) {
      if (!waitUntil(() => {
        try { fs.rmSync(control, { recursive: true, force: true }); return true } catch { return false }
      })) throw new Error('Stable ownership mutex control cleanup failed')
    } else {
      holder.kill()
      throw new Error('Stable ownership mutex holder did not acknowledge release')
    }
  }
  try {
    const acquired = waitUntil(() => {
      if (fs.existsSync(done)) return true
      try { return fs.readFileSync(ready, 'utf8') === 'ACQUIRED' } catch { return false }
    })
    if (!acquired || fs.existsSync(done) || !fs.existsSync(ready)) {
      throw new Error(fs.existsSync(errorFile) ? fs.readFileSync(errorFile, 'utf8') : 'Stable ownership mutex acquisition failed')
    }
    return { release: releaseLease }
  } catch (error) { releaseLease(); throw error }
}

function holdOwnershipTransaction(stage, acquireLease = acquireStableOwnershipLease) {
  const lease = acquireLease()
  try {
    const transaction = stage()
    let finalized = false
    const finish = () => { finalized = true; lease.release() }
    return {
      ...transaction,
      ...(transaction.apply ? { apply() {
        if (finalized) throw new Error('Ownership transaction is already finalized')
        try { return transaction.apply() } catch (error) { finish(); throw error }
      } } : {}),
      commit() {
        if (finalized) throw new Error('Ownership transaction is already finalized')
        try { return transaction.commit() }
        catch (error) {
          try { transaction.rollback() }
          catch (rollbackError) { throw new Error(`${error.message}; rollback failed: ${rollbackError.message}`) }
          throw error
        } finally { finish() }
      },
      rollback() {
        if (finalized) return
        try { return transaction.rollback() } finally { finish() }
      },
    }
  } catch (error) { lease.release(); throw error }
}

function parseArgs(argv) {
  const out = {}
  for (const raw of argv) {
    const m = raw.match(/^--([^=]+)=(.*)$/)
    if (m) out[m[1]] = m[2]
    else if (raw.startsWith('--')) out[raw.slice(2)] = true
  }
  return out
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, shell: false, ...opts })
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function writeJson(file, value) {
  mkdirp(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function writeFileAtomically(file, payload, failAfterStage = false) {
  atomicWriteSequence += 1
  const temporary = `${file}.atomic-next-${process.pid}-${atomicWriteSequence}`
  let descriptor = null
  try {
    descriptor = fs.openSync(temporary, 'wx')
    fs.writeFileSync(descriptor, payload)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    if (failAfterStage) throw new Error(`injected atomic stage failure: ${file}`)
    fs.renameSync(temporary, file)
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor) } catch { /* already closed */ }
    }
    fs.rmSync(temporary, { force: true })
  }
}

function appendLog(root, name, line) {
  const file = path.join(root, 'logs', name)
  mkdirp(path.dirname(file))
  fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
}

function trace(root, event, data = {}) {
  const file = path.join(root, 'logs', 'trace.jsonl')
  mkdirp(path.dirname(file))
  fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event, ...data })}\n`, 'utf8')
}

function progress(root, version, percent, step) {
  writeJson(path.join(root, 'payloads', version, 'progress.json'), {
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    step,
    updatedAt: Date.now(),
  })
}

function extract7z(sevenZip, archivePath, outDir) {
  mkdirp(outDir)
  const result = run(sevenZip, ['x', archivePath, `-o${outDir}`, '-y', '-bso0', '-bsp0'])
  if ((result.status ?? 1) !== 0) {
    throw new Error((result.stderr || result.stdout || `7za failed (${result.status})`).trim())
  }
}

function findFileRecursive(root, fileName) {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return abs
      if (entry.isDirectory()) stack.push(abs)
    }
  }
  return null
}

function readAsarFile(archivePath, filePath) {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '')
  const fd = fs.openSync(archivePath, 'r')
  try {
    const sizeBuf = Buffer.alloc(8)
    if (fs.readSync(fd, sizeBuf, 0, 8, 0) !== 8) return null
    const headerSize = sizeBuf.readUInt32LE(4)
    const headerBuf = Buffer.alloc(headerSize)
    if (fs.readSync(fd, headerBuf, 0, headerSize, 8) !== headerSize) return null
    const headerStringLength = headerBuf.readInt32LE(4)
    const headerString = headerBuf.slice(8, 8 + headerStringLength).toString('utf8')
    let node = JSON.parse(headerString)
    for (const part of normalized.split('/')) {
      node = node.files && node.files[part]
      if (!node) return null
    }
    if (node.unpacked || typeof node.offset !== 'string' || typeof node.size !== 'number') return null
    const file = Buffer.alloc(node.size)
    if (node.size === 0) return file
    const fileOffset = 8 + headerSize + Number.parseInt(node.offset, 10)
    if (fs.readSync(fd, file, 0, node.size, fileOffset) !== node.size) return null
    return file
  } finally {
    fs.closeSync(fd)
  }
}

function verifyPayloadRoot(payloadRoot, expectedVersion) {
  const exe = path.join(payloadRoot, 'Verstak.exe')
  const appAsar = path.join(payloadRoot, 'resources', 'app.asar')
  const exeSize = fs.existsSync(exe) ? fs.statSync(exe).size : 0
  const appAsarSize = fs.existsSync(appAsar) ? fs.statSync(appAsar).size : 0
  if (exeSize <= 0) throw new Error('Повреждён payload: отсутствует Verstak.exe')
  if (appAsarSize < APP_ASAR_MIN_BYTES) throw new Error(`Повреждён payload: пустой файл resources\\app.asar (size=${appAsarSize})`)
  const pkg = readAsarFile(appAsar, 'package.json')
  if (!pkg) throw new Error('Повреждён payload: не читается package.json внутри app.asar')
  const parsed = JSON.parse(pkg.toString('utf8'))
  if (expectedVersion && parsed.version !== expectedVersion) {
    throw new Error(`Payload версии ${parsed.version}, ожидалась ${expectedVersion}`)
  }
  const main = typeof parsed.main === 'string' && parsed.main.trim() ? parsed.main.trim() : 'index.js'
  const mainFile = readAsarFile(appAsar, main)
  if (!mainFile || mainFile.length <= 0) {
    throw new Error(`Damaged payload: app entrypoint is missing inside app.asar (${main})`)
  }
  return { version: parsed.version, exeSize, appAsarSize, main }
}

function extractCommand(opts) {
  const root = path.resolve(opts.root)
  const version = opts.version
  const installer = path.resolve(opts.installer)
  const sevenZip = path.resolve(opts['seven-zip'])
  const versionDir = path.join(root, 'payloads', version)
  const tmpPayload = path.join(versionDir, 'payload.tmp')
  const finalPayload = path.join(versionDir, 'payload')
  const workDir = path.join(os.tmpdir(), `verstak-autoupdate-extract-${Date.now()}-${process.pid}`)

  appendLog(root, 'extract.log', `start version=${version} installer=${installer}`)
  trace(root, 'helper.extract.start', { version, installer, sevenZip, versionDir, tmpPayload, finalPayload, workDir })
  if (!fs.existsSync(installer)) throw new Error(`Installer not found: ${installer}`)
  if (!fs.existsSync(sevenZip)) throw new Error(`7za.exe not found: ${sevenZip}`)

  fs.rmSync(tmpPayload, { recursive: true, force: true })
  mkdirp(versionDir)
  progress(root, version, 0, 'setup')
  try {
    const setupRoot = path.join(workDir, 'setup')
    const extracted = path.join(workDir, 'payload')
    progress(root, version, 5, 'setup')
    extract7z(sevenZip, installer, setupRoot)
    progress(root, version, 20, 'payload')
    const payloadArchive = findFileRecursive(setupRoot, 'app-payload.7z')
    if (!payloadArchive) throw new Error('app-payload.7z not found in Setup archive')
    trace(root, 'helper.extract.payloadArchive', { version, payloadArchive })
    extract7z(sevenZip, payloadArchive, extracted)
    progress(root, version, 92, 'verify')
    const extractedVerified = verifyPayloadRoot(extracted, version)
    trace(root, 'helper.extract.verified.extracted', { version, extracted, extractedVerified })
    fs.cpSync(extracted, tmpPayload, { recursive: true })
    const tmpVerified = verifyPayloadRoot(tmpPayload, version)
    trace(root, 'helper.extract.verified.tmp', { version, tmpPayload, tmpVerified })
    fs.rmSync(finalPayload, { recursive: true, force: true })
    fs.renameSync(tmpPayload, finalPayload)
    const finalVerified = verifyPayloadRoot(finalPayload, version)
    trace(root, 'helper.extract.verified.final', { version, finalPayload, finalVerified })

    writeJson(path.join(versionDir, 'payload.json'), {
      version,
      payloadRoot: finalPayload,
      installer,
      appAsarSize: finalVerified.appAsarSize,
      exeSize: finalVerified.exeSize,
      createdAt: Date.now(),
    })
    writeJson(path.join(versionDir, 'verified.json'), {
      version,
      payloadRoot: finalPayload,
      appAsarSize: finalVerified.appAsarSize,
      exeSize: finalVerified.exeSize,
      verifiedAt: Date.now(),
    })
    writeJson(path.join(root, 'state.json'), {
      schemaVersion: 1,
      status: 'payload_ready',
      version,
      payloadRoot: finalPayload,
      percent: 100,
      step: 'done',
      canInstall: true,
      canRetry: true,
      updatedAt: Date.now(),
    })
    progress(root, version, 100, 'done')
    appendLog(root, 'extract.log', `ready version=${version} appAsar=${finalVerified.appAsarSize} exe=${finalVerified.exeSize} payload=${finalPayload}`)
    trace(root, 'helper.extract.ready', { version, finalPayload, finalVerified })
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(tmpPayload, { recursive: true, force: true })
  }
}

function sleepMilliseconds(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function waitForProcessExit(parentPid, {
  runCommand = run,
  now = Date.now,
  sleep = sleepMilliseconds,
  maxWaitMs = 90_000,
  pollIntervalMs = 500,
  settleMs = 1_500,
} = {}) {
  if (parentPid) {
    const safeParentPid = Number(parentPid) || 0
    const waitCommand = [
      "$ErrorActionPreference = 'Stop'",
      'try {',
      `  $process = Get-Process -ErrorAction Stop | Where-Object { $_.Id -eq ${safeParentPid} }`,
      '  if ($null -ne $process) {',
      `    try { Wait-Process -Id ${safeParentPid} -Timeout 180 -ErrorAction Stop }`,
      '    catch {',
      `      $remaining = Get-Process -ErrorAction Stop | Where-Object { $_.Id -eq ${safeParentPid} }`,
      "      if ($null -ne $remaining) { [Console]::Error.Write($_.Exception.Message); exit 124 }",
      '    }',
      '  }',
      '  exit 0',
      '} catch { [Console]::Error.Write($_.Exception.Message); exit 1 }',
    ].join('\n')
    const waitResult = runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      waitCommand,
    ])
    const waitCode = Number.isInteger(waitResult.status) ? waitResult.status : 1
    if (waitCode !== 0) {
      const detail = String(waitResult.stderr || waitResult.stdout || `exit code ${waitCode}`).trim()
      const reason = waitCode === 124 ? 'timeout' : `failed with code ${waitCode}`
      throw new Error(`Parent process exit ${reason}: ${detail}`)
    }
  }

  const processQuery = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -eq 'Verstak' } | Select-Object -First 1 -ExpandProperty Id",
    '  exit 0',
    '} catch { [Console]::Error.Write($_.Exception.Message); exit 1 }',
  ].join('\n')
  const queryRunningProcess = () => {
    const result = runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', processQuery])
    const code = Number.isInteger(result.status) ? result.status : 1
    if (code !== 0) {
      throw new Error(`Failed to prove Verstak process exit (code ${code}): ${String(result.stderr || result.stdout || '').trim()}`)
    }
    return String(result.stdout || '').trim()
  }
  const deadline = now() + maxWaitMs
  while (now() < deadline) {
    const runningPid = queryRunningProcess()
    if (!runningPid) {
      sleep(settleMs)
      if (!queryRunningProcess()) return
    }
    const remaining = deadline - now()
    if (remaining > 0) sleep(Math.min(pollIntervalMs, remaining))
  }
  throw new Error('Verstak process is still running after the update wait timeout')
}

function robocopyMirrorDirectory(sourceDir, destinationDir, {
  runCommand = run,
  label = 'directory tree',
} = {}) {
  const result = runCommand('robocopy', [
    sourceDir,
    destinationDir,
    '/MIR',
    '/COPY:DAT',
    '/DCOPY:DAT',
    '/R:2',
    '/W:1',
    '/XJ',
    '/NFL',
    '/NDL',
    '/NJH',
    '/NJS',
    '/NP',
  ])
  const code = Number.isInteger(result.status) ? result.status : 16
  if (code >= 8) {
    throw new Error(`${label} robocopy failed with code ${code}: ${(result.stderr || result.stdout || '').trim()}`)
  }
}

function launchApp(installDir) {
  const exe = path.join(installDir, 'Verstak.exe')
  if (!fs.existsSync(exe)) throw new Error('Verstak.exe not found after update')
  const ps = `Start-Process -FilePath '${exe.replace(/'/g, "''")}'`
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps])
  if ((result.status ?? 1) !== 0) throw new Error('Failed to restart Verstak')
}

function normalizeWindowsPath(value) {
  const normalized = path.win32.normalize(String(value || '').trim())
  return normalized.length > 3 ? normalized.replace(/\\+$/, '') : normalized
}

function sameWindowsPath(left, right) {
  return normalizeWindowsPath(left).toLocaleLowerCase('en-US')
    === normalizeWindowsPath(right).toLocaleLowerCase('en-US')
}

function buildOwnerMarker(version, installDir) {
  const normalizedInstallDir = normalizeWindowsPath(installDir)
  return {
    schemaVersion: 1,
    product: 'Verstak',
    appVersion: version,
    installDir: normalizedInstallDir,
    executablePath: normalizeWindowsPath(path.win32.join(normalizedInstallDir, 'Verstak.exe')),
    ownsNativeHostRegistration: true,
  }
}

function markerMatchesInstall(marker, installDir, expectedVersion) {
  if (!marker || typeof marker !== 'object') return false
  const expected = buildOwnerMarker(expectedVersion || marker.appVersion, installDir)
  return marker.schemaVersion === 1
    && marker.product === 'Verstak'
    && typeof marker.appVersion === 'string'
    && marker.appVersion.length > 0
    && (!expectedVersion || marker.appVersion === expectedVersion)
    && marker.ownsNativeHostRegistration === true
    && typeof marker.installDir === 'string'
    && typeof marker.executablePath === 'string'
    && sameWindowsPath(marker.installDir, expected.installDir)
    && sameWindowsPath(marker.executablePath, expected.executablePath)
}

function psQuote(value) {
  return String(value).replace(/'/g, "''")
}

function buildSafeUninstallScript(installDir, env = process.env) {
  const desktop = path.join(os.homedir(), 'Desktop', 'Verstak.lnk')
  const startMenu = path.join(env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Verstak.lnk')
  return `# Verstak uninstall helper
$ErrorActionPreference = 'Stop'
$dir = '${psQuote(installDir)}'
$ownedNativeHostManifest = [IO.Path]::GetFullPath((Join-Path $dir 'resources\\browser-bridge\\ru.verstak.browser_bridge.json'))
$shortcuts = @(
  '${psQuote(desktop)}',
  '${psQuote(startMenu)}'
)
# EXT-B1 Connected Eyes: compare-and-delete. An old uninstaller must not remove
# a registry value already transferred to a newer/different stable install.
$nativeHostKeys = @(
  [PSCustomObject]@{ Key = 'HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\ru.verstak.browser_bridge'; SubKey = 'Software\\Google\\Chrome\\NativeMessagingHosts\\ru.verstak.browser_bridge' },
  [PSCustomObject]@{ Key = 'HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\ru.verstak.browser_bridge'; SubKey = 'Software\\Microsoft\\Edge\\NativeMessagingHosts\\ru.verstak.browser_bridge' }
)

function Test-VerstakNativeHostPathEqual {
  param([string]$Left, [string]$Right)
  if (-not $Left -or -not $Right) { return $false }
  try {
    return [string]::Equals([IO.Path]::GetFullPath($Left), [IO.Path]::GetFullPath($Right), [StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

# These function guards let the production-shaped test harness replace only
# the registry transport. Production always uses one writable parent key for
# compare + delete and one writable child key for compare + restore + readback.
if (-not (Get-Command -Name Get-VerstakNativeHostSnapshot -CommandType Function -ErrorAction SilentlyContinue)) {
  function Get-VerstakNativeHostSnapshot {
    param([string]$SubKeyPath)
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKeyPath, $false)
    if ($null -eq $key) { return [PSCustomObject]@{ State = 'absent'; Value = $null } }
    try {
      $value = $key.GetValue($null, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if ($null -eq $value) { return [PSCustomObject]@{ State = 'absent'; Value = $null } }
      return [PSCustomObject]@{ State = 'present'; Value = [string]$value }
    } finally {
      $key.Dispose()
    }
  }
}

if (-not (Get-Command -Name Remove-VerstakNativeHostIfOwned -CommandType Function -ErrorAction SilentlyContinue)) {
  function Remove-VerstakNativeHostIfOwned {
    param([string]$SubKeyPath, [string]$ExpectedValue)
    $operation = 'VERSTAK_NATIVE_HOST_DELETE_IF_MATCH_V2'
    $slash = $SubKeyPath.LastIndexOf('\\')
    if ($slash -lt 1) { throw 'Native Host registry key has no parent' }
    $parentPath = $SubKeyPath.Substring(0, $slash)
    $leaf = $SubKeyPath.Substring($slash + 1)
    $parent = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($parentPath, $true)
    if ($null -eq $parent) { return [PSCustomObject]@{ State = 'absent'; Value = $null } }
    try {
      $currentKey = $parent.OpenSubKey($leaf, $false)
      if ($null -eq $currentKey) { return [PSCustomObject]@{ State = 'absent'; Value = $null } }
      try {
        $current = $currentKey.GetValue($null, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      } finally {
        $currentKey.Dispose()
      }
      if ($null -eq $current) { return [PSCustomObject]@{ State = 'absent'; Value = $null } }
      if (-not (Test-VerstakNativeHostPathEqual ([string]$current) $ExpectedValue)) {
        return [PSCustomObject]@{ State = 'successor'; Value = [string]$current }
      }
      # Compare and delete are performed through the same writable parent
      # RegistryKey. No provider-level Test-Path/Get-Item/Remove-Item split.
      $parent.DeleteSubKeyTree($leaf, $false)
      $afterKey = $parent.OpenSubKey($leaf, $false)
      if ($null -eq $afterKey) { return [PSCustomObject]@{ State = 'deleted'; Value = $null } }
      try {
        $after = $afterKey.GetValue($null, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      } finally {
        $afterKey.Dispose()
      }
      if ($null -ne $after -and -not (Test-VerstakNativeHostPathEqual ([string]$after) $ExpectedValue)) {
        return [PSCustomObject]@{ State = 'successor'; Value = [string]$after }
      }
      throw "Native Host registry key still exists after delete: $SubKeyPath"
    } finally {
      $parent.Dispose()
    }
  }
}

if (-not (Get-Command -Name Restore-VerstakNativeHostIfUnchanged -CommandType Function -ErrorAction SilentlyContinue)) {
  function Restore-VerstakNativeHostIfUnchanged {
    param([string]$SubKeyPath, [string]$ExpectedState, [string]$ExpectedValue, [string]$PreviousValue)
    $operation = 'VERSTAK_NATIVE_HOST_RESTORE_IF_UNCHANGED_V2'
    $slash = $SubKeyPath.LastIndexOf('\\')
    if ($slash -lt 1) { throw 'Native Host registry key has no parent' }
    $parentPath = $SubKeyPath.Substring(0, $slash)
    $leaf = $SubKeyPath.Substring($slash + 1)
    $parent = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($parentPath, $true)
    if ($null -eq $parent -and $ExpectedState -eq 'absent') {
      $parent = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($parentPath)
    }
    if ($null -eq $parent) { return [PSCustomObject]@{ State = 'successor'; Value = $null } }
    try {
      # Open the child writable once. The expected-current comparison, write,
      # flush and readback all happen on this same RegistryKey handle.
      $currentKey = $parent.OpenSubKey($leaf, $true)
      $current = if ($null -eq $currentKey) {
        $null
      } else {
        $currentKey.GetValue($null, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      }
      $matchesExpected = ($ExpectedState -eq 'absent' -and $null -eq $current) -or (
        $ExpectedState -eq 'present' -and $null -ne $current -and (Test-VerstakNativeHostPathEqual ([string]$current) $ExpectedValue)
      )
      if (-not $matchesExpected) {
        if ($null -ne $currentKey) { $currentKey.Dispose() }
        $successorValue = if ($null -eq $current) { $null } else { [string]$current }
        return [PSCustomObject]@{ State = 'successor'; Value = $successorValue }
      }
      if ($null -eq $currentKey) {
        $currentKey = $parent.CreateSubKey($leaf)
        $racedValue = $currentKey.GetValue($null, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -ne $racedValue) {
          $currentKey.Dispose()
          return [PSCustomObject]@{ State = 'successor'; Value = [string]$racedValue }
        }
      }
      try {
        $currentKey.SetValue($null, $PreviousValue, [Microsoft.Win32.RegistryValueKind]::String)
        $currentKey.Flush()
        $restored = $currentKey.GetValue($null, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -eq $restored -or -not (Test-VerstakNativeHostPathEqual ([string]$restored) $PreviousValue)) {
          throw "Native Host registry rollback readback mismatch: $SubKeyPath"
        }
      } finally {
        $currentKey.Dispose()
      }
      return [PSCustomObject]@{ State = 'restored'; Value = $PreviousValue }
    } finally {
      $parent.Dispose()
    }
  }
}


if (-not (Get-Command -Name Get-VerstakInstallLocation -CommandType Function -ErrorAction SilentlyContinue)) {
  function Get-VerstakInstallLocation {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ru.verstak.ide', $false)
    if ($null -eq $key) { return $null }
    try {
      return $key.GetValue('InstallLocation', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    } finally { $key.Dispose() }
  }
}
if (-not (Get-Command -Name Remove-VerstakInstallRegistrationIfOwned -CommandType Function -ErrorAction SilentlyContinue)) {
  function Remove-VerstakInstallRegistrationIfOwned {
    param([string]$ExpectedDir)
    $parent = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', $true)
    if ($null -eq $parent) { return $false }
    try {
      $key = $parent.OpenSubKey('ru.verstak.ide', $false)
      if ($null -eq $key) { return $false }
      try {
        $current = $key.GetValue('InstallLocation', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      } finally { $key.Dispose() }
      if (-not [string]::Equals([string]$current, $ExpectedDir, [StringComparison]::OrdinalIgnoreCase)) { return $false }
      $parent.DeleteSubKeyTree('ru.verstak.ide', $false)
      $after = $parent.OpenSubKey('ru.verstak.ide', $false)
      if ($null -ne $after) {
        $after.Dispose()
        throw 'Stable uninstall registry deletion readback mismatch'
      }
      return $true
    } finally { $parent.Dispose() }
  }
}
$ownershipMutex = [Threading.Mutex]::new($false, 'Local\\Verstak.StableOwnership.v1')
$ownershipLockAcquired = $false
try {
  try { $ownershipLockAcquired = $ownershipMutex.WaitOne(15000) }
  catch [Threading.AbandonedMutexException] { $ownershipLockAcquired = $true }
  if (-not $ownershipLockAcquired) { throw 'Stable ownership mutex timeout' }
  $currentInstallLocation = Get-VerstakInstallLocation
  if (-not [string]::Equals([string]$currentInstallLocation, $dir, [StringComparison]::OrdinalIgnoreCase)) { return }

$nativeHostOwnership = @()
$nativeHostPreflightErrors = @()
foreach ($keySpec in $nativeHostKeys) {
  try {
    $snapshot = Get-VerstakNativeHostSnapshot $keySpec.SubKey
    if ($snapshot.State -eq 'present' -and (Test-VerstakNativeHostPathEqual ([string]$snapshot.Value) $ownedNativeHostManifest)) {
      $nativeHostOwnership += [PSCustomObject]@{ Key = $keySpec.Key; SubKey = $keySpec.SubKey; Value = [string]$snapshot.Value }
    }
  } catch {
    $nativeHostPreflightErrors += "$($keySpec.Key): $($_.Exception.Message)"
  }
}
if ($nativeHostPreflightErrors.Count -gt 0) {
  throw "Native Host cleanup preflight failed: $($nativeHostPreflightErrors -join '; ')"
}

$deletedNativeHostKeys = @()
try {
  foreach ($entry in $nativeHostOwnership) {
    $deleteResult = Remove-VerstakNativeHostIfOwned $entry.SubKey $entry.Value
    if ($deleteResult.State -eq 'deleted') {
      $deletedNativeHostKeys += $entry
    } elseif ($deleteResult.State -ne 'absent' -and $deleteResult.State -ne 'successor') {
      throw "Native Host registry key still exists after delete: $($entry.Key)"
    }
  }

  # File cleanup is part of the same Native Host transaction. If it fails while
  # the owned manifest still exists, restore registry ownership with CAS.
  foreach ($lnk in $shortcuts) {
    if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force -ErrorAction Stop }
  }
  if (Test-Path -LiteralPath $dir) {
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop
  }
} catch {
  $nativeHostCleanupFailure = $_.Exception.Message
  $nativeHostRollbackErrors = @()
  if (-not (Test-Path -LiteralPath $ownedNativeHostManifest)) {
    $nativeHostRollbackErrors += 'owned Native Host manifest is missing; registry rollback would be unsafe'
  } else {
    foreach ($entry in $deletedNativeHostKeys) {
      try {
        $restoreResult = Restore-VerstakNativeHostIfUnchanged $entry.SubKey 'absent' $null $entry.Value
        if ($restoreResult.State -ne 'restored' -and $restoreResult.State -ne 'already' -and $restoreResult.State -ne 'successor') {
          throw "Native Host registry rollback readback mismatch: $($entry.Key)"
        }
      } catch {
        $nativeHostRollbackErrors += "$($entry.Key): $($_.Exception.Message)"
      }
    }
  }
  if ($nativeHostRollbackErrors.Count -gt 0) {
    throw "Native Host cleanup failed: $nativeHostCleanupFailure; rollback failed: $($nativeHostRollbackErrors -join '; ')"
  }
  throw "Native Host cleanup failed: $nativeHostCleanupFailure; registry rollback completed"
}

Remove-VerstakInstallRegistrationIfOwned $dir | Out-Null
} finally {
  if ($ownershipLockAcquired) { $ownershipMutex.ReleaseMutex() }
  $ownershipMutex.Dispose()
}
`
}

function readRegisteredInstallLocation() {
  const command = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $v = (Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ru.verstak.ide' -Name InstallLocation -ErrorAction Stop).InstallLocation; [Console]::Write([string]$v)"
  const result = run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ])
  if ((result.status ?? 1) !== 0) {
    throw new Error(`Stable install registry proof failed: ${String(result.stderr || result.stdout || 'query failed').trim()}`)
  }
  const value = String(result.stdout || '').trim()
  if (!value) throw new Error('Stable install registry proof is empty')
  return value
}

function captureStableInstallProof({
  installDir,
  sourceVersion,
  registeredInstallLocation,
  env = process.env,
}) {
  if (env.PORTABLE_EXECUTABLE_FILE || env.PORTABLE_EXECUTABLE_DIR) {
    throw new Error('Portable build cannot migrate stable Native Host ownership')
  }
  if (!String(sourceVersion || '').trim()) {
    throw new Error('source-version is required for stable ownership migration')
  }
  const normalizedInstallDir = normalizeWindowsPath(installDir)
  const registered = registeredInstallLocation === undefined
    ? readRegisteredInstallLocation()
    : registeredInstallLocation
  if (!sameWindowsPath(registered, normalizedInstallDir)) {
    throw new Error('Auto-update installDir does not match stable InstallLocation')
  }
  const markerPath = path.join(installDir, OWNER_MARKER_NAME)
  const uninstallPath = path.join(installDir, UNINSTALL_SCRIPT_NAME)
  if (!fs.existsSync(path.join(installDir, 'Verstak.exe'))) {
    throw new Error('Stable install proof is missing Verstak.exe')
  }
  const markerBytes = fs.existsSync(markerPath) ? fs.readFileSync(markerPath) : null
  const uninstallBytes = fs.existsSync(uninstallPath) ? fs.readFileSync(uninstallPath) : null
  if (!uninstallBytes) throw new Error('Stable install proof is missing its uninstaller')
  if (markerBytes) {
    let marker
    try { marker = JSON.parse(markerBytes.toString('utf8')) } catch { marker = null }
    // An invalid-present marker is evidence of tampering/corruption, not a
    // legacy install eligible for automatic migration.
    if (!markerMatchesInstall(marker, normalizedInstallDir, sourceVersion)) {
      throw new Error('Existing Native Host owner marker is invalid for this stable install')
    }
  }
  return {
    installDir,
    sourceVersion,
    registeredInstallLocation: registered,
    markerPath,
    uninstallPath,
    markerBytes,
    uninstallBytes,
  }
}

function assertStableInstallProofUnchanged({
  proof,
  registeredInstallLocation,
  env = process.env,
}) {
  if (env.PORTABLE_EXECUTABLE_FILE || env.PORTABLE_EXECUTABLE_DIR) {
    throw new Error('Portable build cannot migrate stable Native Host ownership')
  }
  const registered = registeredInstallLocation === undefined
    ? readRegisteredInstallLocation()
    : registeredInstallLocation
  if (!sameWindowsPath(registered, proof.registeredInstallLocation)) {
    throw new Error('Stable InstallLocation changed before ownership migration')
  }
  const markerNow = fs.existsSync(proof.markerPath) ? fs.readFileSync(proof.markerPath) : null
  const uninstallNow = fs.existsSync(proof.uninstallPath) ? fs.readFileSync(proof.uninstallPath) : null
  if (!Buffer.isBuffer(uninstallNow) || !uninstallNow.equals(proof.uninstallBytes)) {
    throw new Error('Stable uninstaller changed before ownership migration')
  }
  if (
    (proof.markerBytes === null && markerNow !== null)
    || (proof.markerBytes !== null && (!Buffer.isBuffer(markerNow) || !markerNow.equals(proof.markerBytes)))
  ) throw new Error('Native Host owner marker changed before ownership migration')
  return registered
}

function restoreFileSnapshot(file, bytes) {
  if (bytes === null) fs.rmSync(file, { force: true })
  else writeFileAtomically(file, bytes)
}

function stageStableOwnershipArtifacts(input) {
  return holdOwnershipTransaction(() => stageStableOwnershipArtifactsLocked(input), input.acquireOwnershipLease)
}

function stageStableOwnershipArtifactsLocked({
  proof,
  targetVersion,
  registeredInstallLocation,
  env = process.env,
  failAfterWrite,
  failAfterStage,
}) {
  assertStableInstallProofUnchanged({ proof, registeredInstallLocation, env })

  let active = true
  let markerWritten = false
  let uninstallerWritten = false
  const markerJson = `${JSON.stringify(buildOwnerMarker(targetVersion, proof.installDir), null, 2)}\n`
  const markerPayload = Buffer.from(markerJson, 'utf8')
  const uninstallScript = buildSafeUninstallScript(proof.installDir, env)
  const uninstallerPayload = Buffer.from(uninstallScript, 'utf8')
  const rollback = () => {
    if (!active) return
    active = false
    const errors = []
    const writtenArtifacts = [
      ...(markerWritten ? [{
        file: proof.markerPath,
        writtenPayload: markerPayload,
        previousBytes: proof.markerBytes,
        label: 'Native Host owner marker',
      }] : []),
      ...(uninstallerWritten ? [{
        file: proof.uninstallPath,
        writtenPayload: uninstallerPayload,
        previousBytes: proof.uninstallBytes,
        label: 'Stable uninstaller',
      }] : []),
    ]
    // Check the whole pair before restoring either file. If a successor has
    // changed one artifact, this older updater no longer owns the transaction
    // and must preserve the complete successor state.
    for (const { file, writtenPayload, label } of writtenArtifacts) {
      const current = fs.existsSync(file) ? fs.readFileSync(file) : null
      if (!Buffer.isBuffer(current) || !current.equals(writtenPayload)) {
        errors.push(`${label} changed after ownership migration; successor bytes preserved`)
      }
    }
    if (errors.length > 0) throw new Error(errors.join('; '))
    const restoreOwnedArtifact = ({ file, previousBytes, label }) => {
      try {
        restoreFileSnapshot(file, previousBytes)
        const restored = fs.existsSync(file) ? fs.readFileSync(file) : null
        const restoredExactly = previousBytes === null
          ? restored === null
          : Buffer.isBuffer(restored) && restored.equals(previousBytes)
        if (!restoredExactly) errors.push(`${label} rollback readback mismatch`)
      } catch (error) {
        errors.push(`${label} rollback failed: ${error && error.message ? error.message : String(error)}`)
      }
    }
    for (const artifact of [...writtenArtifacts].reverse()) restoreOwnedArtifact(artifact)
    if (errors.length > 0) throw new Error(errors.join('; '))
  }
  try {
    writeFileAtomically(proof.markerPath, markerPayload, failAfterStage === 'marker')
    markerWritten = true
    if (failAfterWrite === 'marker') throw new Error('injected ownership marker failure')
    writeFileAtomically(proof.uninstallPath, uninstallerPayload, failAfterStage === 'uninstaller')
    uninstallerWritten = true
    if (failAfterWrite === 'uninstaller') throw new Error('injected uninstaller failure')
    const markerReadback = JSON.parse(fs.readFileSync(proof.markerPath, 'utf8'))
    if (!markerMatchesInstall(markerReadback, proof.installDir, targetVersion)) {
      throw new Error('Native Host owner marker readback failed')
    }
    if (fs.readFileSync(proof.uninstallPath, 'utf8') !== uninstallScript) {
      throw new Error('Safe uninstaller readback failed')
    }
    return {
      marker: markerReadback,
      commit() { active = false },
      rollback,
    }
  } catch (error) {
    try {
      rollback()
    } catch (rollbackError) {
      throw new Error(
        `${error && error.message ? error.message : String(error)}; rollback failed: ${rollbackError && rollbackError.message ? rollbackError.message : String(rollbackError)}`,
      )
    }
    throw error
  }
}

function snapshotDirectoryTree(root) {
  const resolvedRoot = path.resolve(root)
  if (!fs.existsSync(resolvedRoot) || !fs.lstatSync(resolvedRoot).isDirectory()) {
    throw new Error(`Directory snapshot root is missing: ${resolvedRoot}`)
  }
  const snapshot = []
  const visit = (directory) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en-US'))
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const relativePath = path.relative(resolvedRoot, absolute).replace(/\\/g, '/')
      if (entry.isDirectory()) {
        snapshot.push({ path: `${relativePath}/`, type: 'directory' })
        visit(absolute)
      } else if (entry.isFile()) {
        const hash = crypto.createHash('sha256')
        const handle = fs.openSync(absolute, 'r')
        let size = 0
        try {
          const chunk = Buffer.allocUnsafe(1024 * 1024)
          let bytesRead = 0
          do {
            bytesRead = fs.readSync(handle, chunk, 0, chunk.length, null)
            if (bytesRead > 0) {
              hash.update(chunk.subarray(0, bytesRead))
              size += bytesRead
            }
          } while (bytesRead > 0)
        } finally {
          fs.closeSync(handle)
        }
        snapshot.push({
          path: relativePath,
          type: 'file',
          size,
          sha256: hash.digest('hex'),
        })
      } else {
        throw new Error(`Unsupported reparse/link entry in update tree: ${absolute}`)
      }
    }
  }
  visit(resolvedRoot)
  return snapshot
}

function treeSnapshotsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function assertTreeSnapshot(root, expected, message) {
  const actual = snapshotDirectoryTree(root)
  if (!treeSnapshotsEqual(actual, expected)) throw new Error(message)
  return actual
}

function pathsOverlap(left, right) {
  const resolvedLeft = path.resolve(left)
  const resolvedRight = path.resolve(right)
  const leftToRight = path.relative(resolvedLeft, resolvedRight)
  const rightToLeft = path.relative(resolvedRight, resolvedLeft)
  const inside = (relativePath) => relativePath === ''
    || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  return inside(leftToRight) || inside(rightToLeft)
}

function writeTargetOwnershipArtifacts(targetRoot, installDir, targetVersion, env) {
  const markerPath = path.join(targetRoot, OWNER_MARKER_NAME)
  const uninstallPath = path.join(targetRoot, UNINSTALL_SCRIPT_NAME)
  const marker = buildOwnerMarker(targetVersion, installDir)
  const uninstallScript = buildSafeUninstallScript(installDir, env)
  writeFileAtomically(markerPath, Buffer.from(`${JSON.stringify(marker, null, 2)}\n`, 'utf8'))
  writeFileAtomically(uninstallPath, Buffer.from(uninstallScript, 'utf8'))

  let markerReadback = null
  try { markerReadback = JSON.parse(fs.readFileSync(markerPath, 'utf8')) } catch { markerReadback = null }
  if (!markerMatchesInstall(markerReadback, installDir, targetVersion)) {
    throw new Error('Target Native Host owner marker readback failed')
  }
  if (fs.readFileSync(uninstallPath, 'utf8') !== uninstallScript) {
    throw new Error('Target safe uninstaller readback failed')
  }
  return { marker: markerReadback, uninstallScript }
}

function stageInstallPayloadTransaction(input) {
  return holdOwnershipTransaction(() => stageInstallPayloadTransactionLocked(input), input.acquireOwnershipLease)
}

function stageInstallPayloadTransactionLocked({
  payloadRoot,
  installDir,
  targetVersion,
  transactionRoot,
  proof,
  registeredInstallLocation,
  env = process.env,
  mirrorDirectory = (sourceDir, destinationDir, label) => robocopyMirrorDirectory(
    sourceDir,
    destinationDir,
    { label },
  ),
  verifyPayload = verifyPayloadRoot,
}) {
  const resolvedPayloadRoot = path.resolve(payloadRoot)
  const resolvedInstallDir = path.resolve(installDir)
  const resolvedTransactionRoot = path.resolve(transactionRoot)
  if (pathsOverlap(resolvedTransactionRoot, resolvedInstallDir)) {
    throw new Error('Payload transaction root must be separate from the stable install')
  }
  if (pathsOverlap(resolvedTransactionRoot, resolvedPayloadRoot)) {
    throw new Error('Payload transaction root must be separate from the source payload')
  }
  assertStableInstallProofUnchanged({ proof, registeredInstallLocation, env })

  const targetRoot = path.join(resolvedTransactionRoot, 'target')
  const backupRoot = path.join(resolvedTransactionRoot, 'backup')
  const cleanup = () => {
    fs.rmSync(targetRoot, { recursive: true, force: true })
    fs.rmSync(backupRoot, { recursive: true, force: true })
    try { fs.rmdirSync(resolvedTransactionRoot) } catch { /* keep non-empty diagnostics */ }
  }
  fs.rmSync(targetRoot, { recursive: true, force: true })
  fs.rmSync(backupRoot, { recursive: true, force: true })
  mkdirp(resolvedTransactionRoot)

  let sourceSnapshot
  let targetSnapshot
  try {
    const payloadSnapshot = snapshotDirectoryTree(resolvedPayloadRoot)
    mirrorDirectory(resolvedPayloadRoot, targetRoot, 'target staging')
    assertTreeSnapshot(resolvedPayloadRoot, payloadSnapshot, 'Source payload changed during target staging')
    assertTreeSnapshot(targetRoot, payloadSnapshot, 'Target staging readback mismatch')
    verifyPayload(targetRoot, targetVersion)
    writeTargetOwnershipArtifacts(targetRoot, resolvedInstallDir, targetVersion, env)
    targetSnapshot = snapshotDirectoryTree(targetRoot)

    sourceSnapshot = snapshotDirectoryTree(resolvedInstallDir)
    mirrorDirectory(resolvedInstallDir, backupRoot, 'source backup')
    assertTreeSnapshot(resolvedInstallDir, sourceSnapshot, 'Source tree changed during backup')
    assertTreeSnapshot(backupRoot, sourceSnapshot, 'Full backup readback mismatch')
  } catch (error) {
    cleanup()
    throw error
  }

  let state = 'staged'
  const restoreBackup = () => {
    assertTreeSnapshot(backupRoot, sourceSnapshot, 'Backup changed before rollback')
    mirrorDirectory(backupRoot, resolvedInstallDir, 'source rollback')
    verifyPayload(resolvedInstallDir, proof.sourceVersion)
    assertTreeSnapshot(resolvedInstallDir, sourceSnapshot, 'Payload rollback readback mismatch')
    state = 'rolled_back'
    cleanup()
  }

  const rollback = () => {
    if (state === 'committed' || state === 'rolled_back' || state === 'rollback_failed' || state === 'aborted') return
    if (state === 'staged') {
      state = 'aborted'
      cleanup()
      return
    }
    if (state !== 'applied') throw new Error(`Payload transaction cannot roll back from state ${state}`)
    assertTreeSnapshot(
      resolvedInstallDir,
      targetSnapshot,
      'Installed target changed after apply; successor bytes preserved',
    )
    restoreBackup()
  }

  const apply = () => {
    if (state !== 'staged') throw new Error(`Payload transaction cannot apply from state ${state}`)
    try {
      assertTreeSnapshot(resolvedInstallDir, sourceSnapshot, 'Source tree changed before apply')
    } catch (error) {
      state = 'aborted'
      cleanup()
      throw error
    }

    let mutationStarted = false
    try {
      mutationStarted = true
      mirrorDirectory(targetRoot, resolvedInstallDir, 'target payload')
      const installedVerified = verifyPayload(resolvedInstallDir, targetVersion)
      assertTreeSnapshot(resolvedInstallDir, targetSnapshot, 'Target tree readback mismatch')
      state = 'applied'
      return installedVerified
    } catch (error) {
      if (!mutationStarted) throw error
      try {
        restoreBackup()
      } catch (rollbackError) {
        state = 'rollback_failed'
        throw new Error(
          `${error && error.message ? error.message : String(error)}; rollback failed: ${rollbackError && rollbackError.message ? rollbackError.message : String(rollbackError)}`,
        )
      }
      throw error
    }
  }

  const commit = () => {
    if (state !== 'applied') throw new Error(`Payload transaction cannot commit from state ${state}`)
    verifyPayload(resolvedInstallDir, targetVersion)
    assertTreeSnapshot(resolvedInstallDir, targetSnapshot, 'Target tree changed before commit')
    state = 'committed'
    cleanup()
  }

  return { apply, commit, rollback }
}

function installCommand(opts) {
  const root = path.resolve(opts.root)
  const version = opts.version
  const payloadRoot = path.resolve(opts.payload)
  const installDir = path.resolve(opts['install-dir'])
  const installDirForVersion = path.join(root, 'install', version)
  const logFile = path.join(installDirForVersion, 'install.log')
  const sourceVersion = String(opts['source-version'] || '').trim()
  mkdirp(installDirForVersion)
  const log = (line) => {
    appendLog(root, 'install.log', line)
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  }

  writeJson(path.join(installDirForVersion, 'install-plan.json'), {
    version,
    payloadRoot,
    installDir,
    sourceVersion,
    parentPid: Number(opts['parent-pid'] || 0),
    startedAt: Date.now(),
  })

  let payloadTransaction = null
  try {
    log(`start version=${version} payload=${payloadRoot} installDir=${installDir}`)
    trace(root, 'helper.install.start', { version, payloadRoot, installDir })
    const payloadVerified = verifyPayloadRoot(payloadRoot, version)
    trace(root, 'helper.install.payload_verified', { version, payloadRoot, payloadVerified })
    if (!sourceVersion) throw new Error('source-version is required for stable ownership migration')
    const installedBefore = verifyPayloadRoot(installDir, sourceVersion)
    const stableProof = captureStableInstallProof({ installDir, sourceVersion })
    trace(root, 'helper.install.stable_proof', {
      sourceVersion,
      installedVersion: installedBefore.version,
      markerPresent: stableProof.markerBytes !== null,
    })
    waitForProcessExit(Number(opts['parent-pid'] || 0))
    // A newer updater may have won while this helper waited for the app to
    // exit. Re-prove both the installed version and ownership preimages before
    // this process is allowed to copy anything into the stable directory.
    verifyPayloadRoot(installDir, sourceVersion)
    assertStableInstallProofUnchanged({ proof: stableProof })
    payloadTransaction = stageInstallPayloadTransaction({
      payloadRoot,
      installDir,
      targetVersion: version,
      transactionRoot: path.join(installDirForVersion, 'payload-transaction'),
      proof: stableProof,
    })
    trace(root, 'helper.install.transaction_staged', { version, installDir })
    const installedVerified = payloadTransaction.apply()
    trace(root, 'helper.install.installed_verified', { version, installDir, installedVerified })
    trace(root, 'helper.install.ownership_migrated', { version, installDir })
    // Payload bytes and matching ownership artifacts cross one verified commit
    // boundary. A later restart failure leaves a complete target tree, never a
    // source/target mixture or mismatched uninstaller.
    payloadTransaction.commit()
    payloadTransaction = null
    launchApp(installDir)
    writeJson(path.join(installDirForVersion, 'install.done'), { version, installedAt: Date.now() })
    fs.rmSync(path.join(root, 'downloads', version), { recursive: true, force: true })
    fs.rmSync(path.join(root, 'payloads', version), { recursive: true, force: true })
    writeJson(path.join(root, 'state.json'), {
      schemaVersion: 1,
      status: 'complete',
      version,
      installedVersion: version,
      percent: 100,
      step: 'done',
      updatedAt: Date.now(),
    })
    log(`complete version=${version}`)
    trace(root, 'helper.install.complete', { version })
  } catch (err) {
    let rollbackFailure = null
    try { payloadTransaction?.rollback() } catch (rollbackError) {
      rollbackFailure = rollbackError && rollbackError.message ? rollbackError.message : String(rollbackError)
    }
    const originalMessage = err && err.message ? err.message : String(err)
    const message = rollbackFailure
      ? `${originalMessage}; payload rollback failed: ${rollbackFailure}`
      : originalMessage
    writeJson(path.join(installDirForVersion, 'install.failed'), { version, error: message, failedAt: Date.now() })
    writeJson(path.join(root, 'state.json'), {
      schemaVersion: 1,
      status: 'failed_recoverable',
      version,
      payloadRoot,
      error: message,
      errorCode: 'install-failed',
      canRetry: true,
      canInstall: true,
      updatedAt: Date.now(),
    })
    log(`failed version=${version} error=${message}`)
    trace(root, 'helper.install.failed', { version, payloadRoot, installDir, error: message })
    process.exitCode = 1
  }
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2))
  try {
    if (opts.command === 'extract') extractCommand(opts)
    else if (opts.command === 'install') installCommand(opts)
    else throw new Error('Unknown command')
  } catch (err) {
    const root = opts.root ? path.resolve(opts.root) : process.cwd()
    const message = err && err.message ? err.message : String(err)
    appendLog(root, 'helper.log', `failed command=${opts.command || 'unknown'} error=${message}`)
    trace(root, 'helper.failed', { command: opts.command || 'unknown', error: message })
    console.error(message)
    process.exit(1)
  }
}

module.exports = {
  acquireStableOwnershipLease,
  buildOwnerMarker,
  markerMatchesInstall,
  buildSafeUninstallScript,
  captureStableInstallProof,
  assertStableInstallProofUnchanged,
  stageStableOwnershipArtifacts,
  snapshotDirectoryTree,
  robocopyMirrorDirectory,
  waitForProcessExit,
  stageInstallPayloadTransaction,
}
