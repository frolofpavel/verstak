import { closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { logAutoUpdate } from './log'

export const APP_ASAR_MIN_BYTES = 10_000_000

type AsarFileInfo = {
  files?: Record<string, AsarFileInfo>
  offset?: string
  size?: number
  unpacked?: boolean
}

export type PayloadVerification = {
  ok: boolean
  version?: string
  appAsarSize: number
  exeSize: number
  error?: string
}

export function readAsarFile(archivePath: string, filePath: string): Buffer | null {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '')
  try {
    const sizeBuf = Buffer.alloc(8)
    const fd = openSync(archivePath, 'r')
    try {
      if (readSync(fd, sizeBuf, 0, 8, 0) !== 8) return null
      const headerSize = sizeBuf.readUInt32LE(4)
      const headerBuf = Buffer.alloc(headerSize)
      if (readSync(fd, headerBuf, 0, headerSize, 8) !== headerSize) return null
      const headerStringLength = headerBuf.readInt32LE(4)
      const headerString = headerBuf.slice(8, 8 + headerStringLength).toString('utf8')
      let node = JSON.parse(headerString) as AsarFileInfo
      for (const part of normalized.split('/')) {
        node = node.files?.[part] as AsarFileInfo
        if (!node) return null
      }
      if (node.unpacked || typeof node.offset !== 'string' || typeof node.size !== 'number') return null
      const file = Buffer.alloc(node.size)
      if (node.size === 0) return file
      const fileOffset = 8 + headerSize + Number.parseInt(node.offset, 10)
      if (readSync(fd, file, 0, node.size, fileOffset) !== node.size) return null
      return file
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

export function readAppAsarVersion(payloadRoot: string): string | null {
  try {
    const pkg = readAsarFile(join(payloadRoot, 'resources', 'app.asar'), 'package.json')
    if (!pkg) return null
    const parsed = JSON.parse(pkg.toString('utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null
  } catch {
    return null
  }
}

export function verifyPayloadRoot(payloadRoot: string, expectedVersion?: string): PayloadVerification {
  const exe = join(payloadRoot, 'Verstak.exe')
  const appAsar = join(payloadRoot, 'resources', 'app.asar')
  const exeSize = existsSync(exe) ? statSync(exe).size : 0
  const appAsarSize = existsSync(appAsar) ? statSync(appAsar).size : 0

  logAutoUpdate('payload.verify.start', { payloadRoot, expectedVersion, exe, appAsar, exeSize, appAsarSize })

  if (exeSize <= 0) {
    const error = 'Повреждён payload: отсутствует Verstak.exe'
    logAutoUpdate('payload.verify.fail', { payloadRoot, error, exeSize, appAsarSize })
    return { ok: false, appAsarSize, exeSize, error }
  }
  if (appAsarSize < APP_ASAR_MIN_BYTES) {
    const error = 'Повреждён payload: пустой файл resources\\app.asar'
    logAutoUpdate('payload.verify.fail', { payloadRoot, error, exeSize, appAsarSize })
    return { ok: false, appAsarSize, exeSize, error }
  }
  const version = readAppAsarVersion(payloadRoot)
  if (!version) {
    const error = 'Повреждён payload: не читается package.json внутри app.asar'
    logAutoUpdate('payload.verify.fail', { payloadRoot, error, exeSize, appAsarSize })
    return { ok: false, appAsarSize, exeSize, error }
  }
  if (expectedVersion && version !== expectedVersion) {
    const error = `Payload версии ${version}, ожидалась ${expectedVersion}`
    logAutoUpdate('payload.verify.fail', { payloadRoot, error, version, expectedVersion, exeSize, appAsarSize })
    return { ok: false, version, appAsarSize, exeSize, error }
  }

  logAutoUpdate('payload.verify.ok', { payloadRoot, version, exeSize, appAsarSize })
  return { ok: true, version, appAsarSize, exeSize }
}

export function writePayloadMetadata(version: string, payloadRoot: string): PayloadVerification {
  const verification = verifyPayloadRoot(payloadRoot, version)
  if (!verification.ok) return verification
  writeFileSync(join(payloadRoot, '..', 'payload.json'), JSON.stringify({
    version,
    payloadRoot,
    appAsarSize: verification.appAsarSize,
    exeSize: verification.exeSize,
    createdAt: Date.now(),
  }, null, 2), 'utf8')
  writeFileSync(join(payloadRoot, '..', 'verified.json'), JSON.stringify({
    version,
    payloadRoot,
    appAsarSize: verification.appAsarSize,
    exeSize: verification.exeSize,
    verifiedAt: Date.now(),
  }, null, 2), 'utf8')
  return verification
}
