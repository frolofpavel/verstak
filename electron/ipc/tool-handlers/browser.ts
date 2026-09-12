// Browser-хендлер: navigate / read_page / screenshot. Вынесено при распиле.
// P3 кусок 3: тот же хендлер обслуживает ДВЕ среды — встроенный браузер и
// изолированную (Playwright) сессию. Второго набора инструментов нет: различается
// только получатель вызова, выбираемый полем `env` (см. shared/browser-env.ts).
import type { ToolHandler, ToolContext } from './shared'
import type { ToolCall, ToolResult } from '../../ai/types'
import { emitActivity, summarizeToolCall, awaitCommandConfirm } from './shared'
import { addProofFrame } from '../../ai/proof-frames'
import { resolveDecision } from '../../ai/permission-rules'
import { blockReason } from '../../ai/mode-policy'
import { execAwaitingBrowserApi, isBrowserNotReady } from './browser-ready'
import { capConsoleErrors, capNetwork } from './browser-redact'
import { readCapture } from '../../browser/network-capture'
import {
  resolveBrowserEnv, localhostEnvHint, BROWSER_ENV_LABEL, type BrowserEnv,
} from '../../../shared/browser-env'
import {
  openIsolatedSession, getIsolatedSession, closeIsolatedSession,
  getActiveBrowserEnv, setActiveBrowserEnv, type IsolatedBrowserApi,
} from '../../browser/isolated-session'
import type { BrowserController } from '../../ai/browser/controller'
import type { BrowserActionType } from '../../ai/browser/types'

const TOOL_TO_ACTION: Partial<Record<string, BrowserActionType>> = {
  browser_navigate: 'navigate',
  browser_read_page: 'observe',
  browser_click: 'click',
  browser_screenshot: 'screenshot',
}

export interface BrowserHandlerDeps {
  controller?: BrowserController
  resolveTaskId?: (ctx: ToolContext) => string
  emitPendingBrowserAction?: (ctx: ToolContext, payload: {
    callId: string
    actionId: string
    browserTaskId: string
    runId: string
    risk: string
    decision: string
    approvalDigest: string
    snapshot: unknown
    reason: string
  }) => void
  awaitBrowserApproval?: (
    ctx: ToolContext,
    actionId: string,
    abortSignal: AbortSignal,
  ) => Promise<{ approved: boolean; approvalDigest: string }>
  approvalTimeoutMs?: number
}

let depsRef: BrowserHandlerDeps = {}
export const BROWSER_APPROVAL_TIMEOUT_MS = 2 * 60 * 1000

export function configureBrowserHandler(deps: BrowserHandlerDeps): void {
  depsRef = { ...deps }
}

