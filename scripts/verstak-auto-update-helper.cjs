#!/usr/bin/env node
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const APP_ASAR_MIN_BYTES = 10_000_000

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
  return { version: parsed.version, exeSize, appAsarSize }
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

function waitForProcessExit(parentPid) {
  if (parentPid) {
    run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Wait-Process -Id ${Number(parentPid) || 0} -Timeout 180 -ErrorAction SilentlyContinue`,
    ])
  }
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const res = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-Process -Name 'Verstak' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id"])
    if (!String(res.stdout || '').trim()) break
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
}

function robocopyPayload(payloadRoot, installDir) {
  const staleUnpacked = path.join(installDir, 'resources', 'app.asar.unpacked')
  fs.rmSync(staleUnpacked, { recursive: true, force: true })
  const result = run('robocopy', [
    payloadRoot,
    installDir,
    '/E',
    '/XD',
    'locales',
    '/NFL',
    '/NDL',
    '/NJH',
    '/NJS',
    '/NP',
  ])
  const code = result.status ?? 1
  if (code >= 8) throw new Error(`robocopy failed with code ${code}: ${(result.stderr || result.stdout || '').trim()}`)
}

function launchApp(installDir) {
  const exe = path.join(installDir, 'Verstak.exe')
  if (!fs.existsSync(exe)) throw new Error('Verstak.exe not found after update')
  const ps = `Start-Process -FilePath '${exe.replace(/'/g, "''")}'`
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps])
  if ((result.status ?? 1) !== 0) throw new Error('Failed to restart Verstak')
}

function installCommand(opts) {
  const root = path.resolve(opts.root)
  const version = opts.version
  const payloadRoot = path.resolve(opts.payload)
  const installDir = path.resolve(opts['install-dir'])
  const installDirForVersion = path.join(root, 'install', version)
  const logFile = path.join(installDirForVersion, 'install.log')
  mkdirp(installDirForVersion)
  const log = (line) => {
    appendLog(root, 'install.log', line)
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  }

  writeJson(path.join(installDirForVersion, 'install-plan.json'), {
    version,
    payloadRoot,
    installDir,
    parentPid: Number(opts['parent-pid'] || 0),
    startedAt: Date.now(),
  })

  try {
    log(`start version=${version} payload=${payloadRoot} installDir=${installDir}`)
    trace(root, 'helper.install.start', { version, payloadRoot, installDir })
    const payloadVerified = verifyPayloadRoot(payloadRoot, version)
    trace(root, 'helper.install.payload_verified', { version, payloadRoot, payloadVerified })
    waitForProcessExit(Number(opts['parent-pid'] || 0))
    robocopyPayload(payloadRoot, installDir)
    const installedVerified = verifyPayloadRoot(installDir, version)
    trace(root, 'helper.install.installed_verified', { version, installDir, installedVerified })
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
    const message = err && err.message ? err.message : String(err)
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
