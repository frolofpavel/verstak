// Клик в браузере обязан оставлять след (30.07).
//
// ЗАЧЕМ ЭТО ОТДЕЛЬНАЯ РАБОТА, А НЕ КОСМЕТИКА. Постановка звучала «насколько чаще
// человека будут спрашивать, если поставить гейт на клик» — и оказалось, что
// ответа нет ни у кого: `summarizeToolCall` не имеет ветки для browser_click
// (shared.ts), поэтому возвращает null, а `emitActivity` вызывается только при
// непустой сводке (browser.ts) — клика нет ни в Timeline, ни в audit-log.
// Значит порог гейта пришлось бы выбирать по догадке. Сначала измеримость,
// потом решение — цифра раньше модалки.
//
// ВТОРАЯ ПОЛОВИНА ХУЖЕ ПЕРВОЙ: журнал не молчал, а ВРАЛ. Тернарник метки
// (browser.ts) покрывал navigate и read_page, а всё остальное записывал как
// «Браузер: скриншот» — то есть клик по кнопке попадал в журнал проекта
// скриншотом. Отсутствие следа человек может заметить, ложный след — нет.
//
// ПОЧЕМУ В detail И СЕЛЕКТОР, И URL: без URL через неделю в логе будет видно
// «сколько кликов», но не «куда» — а для выбора порога нужно именно второе.
import { describe, it, expect, vi } from 'vitest'
import { browserHandler } from '../../electron/ipc/tool-handlers/browser'
import { summarizeToolCall } from '../../electron/ipc/tool-handlers/shared'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { ToolCall } from '../../electron/ai/types'

interface Recorded { events: Array<Record<string, unknown>>; journal: Array<{ label: string; detail: string | null }> }

/**
 * Контекст с подставным webview: `sender.exec` не ходит в renderer, а
 * возвращает то, что вернул бы настоящий `api.click` — { ok, url }.
 */
function ctxFor(execResult: unknown): { ctx: ToolContext; rec: Recorded } {
  const rec: Recorded = { events: [], journal: [] }
  const ctx = {
    projectPath: 'C:/proj',
    sendId: 1,
    runId: 'run-1',
    agentMode: 'auto',
    sender: {
      send: (_ch: string, payload: { event: Record<string, unknown> }) => { rec.events.push(payload.event) },
      exec: async () => execResult,
    },
    pendingAttachments: [],
    recordJournal: (_p: string, _k: string, label: string, detail: string | null) => { rec.journal.push({ label, detail }) },
    recordRunEvent: () => {},
  } as unknown as ToolContext
  return { ctx, rec }
}

const clickCall = (selector: string): ToolCall => ({ id: 'b1', name: 'browser_click', args: { selector } })

describe('browser_click оставляет след', () => {
  it('сводка вызова существует — без неё клика нет ни в Timeline, ни в audit-log', () => {
    const s = summarizeToolCall('browser_click', { selector: 'Отправить' }, undefined)

    expect(s, 'summarizeToolCall не знает про клик — активность не эмитится вовсе').toBeTruthy()
    expect(s!.label).toBe('browser_click')
  })

  it('в сводку попадает И селектор, И адрес страницы', async () => {
    const { ctx, rec } = ctxFor({ ok: true, url: 'https://example.com/cart' })

    await browserHandler.handle(clickCall('Оплатить'), ctx)

    const activity = rec.events.find(e => e.type === 'tool-activity')
    expect(activity, 'события активности нет — клик невидим').toBeTruthy()
    const detail = String(activity!.detail)
    expect(detail, 'не видно, по чему кликнули').toContain('Оплатить')
    expect(detail, 'не видно, где кликнули — «сколько» без «куда» для выбора порога бесполезно').toContain('example.com')
  })

  it('журнал больше не называет клик скриншотом', async () => {
    const { ctx, rec } = ctxFor({ ok: true, url: 'https://example.com/cart' })

    await browserHandler.handle(clickCall('Оплатить'), ctx)

    expect(rec.journal).toHaveLength(1)
    expect(rec.journal[0].label, 'клик записан в журнал проекта как скриншот').not.toContain('скриншот')
    expect(rec.journal[0].label.toLowerCase()).toContain('клик')
  })

  // КОНТРОЛЬ: соседние инструменты не задеты — их сводки и метки прежние.
  it('контроль: navigate и read_page записываются как раньше', async () => {
    const nav = ctxFor({ ok: true })
    await browserHandler.handle({ id: 'n1', name: 'browser_navigate', args: { url: 'https://example.com' } }, nav.ctx)
    expect(nav.rec.journal[0].label).toContain('example.com')

    const read = ctxFor({ url: 'https://example.com', title: 'T', text: 'x' })
    await browserHandler.handle({ id: 'r1', name: 'browser_read_page', args: {} }, read.ctx)
    expect(read.rec.journal[0].label).toContain('прочитан текст')
  })

  // КОНТРОЛЬ: провалившийся клик тоже виден, и виден именно как провал —
  // иначе «следа нет» и «клик не сработал» снова неразличимы.
  it('контроль: неудачный клик отмечается ошибкой, а не тишиной', async () => {
    const { ctx, rec } = ctxFor({ __err: 'Вкладка Browser не открыта' })

    const res = await browserHandler.handle(clickCall('Отправить'), ctx)

    expect(res.error).toBeTruthy()
    const activity = rec.events.find(e => e.type === 'tool-activity')
    expect(activity!.status).toBe('error')
    expect(rec.journal, 'провалившийся клик не должен попадать в журнал как сделанный').toHaveLength(0)
  })
})
