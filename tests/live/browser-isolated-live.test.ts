// P3 кусок 3 · ЖИВАЯ ПРИЁМКА чистой сессии. Настоящий Playwright, настоящий браузер,
// настоящий локальный сервер — БЕЗ подмены запуска.
//
// ПОЧЕМУ ОПТ-ИН, А НЕ ЧАСТЬ ОБЫЧНОГО ПРОГОНА. Тест зависит от того, что на машине
// установлен браузер на движке Chromium. Тест, читающий реальное окружение
// запускающего, невоспроизводим по построению и однажды соврёт в любую сторону
// (§3.1). Поэтому он объявлен, посчитан в наборе и пропускается без флага:
//     $env:VERSTAK_LIVE_BROWSER=1; npm run smoke:isolated-browser
// Остальные пины куска 3 (гейт, жизненный цикл, контракт) работают на подменённом
// запуске и от машины не зависят вовсе.
//
// ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ, ЧЕГО НЕ ДОКАЗЫВАЮТ ЗЕЛЁНЫЕ ЮНИТЫ (правило штаба «зелёные
// тесты ≠ работающая функция»):
//   1. сценарий на localhost проходится ЦЕЛИКОМ: переход, поиск, ввод, клик, readback;
//   2. он проходится ДВАЖДЫ с одинаковым результатом — то есть повторяем;
//   3. вторая сессия НЕ ВИДИТ кук первой — то есть действительно чистая;
//   4. после закрытия не остаётся ни сессии в реестре, ни лишних процессов браузера.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, type Server } from 'http'
import { execSync } from 'child_process'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { browserHandler } from '../../electron/ipc/tool-handlers/browser'
import { closeAllIsolatedSessions, isolatedSessionCount, setIsolatedLauncher } from '../../electron/browser/isolated-session'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { ToolCall } from '../../electron/ai/types'

const LIVE = process.env.VERSTAK_LIVE_BROWSER === '1'

const PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Проверка правки</title></head>
<body>
  <h1>Локальный dev-сервер</h1>
  <form onsubmit="return false">
    <input id="q" placeholder="Запрос" />
    <button id="go" type="button">Найти</button>
  </form>
  <div id="result">пусто</div>
  <script>
    console.error('DEV_BOOT_ERROR: заглушка ошибки для проверки консоли');
    document.cookie = 'vsk_live=1; path=/';
    document.getElementById('go').addEventListener('click', function () {
      document.getElementById('result').textContent = 'НАЙДЕНО: ' + document.getElementById('q').value;
    });
  </script>
</body></html>`

let server: Server
let baseUrl = ''
/** Куки, которые сервер РЕАЛЬНО получил от браузера, по порядку запросов страницы. */
const cookiesSeen: string[] = []

beforeAll(async () => {
  if (!LIVE) return
  server = createServer((req, res) => {
    if ((req.url ?? '/') === '/') cookiesSeen.push(String(req.headers.cookie ?? ''))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/` : ''
})

afterAll(async () => {
  if (!LIVE) return
  setIsolatedLauncher(null)
  await closeAllIsolatedSessions()
  await new Promise<void>(r => server.close(() => r()))
})

let seq = 100
function ctxFor() {
  const exec = vi.fn(async () => ({ __err: 'встроенный браузер в живом смоуке недоступен' }))
  const ctx = {
    projectPath: 'C:/proj',
    sendId: ++seq,
    runId: 'live-run',
    // bypass — чтобы предмет проверки был СРЕДОЙ, а не порогом подтверждений: тот
    // судится отдельным паритетным пином (tests/security/browser-isolated-gate).
    agentMode: 'bypass',
    signal: new AbortController().signal,
    sender: { send: vi.fn(), exec },
    pendingAttachments: [] as Array<{ name: string; data: string }>,
    pendingCommands: new Map(),
    scopedKey: (s: number, c: string) => `${s}::${c}`,
    recordJournal: () => {},
    recordRunEvent: () => {},
  } as unknown as ToolContext
  return { ctx, exec }
}

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: 'live', name, args })

/** Сколько сейчас процессов браузера — грубая, но честная проверка «не осталось хвостов». */
function browserProcessCount(): number {
  if (process.platform !== 'win32') return -1
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq msedge.exe" /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf8' })
    return out.split('\n').filter(l => /msedge\.exe|chrome\.exe/i.test(l)).length
  } catch { return -1 }
}

const evidenceDir = join(tmpdir(), 'verstak-p3-live')

interface RunOutcome { readback: string; consoleText: string; screenshotBytes: number; mode: unknown }

