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

/** Влить уже скачанную часть в хеш — состояние хеша между попытками не переживает обрыв. */
async function feedFileIntoHash(hash: ReturnType<typeof createHash>, filePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 })
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
}

const MAX_DOWNLOAD_ATTEMPTS = 5
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/**
 * Сколько молчания терпим. Караулим ИМЕННО ТИШИНУ, а не общее время: качать 360 МБ полчаса —
 * законно, а вот 90 секунд без единого байта = соединение мертво (DPI/ТСПУ проглотил сокет и
 * не прислал ни FIN, ни RST). Без этого сторожа попытка висела бы вечно: цикл ретраев реагирует
 * на ОШИБКУ, а столл ошибкой не является → status навсегда 'downloading'.
 */
function idleTimeoutMs(): number {
  // Читаем в момент вызова, а не при загрузке модуля: тесты подменяют порог, а константа
  // уровня модуля защёлкнула бы боевые 90с ещё до их beforeEach.
  return Number(process.env.VERSTAK_UPDATE_IDLE_MS) || 90_000
}

/** Ошибка HTTP со статусом — чтобы решать про ретрай по КОДУ, а не по тексту сообщения. */
class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`Не удалось скачать обновление (HTTP ${status})`)
    this.name = 'HttpStatusError'
  }
}

/**
 * Повторять ли попытку. Обрывы сети (не HttpStatusError) — да, ради них всё и затевалось.
 * Среди HTTP-кодов ретраибельны только ВРЕМЕННЫЕ:
 *  · 408 (timeout) и 429 (rate limit — GitHub его отдаёт) — повтор ровно для них;
 *  · 5xx — сервер прилёг, повтор осмыслен.
 * Остальные 4xx (404 «релиза нет», 403 «доступ закрыт») повтором не лечатся — сдаёмся сразу,
 * чтобы не жечь 5 попыток и не врать пользователю ожиданием.
 * ВАЖНО: решаем по числовому статусу. Матч по подстроке «HTTP 4» в тексте ошибки ловил бы и
 * сетевые сообщения, где эти символы случайны.
 */
function isRetriableFailure(err: unknown): boolean {
  if (!(err instanceof HttpStatusError)) return true
  if (err.status === 408 || err.status === 429) return true
  return err.status >= 500
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
  const url = `${releaseFeedBase(meta.version)}/${meta.fileName}`

  // ─────────────────────────────────────────────────────────────────────────────
  // ДОКАЧКА (P0-фикс: релизы не доезжали до пользователей).
  //
  // Было: `.part` удалялся перед каждой попыткой И на любой ошибке, Range не запрашивался.
  // Обрыв на 90% → прогресс стёрт → следующая попытка с нуля. На канале РФ→GitHub с
  // периодическим ERR_CONNECTION_RESET 360 МБ не докачивались НИКОГДА (Павел просидел на
  // 2.0.5 три релиза: мёртвый .part на 21 МБ, следующая попытка — 0%).
  //
  // Стало: `.part` переживает обрыв; следующая попытка просит `Range: bytes=<size>-` и
  // дописывает в конец. Хеш между попытками не переживает обрыв, поэтому перед продолжением
  // пересчитывается по уже лежащей части (feedFileIntoHash) — иначе sha512 не сойдётся.
  // Ретраи внутри: один reset не должен выбрасывать пользователя в «нужна повторная проверка».
  // ─────────────────────────────────────────────────────────────────────────────
  let lastError: unknown = null
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      return await attemptDownload(meta, url, tmp, target, dir, attempt, onProgress)
    } catch (err) {
      lastError = err
      const retriable = isRetriableFailure(err)
      const partSize = existsSync(tmp) ? statSync(tmp).size : 0
      logAutoUpdate('download.attempt_failed', {
        version: meta.version, attempt, of: MAX_DOWNLOAD_ATTEMPTS,
        keptPartBytes: partSize, retriable,
        status: err instanceof HttpStatusError ? err.status : null,
        error: err instanceof Error ? err.message : String(err),
      })
      if (!retriable || attempt === MAX_DOWNLOAD_ATTEMPTS) break
      await sleep(Math.min(8000, 500 * 2 ** (attempt - 1))) // 0.5s → 1s → 2s → 4s
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Не удалось скачать обновление')
}

