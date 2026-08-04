// Browser-хендлер: navigate / read_page / screenshot. Вынесено при распиле.
import type { ToolHandler, ToolContext } from './shared'
import type { ToolCall, ToolResult } from '../../ai/types'
import { emitActivity, summarizeToolCall, awaitCommandConfirm } from './shared'
import { addProofFrame } from '../../ai/proof-frames'
import { resolveDecision } from '../../ai/permission-rules'
import { blockReason } from '../../ai/mode-policy'
import { execAwaitingBrowserApi, isBrowserNotReady } from './browser-ready'
import { capConsoleErrors, capNetwork } from './browser-redact'
import { readCapture } from '../../browser/network-capture'

async function dispatchBrowser(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
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

export const browserHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
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
    const { decision, reason: denyReason } = resolveDecision(call.name, call.args, ctx.agentMode, ctx.autoApprove, ctx.permissionRules)
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
      ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'pending-command', callId: call.id, command: summary, sendId: ctx.sendId } })
      const accepted = await awaitCommandConfirm(ctx, call.id)
      if (!accepted) {
        ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'command-result', callId: call.id, command: summary, status: 'rejected' } })
        return { id: call.id, name: call.name, result: '', error: 'User rejected' }
      }
    }
    const result = await dispatchBrowser(call, ctx)
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
                    : call.name === 'browser_wait_for' ? `Браузер: ожидание «${String(call.args.query ?? '')}»`
                    : call.name === 'browser_console_errors' ? `Браузер: чтение консоли`
                    : call.name === 'browser_network' ? `Браузер: чтение сети`
                    : call.name === 'browser_click' ? `Браузер: клик по «${String(call.args.selector ?? '')}»`
                    : `Браузер: скриншот`
        // Для клика (обоих видов) в журнал едет и адрес страницы — см. summarizeToolCall.
        const clicked = (call.name === 'browser_click' || call.name === 'browser_click_by_number') && result.result && typeof result.result === 'object'
          ? String((result.result as { url?: unknown }).url ?? '')
          : ''
        ctx.recordJournal(ctx.projectPath, 'tool', label, clicked || null)
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
    // Результат передаём ЯВНО: у клика адрес страницы живёт только в нём.
    const s = summarizeToolCall(call.name, call.args, result.result)
    if (s) emitActivity(ctx, call, result.error ? 'error' : 'ok', s.label, s.detail)
    return result
  }
}