/** Один полный проход сценария в ЧИСТОЙ сессии. Возвращает наблюдаемый итог. */
async function runScenario(tag: string): Promise<RunOutcome> {
  const { ctx } = ctxFor()

  const nav = await browserHandler.handle(call('browser_navigate', { url: baseUrl, env: 'isolated' }), ctx)
  expect(nav.error, `переход не удался: ${nav.error}`).toBeFalsy()
  const navResult = nav.result as Record<string, unknown>
  expect(navResult.mode).toBe('isolated')
  expect(String(navResult.session), 'подъём сессии не оставил следа в ответе').toMatch(/сессия поднята/)

  // Ошибки консоли — своя, не смешанная с чужими действиями.
  const cons = await browserHandler.handle(call('browser_console_errors'), ctx)
  const messages = (cons.result as { messages: Array<{ level: string; text: string }> }).messages
  const consoleText = messages.map(m => `${m.level}:${m.text}`).join('|')

  // Поиск → ввод → поиск → клик: ровно тот путь, которым ходит агент.
  const findField = await browserHandler.handle(call('browser_find', { query: 'Запрос' }), ctx)
  const field = (findField.result as { matches: Array<{ n: number }> }).matches[0]
  expect(field, 'поле ввода не найдено в чистой сессии').toBeTruthy()
  const typed = await browserHandler.handle(call('browser_type_by_number', { n: field.n, text: 'фикстура-' + tag }), ctx)
  expect(typed.error).toBeFalsy()

  const findBtn = await browserHandler.handle(call('browser_find', { query: 'Найти' }), ctx)
  const btn = (findBtn.result as { matches: Array<{ n: number }> }).matches[0]
  expect(btn, 'кнопка не найдена').toBeTruthy()
  const clicked = await browserHandler.handle(call('browser_click_by_number', { n: btn.n }), ctx)
  expect(clicked.error).toBeFalsy()

  const waited = await browserHandler.handle(call('browser_wait_for', { query: 'НАЙДЕНО', timeout_ms: 5000 }), ctx)
  expect(waited.error, 'результат клика не появился').toBeFalsy()

  const read = await browserHandler.handle(call('browser_read_page', { selector: '#result' }), ctx)
  const readback = String((read.result as { text: string }).text).trim()

  const shot = await browserHandler.handle(call('browser_screenshot'), ctx)
  expect(shot.error).toBeFalsy()
  const att = (ctx.pendingAttachments as Array<{ data: string }>)[0]
  const bytes = att ? Buffer.from(att.data, 'base64') : Buffer.alloc(0)
  if (bytes.length) {
    mkdirSync(evidenceDir, { recursive: true })
    writeFileSync(join(evidenceDir, `isolated-${tag}.png`), bytes)
  }

  const closed = await browserHandler.handle(call('browser_close_session'), ctx)
  expect((closed.result as { closed: boolean }).closed, 'сессия не закрылась').toBe(true)

  return { readback, consoleText, screenshotBytes: bytes.length, mode: navResult.mode }
}

describe.skipIf(!LIVE)('ЖИВАЯ ПРИЁМКА · чистая сессия на localhost', () => {
  it('сценарий проходится ДВАЖДЫ с одинаковым результатом, куки не переносятся, хвостов нет', async () => {
    const before = browserProcessCount()

    const first = await runScenario('run1')
    const second = await runScenario('run2')

    // 1. Сценарий работает: readback совпал с тем, что ввели и нажали.
    expect(first.readback).toBe('НАЙДЕНО: фикстура-run1')
    expect(second.readback).toBe('НАЙДЕНО: фикстура-run2')

    // 2. Повторяемость: всё, кроме подставленной строки, совпадает байт-в-байт.
    expect(second.consoleText).toBe(first.consoleText)
    expect(first.consoleText, 'ошибка консоли страницы не доехала до модели').toContain('DEV_BOOT_ERROR')
    expect(first.mode).toBe('isolated')
    expect(first.screenshotBytes).toBeGreaterThan(1000)
    expect(second.screenshotBytes).toBeGreaterThan(1000)

    // 3. ЧИСТОТА. Страница ставит куку `vsk_live` при каждой загрузке. Сервер видел
    //    ДВА запроса; если бы сессии делили профиль, во втором кука приехала бы.
    //    Пустой Cookie во ВТОРОМ запросе и есть доказательство, что профиль новый.
    expect(cookiesSeen).toHaveLength(2)
    expect(cookiesSeen[0], 'первая загрузка не должна нести кук').toBe('')
    expect(cookiesSeen[1], 'вторая сессия унаследовала куки первой — изоляции нет').toBe('')

    // 4. ХВОСТОВ НЕТ: реестр пуст, число процессов браузера вернулось к исходному.
    expect(isolatedSessionCount()).toBe(0)
    const after = browserProcessCount()
    if (before >= 0 && after >= 0) {
      expect(after, `процессы браузера остались жить: было ${before}, стало ${after}`).toBeLessThanOrEqual(before)
    }
  }, 120_000)
})
