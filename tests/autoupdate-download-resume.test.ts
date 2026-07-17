import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'http'
import type { Socket } from 'net'
import { createHash } from 'crypto'
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * P0 (внеплановый срез): АВТООБНОВЛЕНИЕ НЕ ДОСТАВЛЯЛО РЕЛИЗЫ.
 *
 * Симптом у Павла: остался на 2.0.5, три релиза (2.0.6/2.0.7/2.0.8) не встали. В
 * %LOCALAPPDATA%/Verstak/AutoUpdate/downloads/2.0.8/ лежал мёртвый `.part` на 21 МБ,
 * следующая попытка начинала с 0%.
 *
 * Корень (по коду download.ts): загрузка идёт БЕЗ Range, а на любой ошибке `.part`
 * УДАЛЯЛСЯ. Обрыв на 90% → прогресс стёрт → следующая попытка с нуля. На канале РФ→GitHub
 * с периодическим ERR_CONNECTION_RESET 360 МБ не докачиваются НИКОГДА — не «медленно», а
 * принципиально.
 *
 * Эти тесты воспроизводят обрыв локальным сервером. Без фикса они КРАСНЫЕ.
 */

const DATA = Buffer.from(
  Array.from({ length: 300_000 }, (_, i) => (i * 31 + 7) % 251)
) // ~300 КБ детерминированного «установщика»
const SHA512 = createHash('sha512').update(DATA).digest('base64')

let server: Server
let port = 0
/** Живые сокеты — «зависшее» соединение иначе не даст server.close() завершиться (тест повиснет). */
let sockets: Socket[] = []
let dir: string
/** История запросов — чем доказываем, что докачка реально просит Range. */
let requests: Array<{ range: string | null }> = []
/** Сколько байт отдать до обрыва (null = отдать всё). */
let killAfterBytes: number | null = null
/** Игнорировать ли Range (эмуляция сервера, который отвечает 200 вместо 206). */
let ignoreRange = false

vi.mock('../electron/update-remote', () => ({
  releaseFeedBase: () => `http://127.0.0.1:${port}`,
}))

const { downloadInstaller, downloadedInstallerPath } = await import('../electron/autoupdate/download')

const meta = () => ({ version: '9.9.9', fileName: 'Setup.exe', size: DATA.length, sha512: SHA512 } as never)

beforeEach(async () => {
  sockets = []
  requests = []
  killAfterBytes = null
  ignoreRange = false
  dir = mkdtempSync(join(tmpdir(), 'vst-upd-'))
  process.env.LOCALAPPDATA = dir
  // Боевые 90с в тесте не ждём, но и 1.5с нельзя: под параллельной нагрузкой (340 файлов)
  // сторож тишины срабатывал ЛОЖНО и ронял прогон флейком. Порог мягкий по умолчанию —
  // жёсткий ставит только тест, который сторож и проверяет.
  process.env.VERSTAK_UPDATE_IDLE_MS = '15000'

  server = createServer((req, res) => {
    const range = req.headers.range ?? null
    requests.push({ range })
    let start = 0
    if (range && !ignoreRange) {
      const m = /bytes=(\d+)-/.exec(range)
      start = m ? Number(m[1]) : 0
      // Как настоящий GitHub: запрос за пределами файла = 416, а НЕ 206 с нулём байт.
      // Без этого мок врёт и прячет реальный дефект (застревание на полном .part).
      if (start >= DATA.length) {
        res.writeHead(416, { 'content-range': `bytes */${DATA.length}` })
        res.end()
        return
      }
      res.writeHead(206, {
        'content-range': `bytes ${start}-${DATA.length - 1}/${DATA.length}`,
        'content-length': String(DATA.length - start),
      })
    } else {
      res.writeHead(200, { 'content-length': String(DATA.length) })
    }
    const body = DATA.subarray(start)
    if (killAfterBytes != null) {
      // Отдаём кусок и РВЁМ соединение — так ведёт себя канал РФ→GitHub.
      res.write(body.subarray(0, killAfterBytes))
      setTimeout(() => res.destroy(), 10)
      killAfterBytes = null // рвём только один раз, дальше отдаём честно
      return
    }
    res.end(body)
  })
  server.on('connection', s => { sockets.push(s); s.on('close', () => { sockets = sockets.filter(x => x !== s) }) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => {
    port = (server.address() as { port: number }).port
    r()
  }))
})