async function dispatchLegacyBrowser(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  try {
    // Args are JSON-stringified once and embedded via JSON.stringify(JSON.stringify(...))
    // so the runtime JSON.parse is the only thing that touches LLM-supplied data.
    const argsLiteral = JSON.stringify(JSON.stringify(call.args ?? {}))
    let action: string
    if (call.name === 'browser_navigate') {
      action = `return await api.navigate(String(a.url ?? ''));`
    } else if (call.name === 'browser_read_page') {
      action = `const text = await api.readPage(a.selector ? String(a.selector) : undefined);
                return { url: api.getURL(), title: api.getTitle(), text };`
    } else if (call.name === 'browser_snapshot') {
      // VSK-BROWSER-B1 этап 1: структурный снимок с пронумерованными элементами.
      action = `const snap = await api.snapshot();
                return { url: api.getURL(), title: api.getTitle(), ...snap };`
    } else if (call.name === 'browser_find') {
      // VSK-BROWSER-B2: ОСНОВНОЙ путь адресации — найти элементы по запросу и вернуть
      // их номера (годны для клика/ввода). Дешевле полного снимка на 91–99% (замер 02.08).
      action = `const r = await api.find(String(a.query ?? ''), a.limit != null ? Number(a.limit) : undefined);
                return { url: api.getURL(), title: api.getTitle(), ...r };`
    } else if (call.name === 'browser_click_by_number') {
      // Клик по номеру ИЗ ПОСЛЕДНЕГО снимка. Устаревший номер (после навигации) →
      // честная ошибка из api.clickByNumber, а не угадывание.
      action = `return await api.clickByNumber(Number(a.n));`
    } else if (call.name === 'browser_type_by_number') {
      // Ввод по номеру (заполнение форм). Устаревший номер / не поле → честная ошибка.
      action = `return await api.typeByNumber(Number(a.n), String(a.text ?? ''));`
    } else if (call.name === 'browser_press_key') {
      // Д3: отправка формы. Цель — поле с фокусом либо номер из снимка; проверка
      // допустимости клавиши живёт в vskPressKey (одна реализация на схему,
      // исполнитель и гейт), поэтому здесь только передача аргументов.
      action = `return await api.pressKey(String(a.key ?? ''), a.n != null ? Number(a.n) : undefined);`
    } else if (call.name === 'browser_wait_for') {
      // Ожидание элемента с честным таймаутом (не слепая пауза).
      action = `return await api.waitFor(String(a.query ?? ''), a.timeout_ms != null ? Number(a.timeout_ms) : undefined);`
    } else if (call.name === 'browser_console_errors') {
      // B2: сырой буфер консоли; фильтр «error/warning» + редакция — в main ниже.
      action = `const raw = await api.consoleMessages(); return { url: api.getURL(), __raw: raw };`
    } else if (call.name === 'browser_network') {
      // B2: сырые записи сети; ограничение + редакция (маска auth-заголовков) — в main ниже.
      action = `const raw = await api.networkRequests(); return { url: api.getURL(), __raw: raw };`
    } else if (call.name === 'browser_click') {
      action = `return await api.click(String(a.selector ?? ''));`
    } else {
      action = `const dataUrl = await api.screenshot();
                return { url: api.getURL(), dataUrl };`
    }
    // __vskNotReady (не __err): браузер ещё монтируется, window.verstakBrowser нет.
    // Отличаем от настоящей ошибки, чтобы execAwaitingBrowserApi дождался готовности,
    // а не сдался с первого раза (устранение стартовой гонки — browser-ready.ts).
    const snippet = `(async () => {
      const api = window.verstakBrowser;
      if (!api) return { __vskNotReady: true };
      const a = JSON.parse(${argsLiteral});
      ${action}
    })()`
    const result = await execAwaitingBrowserApi(snippet, { exec: (code) => ctx.sender.exec(code) })
    if (isBrowserNotReady(result)) {
      // API не появился за предел — браузер не поднялся (редкий отказ рендера, не «вкладка закрыта»).
      return { id: call.id, name: call.name, result: '', error: 'Браузер ещё поднимался и не успел стать готов за отведённое время — повтори попытку.' }
    }
    if (result && typeof result === 'object' && '__err' in result) {
      return { id: call.id, name: call.name, result: '', error: String((result as { __err: unknown }).__err) }
    }
    // B2: РЕДАКЦИЯ консоли/сети в main (secret-scanner здесь, не в renderer) — сырьё
    // модели не отдаём (требование №4). Ограниченный список ошибок/предупреждений.
    if ((call.name === 'browser_console_errors' || call.name === 'browser_network') && result && typeof result === 'object') {
      const r = result as { url?: unknown; __raw?: unknown }
      const limit = call.args.limit != null ? Number(call.args.limit) : (call.name === 'browser_console_errors' ? 20 : 30)
      const pageRaw = Array.isArray(r.__raw) ? r.__raw : []
      if (call.name === 'browser_console_errors') {
        return { id: call.id, name: call.name, result: { url: r.url ?? null, ...capConsoleErrors(pageRaw, limit) } }
      }
      // browser_network: ОСНОВНОЙ источник — захват main (session.webRequest): полная
      // сеть вкладки, включая запросы загрузки, которые page-рекордер (инжект на
      // dom-ready) не видит — оттого сеть была пустой. Fallback на page __vskNet, если
      // захват main пуст (среда без webRequest, например тесты). Редакция — та же.
      const mainRaw = readCapture()
      const raw = mainRaw.length > 0 ? mainRaw : pageRaw
      return { id: call.id, name: call.name, result: { url: r.url ?? null, ...capNetwork(raw, limit) } }
    }
    return { id: call.id, name: call.name, result: result ?? '' }
  } catch (err) {
    return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
  }

}