async function attemptDownload(
  meta: ReleaseArtifactMeta,
  url: string,
  tmp: string,
  target: string,
  dir: string,
  attempt: number,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<string> {
  // Сколько уже лежит на диске от прошлых попыток.
  let existing = existsSync(tmp) ? statSync(tmp).size : 0

  // КРАЙ: часть уже ПОЛНАЯ (умерли между последним байтом и rename). Просить
  // `Range: bytes=<size>-` нельзя — сервер честно ответит 416 (за пределами файла), а 4xx у нас
  // не ретраится → пользователь застрял бы НАВСЕГДА на готовом файле. Проверяем хеш на месте:
  // сошёлся — просто доводим до цели, не сошёлся — это мусор, качаем чисто.
  if (meta.size > 0 && existing >= meta.size) {
    if (existing === meta.size && meta.sha512 && await hashFileSha512Base64(tmp) === meta.sha512) {
      logAutoUpdate('download.part_already_complete', { tmp, size: existing })
      return finishDownload(meta, tmp, target, dir, existing, existing, onProgress)
    }
    logAutoUpdate('download.part_full_but_bad', { tmp, existing, expected: meta.size })
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
    existing = 0
  }

  const headers: Record<string, string> = { 'User-Agent': 'Verstak-AutoUpdate' }
  if (existing > 0) headers.Range = `bytes=${existing}-`

  // Сторож тишины: срабатывает, если байты перестали идти. Сбрасывается на каждом чанке.
  const ac = new AbortController()
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    const ms = idleTimeoutMs()
    idleTimer = setTimeout(() => {
      logAutoUpdate('download.idle_timeout', { version: meta.version, attempt, idleMs: ms })
      ac.abort(new Error(`Загрузка молчит ${Math.round(ms / 1000)}с — обрываем и продолжим с этого места`))
    }, ms)
  }
  const disarmIdle = (): void => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null } }

  armIdle() // сторожим уже сам connect/TTFB, а не только тело
  let res: Response
  try {
    res = await updaterFetch(url, { headers, signal: ac.signal })
  } catch (err) {
    disarmIdle()
    throw err
  }
  logAutoUpdate('download.response', {
    version: meta.version, attempt, status: res.status, ok: res.ok,
    requestedRangeFrom: existing || null, contentLength: res.headers.get('content-length'),
  })
  // 416 = наш Range за пределами файла, то есть `.part` уже НЕ меньше цели. Это не «ошибка
  // сервера», а ответ «качать больше нечего». Гард по meta.size выше ловит типичный случай, но
  // размер парсится best-effort и легально бывает 0 (update-remote.ts) — тогда сюда доходит
  // полный .part, и без этой ветки пользователь застрял бы навсегда: 416 не ретраится.
  if (res.status === 416 && existing > 0) {
    disarmIdle()
    if (meta.sha512 && await hashFileSha512Base64(tmp) === meta.sha512) {
      logAutoUpdate('download.range_unsatisfiable_part_complete', { tmp, size: existing })
      return finishDownload(meta, tmp, target, dir, existing, existing, onProgress)
    }
    // Не сошёлся (или сверить нечем) — часть длиннее/чужая. Сносим и даём ретраю начать чисто.
    logAutoUpdate('download.range_unsatisfiable_part_bad', { tmp, size: existing })
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
    throw new Error('Скачанная часть не подошла — начинаем заново')
  }
  if (!res.ok) throw new HttpStatusError(res.status)
  if (!res.body) throw new Error('Пустой ответ при скачивании обновления')

  // Range попросили, а сервер ответил 200 → он ОТДАЁТ ВСЁ С НАЧАЛА. Дописать это к остатку
  // = склеить файл в мусор. Честно начинаем заново (перезаписью, не дописыванием).
  const resuming = existing > 0 && res.status === 206
  if (existing > 0 && !resuming) {
    logAutoUpdate('download.range_ignored_restart', { version: meta.version, attempt, status: res.status, discardedBytes: existing })
    existing = 0
  }

  const total = meta.size > 0 ? meta.size : Number(res.headers.get('content-length') || 0)
  const hash = createHash('sha512')
  // Хеш обязан включить уже лежащую часть — состояние хеша обрыв не пережило.
  if (resuming) await feedFileIntoHash(hash, tmp)

  const out = createWriteStream(tmp, { flags: resuming ? 'a' : 'w', highWaterMark: 2 * 1024 * 1024 })
  let transferred = existing
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
      armIdle() // байты пошли — сторож тишины начинает отсчёт заново
      hash.update(buf)
      transferred += buf.length
      report()
      callback(null, buf)
    },
  })

  try {
    report(true)
    const webBody = res.body as unknown as import('stream/web').ReadableStream<Uint8Array>
    await pipeline(Readable.fromWeb(webBody), tap, out, { signal: ac.signal })
    report(true)
  } catch (err) {
    try { out.destroy() } catch { /* ignore */ }
    // ЗДЕСЬ БЫЛ КОРЕНЬ ДЕФЕКТА: `.part` удалялся → весь прогресс терялся → следующая
    // попытка с нуля → 360 МБ на рвущемся канале не доезжали никогда. Теперь часть ЖИВЁТ:
    // ретрай выше продолжит с этого места через Range.
    logAutoUpdate('download.stream_broken_part_kept', {
      version: meta.version, attempt,
      keptBytes: existsSync(tmp) ? statSync(tmp).size : 0,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  } finally {
    disarmIdle()
  }

  if (meta.sha512) {
    const digest = hash.digest('base64')
    if (digest !== meta.sha512) {
      // Хеш не сошёлся = часть испорчена (битые байты/чужой файл). Вот ЕЁ удалять надо —
      // иначе докачка будет вечно продолжать мусор. Ретрай начнёт чисто.
      try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
      logAutoUpdate('download.hash_mismatch', { version: meta.version, attempt, transferred, resumed: resuming })
      throw new Error('Контрольная сумма установщика не совпадает')
    }
  } else if (meta.size > 0 && transferred !== meta.size) {
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
    throw new Error(`Размер установщика не совпадает: ${transferred} != ${meta.size}`)
  }

  return finishDownload(meta, tmp, target, dir, transferred, total, onProgress)
}

/** Довести проверенную часть до цели: переименовать + записать паспорт загрузки. */
function finishDownload(
  meta: ReleaseArtifactMeta,
  tmp: string,
  target: string,
  dir: string,
  transferred: number,
  total: number,
  onProgress?: (progress: DownloadProgress) => void,
): string {
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