afterEach(async () => {
  for (const s of sockets) { try { s.destroy() } catch { /* уже мёртв */ } }
  sockets = []
  await new Promise<void>(r => server.close(() => r()))
  rmSync(dir, { recursive: true, force: true })
})

describe('автообновление: докачка установщика (P0 — доставка релизов)', () => {
  it('обрыв посреди загрузки → файл ВСЁ РАВНО докачивается, sha512 сходится', async () => {
    killAfterBytes = 100_000 // умрём на трети
    const target = await downloadInstaller(meta())
    expect(existsSync(target)).toBe(true)
    expect(statSync(target).size).toBe(DATA.length)
    expect(createHash('sha512').update(readFileSync(target)).digest('base64')).toBe(SHA512)
  })

  it('после обрыва докачка идёт с Range, а НЕ с нуля (иначе 360 МБ не доедут никогда)', async () => {
    killAfterBytes = 100_000
    await downloadInstaller(meta())
    // Первый запрос — без Range (файла ещё нет); второй обязан попросить продолжение.
    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(requests[0].range).toBeNull()
    expect(requests[1].range).toMatch(/^bytes=\d+-$/)
    const resumeFrom = Number(/bytes=(\d+)-/.exec(requests[1].range!)![1])
    expect(resumeFrom).toBeGreaterThan(0) // продолжили с накопленного, а не с 0
  })

  it('прогресс не откатывается в 0 после обрыва (percent монотонен)', async () => {
    killAfterBytes = 100_000
    const seen: number[] = []
    await downloadInstaller(meta(), p => seen.push(p.percent))
    expect(seen.length).toBeGreaterThan(0)
    // Именно это Павел видел на скрине: попытка №2 показывала 0% при мёртвом .part на 21 МБ.
    const drops = seen.filter((p, i) => i > 0 && p < seen[i - 1])
    expect(drops).toEqual([])
    expect(seen.at(-1)).toBe(100)
  })

  it('сервер ответил 200 вместо 206 (Range проигнорирован) → честный рестарт, файл не испорчен', async () => {
    killAfterBytes = 100_000
    ignoreRange = true // сервер отдаёт всё с начала, игнорируя наш Range
    const target = await downloadInstaller(meta())
    // Файл обязан быть целым: если бы дописали полное тело к остатку — размер и хеш поехали бы.
    expect(statSync(target).size).toBe(DATA.length)
    expect(createHash('sha512').update(readFileSync(target)).digest('base64')).toBe(SHA512)
  })

  it('испорченный .part (хеш не сойдётся) → чистый рестарт, а не вечная ошибка', async () => {
    const dl = join(dir, 'Verstak', 'AutoUpdate', 'downloads', '9.9.9')
    mkdirSync(dl, { recursive: true })
    // Кладём мусор нужного размера — как будто прошлая версия/битая загрузка.
    writeFileSync(join(dl, 'Setup.exe.part'), Buffer.alloc(150_000, 0xab))
    const target = await downloadInstaller(meta())
    expect(createHash('sha512').update(readFileSync(target)).digest('base64')).toBe(SHA512)
  })

  // Ретраи обязаны быть ОГРАНИЧЕНЫ: на мёртвой сети пользователь должен получить честную
  // ошибку, а не вечный цикл. Но прогресс при этом всё равно сохраняется для следующего раза.
  it('сеть мертва → конечное число попыток, честная ошибка, .part СОХРАНЁН для следующего раза', async () => {
    await new Promise<void>(r => server.close(() => r())) // сервер мёртв — connection refused
    const dl = join(dir, 'Verstak', 'AutoUpdate', 'downloads', '9.9.9')
    mkdirSync(dl, { recursive: true })
    writeFileSync(join(dl, 'Setup.exe.part'), DATA.subarray(0, 50_000)) // накопленное ранее

    await expect(downloadInstaller(meta())).rejects.toThrow()
    // Главное: неудача НЕ стёрла накопленное — следующий запуск продолжит с 50 КБ.
    expect(existsSync(join(dl, 'Setup.exe.part'))).toBe(true)
    expect(statSync(join(dl, 'Setup.exe.part')).size).toBe(50_000)
    // Сервер поднимаем обратно, чтобы afterEach корректно закрылся.
    server = createServer(() => {})
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  }, 30_000)

  // 429/408 — ВРЕМЕННЫЕ отказы, повтор ровно для них и нужен. Классификация «любой 4xx фатален»
  // накрыла бы их и оставила пользователя без обновления на ровном месте.
  it('HTTP 429 (rate limit GitHub) → РЕТРАИТСЯ и доводит загрузку', async () => {
    await new Promise<void>(r => server.close(() => r()))
    let hits = 0
    server = createServer((req, res) => {
      hits++
      requests.push({ range: req.headers.range ?? null })
      if (hits === 1) { res.writeHead(429, { 'retry-after': '0' }); res.end(); return }
      res.writeHead(200, { 'content-length': String(DATA.length) })
      res.end(DATA)
    })
    await new Promise<void>(r => server.listen(port, '127.0.0.1', () => r()))
    const target = await downloadInstaller(meta())
    expect(hits).toBeGreaterThanOrEqual(2) // повторили, а не сдались
    expect(createHash('sha512').update(readFileSync(target)).digest('base64')).toBe(SHA512)
  }, 30_000)

  it('HTTP 404 → без бессмысленных ретраев (файла нет — повтор не поможет)', async () => {
    await new Promise<void>(r => server.close(() => r()))
    server = createServer((req, res) => { requests.push({ range: req.headers.range ?? null }); res.writeHead(404); res.end() })
    await new Promise<void>(r => server.listen(port, '127.0.0.1', () => r()))
    await expect(downloadInstaller(meta())).rejects.toThrow(/HTTP 404/)
    expect(requests).toHaveLength(1) // ровно одна попытка, а не пять
  })

  // КРАЙ, который легко проглядеть: процесс умер СРАЗУ ПОСЛЕ последнего байта — .part полон,
  // но не переименован. Наивная докачка попросит Range: bytes=<size>- → сервер ответит 416 →
  // «HTTP 4xx» = fatal → пользователь застрянет НАВСЕГДА на готовом файле. Проверяем, что нет.
  it('.part уже полон (умерли перед rename) → завершаем без 416, файл доводится', async () => {
    const dl = join(dir, 'Verstak', 'AutoUpdate', 'downloads', '9.9.9')
    mkdirSync(dl, { recursive: true })
    writeFileSync(join(dl, 'Setup.exe.part'), DATA) // ровно нужный размер и содержимое
    const target = await downloadInstaller(meta())
    expect(createHash('sha512').update(readFileSync(target)).digest('base64')).toBe(SHA512)
    expect(existsSync(join(dl, 'Setup.exe.part'))).toBe(false) // часть переехала в цель
  })

  it('.part полон, но ИСПОРЧЕН → не застреваем на 416, а перекачиваем чисто', async () => {
    const dl = join(dir, 'Verstak', 'AutoUpdate', 'downloads', '9.9.9')
    mkdirSync(dl, { recursive: true })
    writeFileSync(join(dl, 'Setup.exe.part'), Buffer.alloc(DATA.length, 0xcd)) // размер тот, байты чужие
    const target = await downloadInstaller(meta())
    expect(createHash('sha512').update(readFileSync(target)).digest('base64')).toBe(SHA512)
  })

  // Канал РФ→GitHub умирает ДВУМЯ способами. RST мы уже лечим. Второй — молчаливый blackhole:
  // DPI/ТСПУ проглотил сокет, байты кончились, но ни FIN, ни RST не пришли. Цикл ретраев
  // реагирует только на ОШИБКУ, а столл ошибкой не является → без idle-таймаута попытка висит
  // вечно, status застревает в 'downloading', и пользователь заперт до перезапуска приложения.
  it('соединение ЗАВИСЛО (байты кончились, сокет не закрыт) → не виснем вечно, докачиваем', async () => {
    process.env.VERSTAK_UPDATE_IDLE_MS = '1500' // здесь сторож тишины — предмет проверки
    await new Promise<void>(r => server.close(() => r()))
    let hits = 0
    server = createServer((req, res) => {
      hits++
      requests.push({ range: req.headers.range ?? null })
      if (hits === 1) {
        // Отдаём кусок и ЗАМОЛКАЕМ навсегда, не закрывая сокет.
        res.writeHead(200, { 'content-length': String(DATA.length) })
        res.write(DATA.subarray(0, 80_000))
        return // ни end, ни destroy — «чёрная дыра»
      }
      const m = /bytes=(\d+)-/.exec(req.headers.range ?? '')
      const start = m ? Number(m[1]) : 0
      res.writeHead(start > 0 ? 206 : 200, { 'content-length': String(DATA.length - start) })
      res.end(DATA.subarray(start))
    })
    await new Promise<void>(r => server.listen(port, '127.0.0.1', () => r()))

    const target = await downloadInstaller(meta())
    expect(createHash('sha512').update(readFileSync(target)).digest('base64')).toBe(SHA512)
    expect(hits).toBeGreaterThanOrEqual(2) // сорвались с зависшей попытки и продолжили
  }, 60_000)

  // Ревью P0: защита от 416 висела на `meta.size > 0`, а размер парсится best-effort
  // (update-remote.ts: `sizeMatch?.[1] ? Number(...) : 0`) — 0 достижим при любом изменении
  // формата latest.yml. Тогда полный .part + Range → 416 → не ретраится → застревание навсегда.
  // Лечим сам 416, а не полагаемся на размер.
  it('meta.size НЕИЗВЕСТЕН (0) + полный .part → 416 обработан, не застреваем', async () => {
    const dl = join(dir, 'Verstak', 'AutoUpdate', 'downloads', '9.9.9')
    mkdirSync(dl, { recursive: true })
    writeFileSync(join(dl, 'Setup.exe.part'), DATA) // полная и корректная часть
    const noSize = { version: '9.9.9', fileName: 'Setup.exe', size: 0, sha512: SHA512 } as never
    const target = await downloadInstaller(noSize)
    expect(createHash('sha512').update(readFileSync(target)).digest('base64')).toBe(SHA512)
  })

  it('meta.size НЕИЗВЕСТЕН (0) + полный, но ИСПОРЧЕННЫЙ .part → 416 → чистый рестарт', async () => {
    const dl = join(dir, 'Verstak', 'AutoUpdate', 'downloads', '9.9.9')
    mkdirSync(dl, { recursive: true })
    writeFileSync(join(dl, 'Setup.exe.part'), Buffer.alloc(DATA.length, 0x7f))
    const noSize = { version: '9.9.9', fileName: 'Setup.exe', size: 0, sha512: SHA512 } as never
    const target = await downloadInstaller(noSize)
    expect(createHash('sha512').update(readFileSync(target)).digest('base64')).toBe(SHA512)
  })

  it('готовый файл в кэше не перекачивается (характеризация — поведение сохранено)', async () => {
    const target = downloadedInstallerPath('9.9.9', 'Setup.exe')
    mkdirSync(join(dir, 'Verstak', 'AutoUpdate', 'downloads', '9.9.9'), { recursive: true })
    writeFileSync(target, DATA)
    const got = await downloadInstaller(meta())
    expect(got).toBe(target)
    expect(requests).toHaveLength(0) // сеть не трогали вообще
  })
})