async function dispatchBrowser(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const actionType = TOOL_TO_ACTION[call.name] ?? null
  const controller = depsRef.controller
  // Новое ядро обслуживает общий вертикальный набор. Остальные зрелые инструменты
  // встроенного/изолированного браузера продолжают идти по прежнему адаптеру.
  if (!controller) {
    if (ctx.browserTaskId) {
      return {
        id: call.id,
        name: call.name,
        result: '',
        error: 'BrowserController не сконфигурирован — browser action заблокирован (fail-closed).',
      }
    }
    return dispatchLegacyBrowser(call, ctx)
  }
  if (!actionType) return dispatchLegacyBrowser(call, ctx)

  const taskId = depsRef.resolveTaskId ? depsRef.resolveTaskId(ctx) : `bt-${ctx.runId ?? ctx.sendId}`
  const runId = ctx.runId ?? `run-${ctx.sendId}`
  const args = call.args ?? {}

  // ── R3 path: показываем approval UI, ждём consume ─────────────────────
  // Сначала propose (без approval). Если decision=require-approval → emit.
  const proposeResult = await controller.dispatch({
    browserTaskId: taskId,
    runId,
    actionType,
    payload: args as Record<string, unknown>,
    scope: {},
  })

  if (proposeResult.decision.kind === 'block') {
    return { id: call.id, name: call.name, result: '', error: proposeResult.error ?? 'blocked by policy' }
  }

  if (proposeResult.pendingApproval && proposeResult.decision.kind === 'require-approval') {
    // Emit ai:event для renderer'а показать approval modal.
    if (depsRef.emitPendingBrowserAction) {
      depsRef.emitPendingBrowserAction(ctx, {
        callId: call.id,
        actionId: proposeResult.actionId,
        browserTaskId: taskId,
        runId,
        risk: proposeResult.risk,
        decision: proposeResult.decision.kind,
        approvalDigest: proposeResult.pendingApproval.approvalDigest,
        snapshot: proposeResult.pendingApproval.snapshot,
        reason: proposeResult.decision.reason,
      })
    }
    // Ждём решения UI.
    if (depsRef.awaitBrowserApproval) {
      const approval = await waitForBrowserApproval(
        depsRef.awaitBrowserApproval(ctx, proposeResult.actionId, ctx.signal),
        depsRef.approvalTimeoutMs ?? BROWSER_APPROVAL_TIMEOUT_MS,
      )
      const { approved, approvalDigest } = approval
      if (!approved) {
        const error = approval.timedOut
          ? 'Approval UI не ответил вовремя — browser action безопасно отменён.'
          : approval.failed
            ? `Approval UI недоступен — browser action отменён: ${approval.failed}`
            : 'Пользователь отклонил browser action.'
        return { id: call.id, name: call.name, result: '', error }
      }
      // R1 Block 3: approveAndExecute берёт action из ledger по actionId.
      // Digest из UI — для сверки контроллером (canonical digest должен совпасть).
      const execResult = await controller.approveAndExecute(proposeResult.actionId, approvalDigest)
      return finalizeBrowserResult(call, execResult, ctx)
    }
    // Нет awaitBrowserApproval — не можем ждать UI; возвращаем модель как error.
    return { id: call.id, name: call.name, result: '', error: 'Требуется approval browser action, но UI transport не сконфигурирован.' }
  }

  // ── R0/R1/R2 auto path — результат уже в proposeResult ─────────────────
  return finalizeBrowserResult(call, proposeResult, ctx)
}

