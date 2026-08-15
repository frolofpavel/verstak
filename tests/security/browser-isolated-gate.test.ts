// P3 кусок 3 · ОБЯЗАТЕЛЬНЫЙ ПИН: гейты прав распространяются на изолированную
// (Playwright) среду ТАК ЖЕ, как на встроенную.
//
// ЧТО ИМЕННО СТЕРЕЖЁТСЯ. Вторая среда — это второй путь исполнения действия, меняющего
// чужую систему. Ровно так дважды ломался гейт браузера: SEC-CMD-06 (клик исполнялся
// во всех режимах, включая plan) и SEC-CMD-07 (вердикт `confirm` выносился верно, а
// хендлер его перебивал и всё равно шёл в страницу). Новая среда — третья возможность
// того же класса: достаточно выбрать её ВЫШЕ `resolveDecision`, и гейт останется на
// месте, выглядя поставленным.
//
// ПИН ПАРИТЕТНЫЙ, А НЕ ПОРОГОВЫЙ, И ЭТО ГЛАВНОЕ. Он не утверждает «в auto клик
// разрешён» — порог трения в ask/auto выбирает Павел по живым цифрам (постановка P3
// прямо выносит это из задачи). Он утверждает РАВЕНСТВО: что бы ни решил гейт для
// встроенной среды, изолированная получает ровно тот же исход. Поэтому пин переживёт
// смену порога и покраснеет ровно тогда, когда среды разойдутся.
//
// КОНТРОЛЬНЫЙ КЕЙС ОБЯЗАТЕЛЕН РЯДОМ С КАЖДЫМ «НЕ ПРОИЗОШЛО» (§3.1): «клик не дошёл до
// страницы» зелено и тогда, когда до страницы вообще ничего не доходит. Ниже у каждого
// запрета стоит режим, в котором тот же вызов ДОХОДИТ, — иначе пин ничего не измеряет.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { browserHandler } from '../../electron/ipc/tool-handlers/browser'
import { MUTATING_BROWSER_TOOLS } from '../../electron/ai/mode-policy'
import {
  setIsolatedLauncher, closeAllIsolatedSessions, isolatedSessionCount,
  type IsolatedBrowserApi, type IsolatedSession,
} from '../../electron/browser/isolated-session'
import { compilePermissionConfig } from '../../electron/ai/permission-rules'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { AgentMode } from '../../electron/ai/mode-policy'
import type { ToolCall } from '../../electron/ai/types'

/** Шпион страницы изолированной среды: предмет проверки — дошёл ли вызов до неё. */
function fakeApi() {
  const hit = vi.fn()
  const api: IsolatedBrowserApi = {
    navigate: async (url: string) => { hit('navigate', url); return { ok: true as const, url } },
    readPage: async () => { hit('readPage'); return 'текст' },
    click: async () => { hit('click'); return { ok: true as const, url: 'https://iso/' } },
    snapshot: async () => { hit('snapshot'); return { gen: 'g', count: 0, shown: 0, truncated: false, elements: [] } },
    find: async (q: string) => { hit('find'); return { query: q, count: 0, totalHits: 0, total: 0, truncated: false, matches: [] } },
    clickByNumber: async (n: number) => { hit('clickByNumber', n); return { ok: true as const, url: 'https://iso/' } },
    typeByNumber: async (n: number) => { hit('typeByNumber', n); return { ok: true as const, url: 'https://iso/' } },
    pressKey: async (k: string) => { hit('pressKey', k); return { ok: true as const, submitted: true, url: 'https://iso/' } },
    waitFor: async () => { hit('waitFor'); return { ok: true as const } },
    consoleMessages: async () => { hit('consoleMessages'); return [] },
    networkRequests: async () => { hit('networkRequests'); return [] },
    screenshot: async () => { hit('screenshot'); return '' },
    getURL: () => 'https://iso/',
    getTitle: () => 'iso',
  }
  return { api, hit }
}

/** Подменить запуск: изолированная сессия без настоящего браузера. */
function installFakeLauncher() {
  const { api, hit } = fakeApi()
  const closed = vi.fn()
  const launched = vi.fn()
  const session: IsolatedSession = {
    id: 'sess-fake',
    api,
    info: { browserLabel: 'Fake', source: 'system', headless: true },
    close: async () => { closed() },
  }
  setIsolatedLauncher(async () => { launched(); return { ok: true, session, reused: false } })
  return { hit, closed, launched }
}

let seq = 9000
function ctxFor(agentMode: AgentMode, rules?: ReturnType<typeof compilePermissionConfig>) {
  const exec = vi.fn(async () => ({ ok: true, url: 'https://builtin/' }))
  const ctx = {
    projectPath: 'C:/proj',
    sendId: ++seq,
    runId: 'run-iso',
    agentMode,
    permissionRules: rules,
    signal: new AbortController().signal,
    sender: { send: vi.fn(), exec },
    pendingAttachments: [],
    pendingCommands: new Map(),
    scopedKey: (s: number, c: string) => `${s}::${c}`,
    recordJournal: () => {},
    recordRunEvent: () => {},
  } as unknown as ToolContext
  return { ctx, exec }
}

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: 'iso-1', name, args })

/** Один вызов в изолированной среде: сначала navigate (поднимает сессию), потом действие. */
async function runIsolated(ctx: ToolContext, name: string, args: Record<string, unknown>) {
  await browserHandler.handle(call('browser_navigate', { url: 'http://localhost:5173', env: 'isolated' }), ctx)
  return browserHandler.handle(call(name, args), ctx)
}

afterEach(async () => {
  setIsolatedLauncher(null)
  await closeAllIsolatedSessions()
})

const ALL_MODES: AgentMode[] = ['ask', 'accept-edits', 'plan', 'auto', 'bypass']

