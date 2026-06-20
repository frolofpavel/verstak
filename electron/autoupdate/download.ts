import { createHash } from 'crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { join } from 'path'
import { downloadsDir } from './paths'
import { releaseFeedBase, type ReleaseArtifactMeta } from '../update-remote'
import type { DownloadProgress } from './types'
import { logAutoUpdate } from './log'

async function updaterFetch(url: string, init?: RequestInit): Promise<Response> {
  if (process.versions.electron) {
    const { net } = await import('electron')
    return net.fetch(url, init)
  }
  return fetch(url, init)
}

export function downloadedInstallerPath(version: string, fileName: string): string {
  return join(downloadsDir(version), fileName)
}

async function hashFileSha512Base64(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    const stream = createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 })
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('base64')))
  })
}

export async function downloadInstaller(
  meta: ReleaseArtifactMeta,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<string> {
  const dir = downloadsDir(meta.version)
  mkdirSync(dir, { recursive: true })
  const target = downloadedInstallerPath(meta.version, meta.fileName)
  logAutoUpdate('download.start', { version: meta.version, fileName: meta.fileName, target, expectedSize: meta.size, hasSha512: !!meta.sha512 })
  if (existsSync(target)) {
    const size = statSync(target).size
    logAutoUpdate('download.cached_candidate', { target, size, expectedSize: meta.size })
    if ((!meta.size || size === meta.size) && size > 0) {
      const digest = meta.sha512 ? await hashFileSha512Base64(target) : ''
      if (!meta.sha512 || digest === meta.sha512) {
        logAutoUpdate('download.cached_ok', { target, size })
        return target
      }
      logAutoUpdate('download.cached_hash_mismatch', { target, size })
    }
    try { rmSync(target, { force: true }) } catch { /* ignore */ }
  }
  const tmp = `${target}.part`
  try { rmSync(tmp, { force: true }) } catch { /* ignore */ }

  const res = await updaterFetch(`${releaseFeedBase(meta.version)}/${meta.fileName}`, {
    headers: { 'User-Agent': 'Verstak-AutoUpdate' },
  })
  logAutoUpdate('download.response', { version: meta.version, status: res.status, ok: res.ok, contentLength: res.headers.get('content-length') })
  if (!res.ok) throw new Error(`Не удалось скачать обновление (HTTP ${res.status})`)
  if (!res.body) throw new Error('Пустой ответ при скачивании обновления')

  const total = meta.size > 0 ? meta.size : Number(res.headers.get('content-length') || 0)
  const hash = createHash('sha512')
  const out = createWriteStream(tmp, { highWaterMark: 2 * 1024 * 1024 })
  let transferred = 0
  let lastReportAt = 0
  let lastPercent = -1

  const report = (force = false) => {
    if (!onProgress) return
    const percent = total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0
    const now = Date.now()
    if (!force && percent === lastPercent && now - lastReportAt < 300) return
    lastReportAt = now
    lastPercent = percent
    onProgress({ percent, transferred, total })
  }

  const tap = new Transform({
    highWaterMark: 2 * 1024 * 1024,
    transform(chunk, _encoding, callback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      hash.update(buf)
      transferred += buf.length
      report()
      callback(null, buf)
    },
  })

  try {
    report(true)
    const webBody = res.body as unknown as import('stream/web').ReadableStream<Uint8Array>
    await pipeline(Readable.fromWeb(webBody), tap, out)
    report(true)
  } catch (err) {
    try { out.destroy() } catch { /* ignore */ }
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
    throw err
  }

  if (meta.sha512) {
    const digest = hash.digest('base64')
    if (digest !== meta.sha512) {
      try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
      logAutoUpdate('download.hash_mismatch', { version: meta.version, transferred })
      throw new Error('Контрольная сумма установщика не совпадает')
    }
  } else if (meta.size > 0 && transferred !== meta.size) {
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
    throw new Error(`Размер установщика не совпадает: ${transferred} != ${meta.size}`)
  }

  try { rmSync(target, { force: true }) } catch { /* ignore */ }
  renameSync(tmp, target)
  writeFileSync(join(dir, 'download.json'), JSON.stringify({
    version: meta.version,
    fileName: meta.fileName,
    sha512: meta.sha512,
    size: transferred,
    downloadedAt: Date.now(),
  }, null, 2), 'utf8')
  logAutoUpdate('download.complete', { version: meta.version, target, transferred, total: total || transferred })
  onProgress?.({ percent: 100, transferred, total: total || transferred })
  return target
}