async function waitForBrowserApproval(
  pending: Promise<{ approved: boolean; approvalDigest: string }>,
  timeoutMs: number,
): Promise<{ approved: boolean; approvalDigest: string; timedOut?: boolean; failed?: string }> {
  const boundedMs = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, BROWSER_APPROVAL_TIMEOUT_MS)) : BROWSER_APPROVAL_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      pending.catch(err => ({
        approved: false,
        approvalDigest: '',
        failed: err instanceof Error ? err.message : String(err),
      })),
      new Promise<{ approved: false; approvalDigest: ''; timedOut: true }>(resolve => {
        timer = setTimeout(() => resolve({ approved: false, approvalDigest: '', timedOut: true }), boundedMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function finalizeBrowserResult(call: ToolCall, r: import('../../ai/browser/controller').DispatchResult, ctx: ToolContext): ToolResult {
  if (!r.ok && !r.result) {
    return { id: call.id, name: call.name, result: '', error: r.error ?? 'browser action failed' }
  }
  const status = r.result?.status ?? 'verified'
  if (status === 'blocked') {
    return { id: call.id, name: call.name, result: '', error: `Blocked: ${r.result?.reason ?? 'неизвестно'} — ${r.result?.detail ?? ''}` }
  }
  if (status === 'failed') {
    return { id: call.id, name: call.name, result: '', error: `Failed: ${r.result?.detail ?? 'неизвестно'}` }
  }
  // verified / uncertain. R1 Block 5: модель получает UNTRUSTED ENVELOPE
  // (r.observationForModel.text — это warning + scanText-redacted text), а НЕ
  // raw obs.text. Контент страницы — данные, не инструкции.
  const result: Record<string, unknown> = {
    actionId: r.actionId,
    risk: r.risk,
    status,
    finalUrl: r.result?.finalUrl ?? null,
  }
  if (status === 'uncertain') {
    result.warning = 'Действие выполнено с неясным результатом. Перечитай страницу перед следующим шагом; НЕ повторяй это действие автоматически.'
  }
  if (r.observationForModel) {
    // Untrusted envelope — главная поверхность для модели. Включает warning
    // о недоверенном содержимом первой строкой + redacted text/tables/controls.
    result.observationText = r.observationForModel.text
    if (r.observationForModel.redactionHits.length > 0) {
      result.redacted = r.observationForModel.redactionHits
    }
    if (r.observationForModel.truncated) {
      result.truncated = true
    }
  } else if (r.result?.postObservation) {
    // Fallback: если controller не собрал envelope (R0 без runExecute path),
    // передаём минимальные метаданные без raw text.
    const obs = r.result.postObservation
    result.url = obs.source.url
    result.title = obs.source.title
    result.origin = obs.source.origin
    result.tenant = obs.tenant
    result.account = obs.account
  }
  if (r.result?.postObservation?.screenshotDataUrl) {
    // R1 Block 5: screenshot уже прошёл isScreenshotSafeForModel в controller
    // (fail-closed на sensitive URL). Если он дошёл сюда — можно передать.
    result.screenshotAttached = true
    try {
      const m = /^data:(image\/[\w+-]+);base64,(.+)$/.exec(r.result.postObservation.screenshotDataUrl)
      if (m) {
        ctx.pendingAttachments.push({
          name: `screenshot-${Date.now()}.png`,
          mimeType: m[1],
          data: m[2],
          size: Math.floor(m[2].length * 0.75),
        })
        try { addProofFrame(Number(ctx.sendId), Buffer.from(m[2], 'base64')) } catch { /* best-effort */ }
      }
    } catch { /* ignore */ }
  }
  return { id: call.id, name: call.name, result }
}

/**
 * ДЕЙСТВИЯ, общие для обеих сред. Список, а не память автора правки: пин сверяет его
 * с обоими диспетчерами сразу, поэтому новый browser-инструмент, забытый в
 * изолированной среде, краснеет, а не отдаёт молча не то (тот же приём, что
 * MUTATING_BROWSER_TOOLS в mode-policy).
 */
export const BROWSER_ACTION_TOOLS: readonly string[] = [
  'browser_navigate', 'browser_read_page', 'browser_snapshot', 'browser_find',
  'browser_click_by_number', 'browser_type_by_number', 'browser_press_key',
  'browser_wait_for', 'browser_console_errors', 'browser_network',
  'browser_click', 'browser_screenshot',
]

/** Инструмент жизненного цикла среды — действием над страницей не является. */
export const BROWSER_SESSION_TOOL = 'browser_close_session'

/**
 * Тот же набор действий, исполненный в ИЗОЛИРОВАННОЙ сессии. Читается рядом с
 * dispatchBrowser намеренно: видно, что имена, аргументы и форма ответа совпадают.
 *
 * Незнакомое имя — ЧЕСТНАЯ ОШИБКА, а не «всё остальное — скриншот» (как в ветке
 * встроенного пути): молчаливая подмена действия неотличима от выполнения.
 */
async function dispatchIsolated(call: ToolCall, api: IsolatedBrowserApi): Promise<ToolResult> {
  const a = call.args ?? {}
  const ok = (result: unknown): ToolResult => ({ id: call.id, name: call.name, result: result ?? '' })
  try {
    switch (call.name) {
      case 'browser_navigate':
        return ok(await api.navigate(String(a.url ?? '')))
      case 'browser_read_page': {
        const text = await api.readPage(a.selector ? String(a.selector) : undefined)
        return ok({ url: api.getURL(), title: api.getTitle(), text })
      }
      case 'browser_snapshot': {
        const snap = await api.snapshot()
        return ok({ url: api.getURL(), title: api.getTitle(), ...snap })
      }
      case 'browser_find': {
        const r = await api.find(String(a.query ?? ''), a.limit != null ? Number(a.limit) : undefined)
        return ok({ url: api.getURL(), title: api.getTitle(), ...r })
      }
      case 'browser_click_by_number':
        return ok(await api.clickByNumber(Number(a.n)))
      case 'browser_type_by_number':
        return ok(await api.typeByNumber(Number(a.n), String(a.text ?? '')))
      case 'browser_press_key':
        return ok(await api.pressKey(String(a.key ?? ''), a.n != null ? Number(a.n) : undefined))
      case 'browser_wait_for':
        return ok(await api.waitFor(String(a.query ?? ''), a.timeout_ms != null ? Number(a.timeout_ms) : undefined))
      case 'browser_console_errors': {
        // Редакция — ТА ЖЕ (secret-scanner в main), лимит по умолчанию тот же.
        const limit = a.limit != null ? Number(a.limit) : 20
        return ok({ url: api.getURL(), ...capConsoleErrors(await api.consoleMessages(), limit) })
      }
      case 'browser_network': {
        // ВАЖНО: НЕ readCapture(). Тот захват принадлежит сессии встроенного
        // браузера — то есть содержит трафик РУЧНЫХ действий человека. Подмешать его
        // в чистую сессию значило бы уничтожить ровно то свойство, ради которого эта
        // среда построена, и сделать это молча.
        const limit = a.limit != null ? Number(a.limit) : 30
        return ok({ url: api.getURL(), ...capNetwork(await api.networkRequests(), limit) })
      }
      case 'browser_click':
        return ok(await api.click(String(a.selector ?? '')))
      case 'browser_screenshot':
        return ok({ url: api.getURL(), dataUrl: await api.screenshot() })
      default:
        return { id: call.id, name: call.name, result: '', error: `Инструмент ${call.name} не поддержан в чистой сессии.` }
    }
  } catch (err) {
    return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
  }
}

/** Обеспечить сессию для изолированного вызова: create или reuse, либо честный отказ. */
async function ensureIsolated(call: ToolCall, ctx: ToolContext): Promise<{ ok: true; api: IsolatedBrowserApi; opened: boolean; note?: string } | { ok: false; error: string }> {
  const existing = getIsolatedSession(ctx.sendId)
  if (existing) return { ok: true, api: existing.api, opened: false }
  if (call.name !== 'browser_navigate') {
    return { ok: false, error: 'Чистая сессия ещё не открыта. Начни с browser_navigate с env="isolated" — она поднимется под эту задачу и закроется вместе с ней.' }
  }
  const opened = await openIsolatedSession(ctx.sendId, { signal: ctx.signal })
  // ОТКАЗ НЕ ПОДМЕНЯЕТСЯ ВСТРОЕННЫМ БРАУЗЕРОМ (рамка волны §3 п.5). Просили чистоту —
  // тихо отдать сессию с куками человека было бы худшим из возможных исходов.
  if (!opened.ok) return { ok: false, error: opened.error }
  const info = opened.session.info
  return {
    ok: true,
    api: opened.session.api,
    opened: !opened.reused,
    note: `Чистая сессия поднята: ${info.browserLabel}${info.headless ? '' : ' (с окном)'}, свой временный профиль, кук пользователя нет.`,
  }
}

export const browserHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    // ЖИЗНЕННЫЙ ЦИКЛ СРЕДЫ идёт до гейта режима сознательно: закрытие своей же
    // временной сессии ничего в чужой системе не меняет, а запретить прибрать за
    // собой значило бы оставлять процессы (урок C7).
    if (call.name === BROWSER_SESSION_TOOL) {
      const closed = await closeIsolatedSession(ctx.sendId)
      const result = { closed, mode: 'builtin' as BrowserEnv }
      try { ctx.recordJournal(ctx.projectPath, 'tool', closed ? 'Браузер: чистая сессия закрыта' : 'Браузер: чистой сессии не было', null) } catch { /* журнал не критичен */ }
      // Подпись берётся у summarizeToolCall, а не пишется здесь второй раз: сетка
      // browser-activity-labels требует её от КАЖДОГО браузерного инструмента, и две
      // копии текста разошлись бы, оставив сетку зелёной на своей.
      const s = summarizeToolCall(call.name, call.args, result)
      if (s) emitActivity(ctx, call, 'ok', s.label, s.detail)
      return { id: call.id, name: call.name, result }
    }

    // ВЫБОР СРЕДЫ — чистая функция над аргументом и состоянием прогона. Незнакомое
    // значение останавливает вызов честной ошибкой, а не откатом в дефолт.
    const envRes = resolveBrowserEnv((call.args ?? {}).env, getActiveBrowserEnv(ctx.sendId))
    if (!envRes.ok) {
      return { id: call.id, name: call.name, result: '', error: envRes.error }
    }
    const env: BrowserEnv = envRes.env

    // ГЕЙТ РЕЖИМА (SEC-CMD-06). До 30.07 этот файл не звал ни resolveDecision,
    // ни decide — клик исполнялся во всех пяти режимах, включая `plan`, где
    // запрещено даже писать файл. Клик меняет ЧУЖУЮ систему: страница
    // залогинена, нажатие может отправить, опубликовать, удалить, оплатить.
    //
    // Звать resolveDecision было бы мало: mode-policy перехватывала незнакомое
    // имя раньше switch по режиму и отдавала auto-accept — врезка выглядела бы
    // поставленной и не срабатывала. Категория заведена в самой mode-policy
    // (MUTATING_BROWSER_TOOLS), поэтому гейт работает и для будущих
    // мутирующих браузерных инструментов, а не только для клика.
    //
    // Порог для остальных режимов здесь НЕ решается: сегодня блокируется только
    // `plan`. Спрашивать ли в `ask`/`auto` — выбор человека по фактическим
    // цифрам, которые копит наблюдаемость клика (b13e9e1).
    const { decision, reason: denyReason } = resolveDecision(call.name, call.args, ctx.agentMode, ctx.autoApprove, ctx.permissionRules, ctx.capabilityTrust)
    if (decision === 'block') {
      const reason = denyReason ?? blockReason(call.name, ctx.agentMode)
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-blocked', callId: call.id, name: call.name, command: String(call.args.selector ?? call.args.url ?? ''), reason }
      })
      return { id: call.id, name: call.name, result: '', error: reason }
    }
    // ВЕРДИКТ confirm ТОЖЕ ОБЯЗАН ОСТАНАВЛИВАТЬ (SEC-CMD-07). До этой ветки
    // хендлер знал единственный вердикт — `block`, а `confirm` молча
    // проваливался в исполнение ниже. Значит правило `ask` пользователя не
    // работало, и любой будущий классификатор URL был бы ложно-зелёным: вердикт
    // верный, навигация всё равно происходит. Тот же класс, что bash_allowlist,
    // где вердикт был верен, а хендлер его перебивал.
    // Поток подтверждения переиспользуем у коннекторов (pending-command +
    // awaitCommandConfirm): другого канала «спросить человека про не-команду» в
    // системе нет. ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ: модалка озаглавлена как команда —
    // текст в зоне интерфейса, записан в долг (STATUS.md).
    if (decision === 'confirm') {
      const target = String(call.args.url ?? call.args.selector ?? '')
      const summary = call.name === 'browser_navigate' ? `Переход в браузере: ${target}` : `Клик в браузере: ${target}`
      ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'pending-command', callId: call.id, command: summary, toolName: call.name, sendId: ctx.sendId } })
      const accepted = await awaitCommandConfirm(ctx, call.id, { toolName: call.name, subject: summary })
      if (!accepted) {
        ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'command-result', callId: call.id, command: summary, status: 'rejected' } })
        return { id: call.id, name: call.name, result: '', error: 'User rejected' }
      }
    }
    // МАРШРУТИЗАЦИЯ СРЕД — СТРОГО ПОСЛЕ ГЕЙТА. Порядок здесь и есть гарантия: гейт
    // судит по имени инструмента и аргументам, о среде он не знает вовсе, поэтому
    // клик в чистой сессии физически не может обойти то, что останавливает клик во
    // встроенной. Врезать выбор среды ВЫШЕ гейта значило бы завести второй путь
    // исполнения мимо resolveDecision — ровно тот класс, который SEC-CMD-06/07
    // закрывали дважды.
    let result: ToolResult
    let openNote: string | undefined
    if (env === 'isolated') {
      const ready = await ensureIsolated(call, ctx)
      if (!ready.ok) {
        return { id: call.id, name: call.name, result: '', error: ready.error }
      }
      openNote = ready.note
      // Среда становится активной ТОЛЬКО после успешного подъёма: иначе неудачная
      // попытка изоляции заперла бы прогон в среде, которой нет.
      setActiveBrowserEnv(ctx.sendId, 'isolated')
      result = await dispatchIsolated(call, ready.api)
    } else {
      setActiveBrowserEnv(ctx.sendId, 'builtin')
      result = await dispatchBrowser(call, ctx)
    }
    // Journal what AI looked at on the web
    try {
      if (!result.error) {
        const url = String(call.args.url ?? '')
        // Метка ПОИМЁННАЯ, а не «всё остальное — скриншот». Прежний тернарник
        // знал navigate и read_page, а клик записывал в журнал проекта как
        // скриншот: журнал не молчал о клике, он о нём ВРАЛ. Отсутствие следа
        // человек ещё может заметить, ложный след — нет.
        // Метка ПОИМЁННАЯ: журнал не должен ВРАТЬ, что снимок/клик-по-номеру —
        // «скриншот» (тот же класс ошибки, что закрыт для самого клика ниже).
        const label = call.name === 'browser_navigate' ? `Браузер → ${url}`
                    : call.name === 'browser_read_page' ? `Браузер: прочитан текст`
                    : call.name === 'browser_snapshot' ? `Браузер: снимок страницы`
                    : call.name === 'browser_find' ? `Браузер: поиск «${String(call.args.query ?? '')}»`
                    : call.name === 'browser_click_by_number' ? `Браузер: клик по элементу №${String(call.args.n ?? '')}`
                    : call.name === 'browser_type_by_number' ? `Браузер: ввод в элемент №${String(call.args.n ?? '')}`
                    : call.name === 'browser_press_key' ? `Браузер: нажата клавиша ${String(call.args.key ?? '')}`
                    : call.name === 'browser_wait_for' ? `Браузер: ожидание «${String(call.args.query ?? '')}»`
                    : call.name === 'browser_console_errors' ? `Браузер: чтение консоли`
                    : call.name === 'browser_network' ? `Браузер: чтение сети`
                    : call.name === 'browser_click' ? `Браузер: клик по «${String(call.args.selector ?? '')}»`
                    : `Браузер: скриншот`
        // Для клика (обоих видов) в журнал едет и адрес страницы — см. summarizeToolCall.
        const clicked = (call.name === 'browser_click' || call.name === 'browser_click_by_number') && result.result && typeof result.result === 'object'
          ? String((result.result as { url?: unknown }).url ?? '')
          : ''
        // След среды в журнале ставится ТОЛЬКО для чистой сессии: у встроенной метка
        // остаётся прежней (её читают существующие пины), а необычное — именно
        // изоляция, и в журнале человека она обязана быть названа.
        const labelled = env === 'isolated' ? `${label} [${BROWSER_ENV_LABEL.isolated}]` : label
        ctx.recordJournal(ctx.projectPath, 'tool', labelled, clicked || null)
      }
    } catch { /* journal not critical */ }
    // Screenshot → queue as attachment for next user message
    if (call.name === 'browser_screenshot' && !result.error) {
      const r = result.result as { dataUrl?: string; url?: string } | string
      const dataUrl = typeof r === 'object' && r ? r.dataUrl : undefined
      if (dataUrl && dataUrl.startsWith('data:image/')) {
        const m = /^data:(image\/[\w+-]+);base64,(.+)$/.exec(dataUrl)
        if (m) {
          ctx.pendingAttachments.push({
            name: `screenshot-${Date.now()}.png`,
            mimeType: m[1],
            data: m[2],
            size: Math.floor(m[2].length * 0.75)
          })
          // Tier-2 #5: кадр в буфер прогона для create_proof_video (MP4-доказательство).
          try { addProofFrame(Number(ctx.sendId), Buffer.from(m[2], 'base64')) } catch { /* best-effort */ }
          result.result = { url: typeof r === 'object' ? r.url : null, attached: true }
        }
      }
    }
    // Поле `mode` в КАЖДОМ ответе (решение постановки P3: вводится на куске 3, когда
    // у поля появилось содержимое). Без него смена среды была бы неразличима для
    // модели, а рамка волны запрещает молчаливую смену.
    //
    // МЕСТО ВЫБРАНО НЕ ПРОИЗВОЛЬНО — ПОСЛЕ обработки скриншота. Стояло выше, и на
    // browser_screenshot ветка вложения ЗАМЕНЯЛА весь result.result целиком, унося
    // `mode` вместе с ним. Пин при этом был зелёным: подставной api отдавал пустой
    // dataUrl, замена не срабатывала, и утверждение проверялось на входе, которого в
    // проде не бывает (§3.1 — фикстура не совпала с продовой формой). Ловится
    // контрольным кейсом с НАСТОЯЩИМ base64, а не перечитыванием.
    if (result.result && typeof result.result === 'object') {
      const r = result.result as Record<string, unknown>
      r.mode = env
      if (openNote) r.session = openNote
      if (call.name === 'browser_navigate') {
        const hint = localhostEnvHint(env, String(call.args.url ?? ''))
        if (hint) r.hint = hint
      }
    }
    // Результат передаём ЯВНО: у клика адрес страницы живёт только в нём.
    const s = summarizeToolCall(call.name, call.args, result.result)
    if (s) emitActivity(ctx, call, result.error ? 'error' : 'ok', s.label, s.detail)
    return result
  }
}