describe('P3 кусок 3 · гейт прав одинаков для встроенной и изолированной среды', () => {
  // ЯДРО: паритет по всему кресту «режим × мутирующий инструмент». Пин не знает
  // сегодняшних порогов и потому не устареет при их смене.
  it('ПАРИТЕТ: исход гейта в чистой сессии совпадает со встроенной во всех режимах', async () => {
    for (const mode of ALL_MODES) {
      for (const tool of MUTATING_BROWSER_TOOLS) {
        const args = tool === 'browser_type_by_number' ? { n: 1, text: 'x' }
                   : tool === 'browser_press_key' ? { key: 'Enter' }
                   : tool === 'browser_click' ? { selector: 'Оплатить' }
                   : { n: 1 }

        const builtin = ctxFor(mode)
        const builtinRes = await browserHandler.handle(call(tool, args), builtin.ctx)
        const builtinBlocked = Boolean(builtinRes.error)
        const builtinReached = builtin.exec.mock.calls.length > 0

        const fake = installFakeLauncher()
        const iso = ctxFor(mode)
        const isoRes = await runIsolated(iso.ctx, tool, args)
        const isoBlocked = Boolean(isoRes.error)
        const isoReached = fake.hit.mock.calls.some(c => c[0] !== 'navigate')

        expect(isoBlocked, `${mode}/${tool}: вердикт в чистой сессии разошёлся со встроенной`).toBe(builtinBlocked)
        expect(isoReached, `${mode}/${tool}: доступ к странице в чистой сессии разошёлся со встроенной`).toBe(builtinReached)
        setIsolatedLauncher(null)
        await closeAllIsolatedSessions()
      }
    }
  })

  // Явная формулировка того же для самого дорогого случая — «только чтение».
  it('в режиме plan клик в чистой сессии НЕ доходит до страницы и браузер не поднимается', async () => {
    const fake = installFakeLauncher()
    const { ctx } = ctxFor('plan')

    const res = await browserHandler.handle(call('browser_click_by_number', { n: 2, env: 'isolated' }), ctx)

    expect(fake.hit, 'клик исполнился в чистой сессии в режиме «только чтение»').not.toHaveBeenCalled()
    expect(res.error, 'отказ должен быть назван').toBeTruthy()
    expect(String(res.error)).toMatch(/планирован|plan/i)
    // Гейт стоит ДО подъёма среды: запрещённое действие не должно даже открывать браузер.
    expect(fake.launched, 'браузер поднялся ради заведомо запрещённого действия').not.toHaveBeenCalled()
    expect(isolatedSessionCount()).toBe(0)
  })

  // КОНТРОЛЬ к предыдущему: тот же вызов в разрешающем режиме ДОХОДИТ до страницы.
  // Без него «не дошёл» был бы зелёным и на полностью нерабочем пути.
  it('КОНТРОЛЬ: в accept-edits тот же клик в чистой сессии доходит до страницы', async () => {
    const fake = installFakeLauncher()
    const { ctx } = ctxFor('accept-edits')

    const res = await runIsolated(ctx, 'browser_click_by_number', { n: 2 })

    expect(fake.hit.mock.calls.map(c => c[0])).toContain('clickByNumber')
    expect(res.error).toBeFalsy()
    expect((res.result as Record<string, unknown>).mode, 'ответ обязан называть среду').toBe('isolated')
  })

  // ЧТЕНИЕ в plan обязано работать и в чистой сессии — ради него режим и существует.
  it('КОНТРОЛЬ: чтение (snapshot/find) в plan в чистой сессии работает', async () => {
    for (const tool of ['browser_snapshot', 'browser_find']) {
      const fake = installFakeLauncher()
      const { ctx } = ctxFor('plan')
      const res = await runIsolated(ctx, tool, { query: 'отправить' })
      expect(res.error, `${tool} отвергнут в чистой сессии`).toBeFalsy()
      expect(fake.hit.mock.calls.map(c => c[0]), `${tool} не дошёл до страницы`).toContain(tool.replace('browser_', ''))
      setIsolatedLauncher(null)
      await closeAllIsolatedSessions()
    }
  })

  // ДЕКЛАРАТИВНЫЕ ПРАВИЛА (permissions.json) — тот же слой, та же сила. Правило пишут
  // про ИНСТРУМЕНТ, а не про среду; если бы изоляция шла мимо resolveDecision, deny
  // молча перестал бы действовать именно там, где человек просил чистоту.
  it('permissions deny действует и в чистой сессии', async () => {
    const rules = compilePermissionConfig({ deny: ['browser_click_by_number'] })
    const fake = installFakeLauncher()
    const { ctx } = ctxFor('auto', rules)

    await browserHandler.handle(call('browser_navigate', { url: 'http://localhost:5173', env: 'isolated' }), ctx)
    const res = await browserHandler.handle(call('browser_click_by_number', { n: 1 }), ctx)

    expect(res.error, 'deny-правило не сработало в чистой сессии').toBeTruthy()
    expect(String(res.error)).toMatch(/permissions|deny/i)
    expect(fake.hit.mock.calls.map(c => c[0])).not.toContain('clickByNumber')
  })

  // КОНТРОЛЬ к deny: без правила тот же вызов проходит — значит красное выше
  // именно от правила, а не от сломанного пути.
  it('КОНТРОЛЬ: без deny-правила тот же вызов в чистой сессии проходит', async () => {
    const fake = installFakeLauncher()
    const { ctx } = ctxFor('auto')
    const res = await runIsolated(ctx, 'browser_click_by_number', { n: 1 })
    expect(res.error).toBeFalsy()
    expect(fake.hit.mock.calls.map(c => c[0])).toContain('clickByNumber')
  })
})
