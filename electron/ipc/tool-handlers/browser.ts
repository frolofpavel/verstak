// Browser-хендлер: navigate / read_page / screenshot. Вынесено при распиле.
import type { ToolHandler, ToolContext } from './shared'
import type { ToolCall, ToolResult } from '../../ai/types'
import { emitActivity, summarizeToolCall, awaitCommandConfirm } from './shared'
import { addProofFrame } from '../../ai/proof-frames'
import { resolveDecision } from '../../ai/permission-rules'
import { blockReason } from '../../ai/mode-policy'

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
    } else if (call.name === 'browser_click_by_number') {
      // Клик по номеру ИЗ ПОСЛЕДНЕГО снимка. Устаревший номер (после навигации) →
      // честная ошибка из api.clickByNumber, а не угадывание.
      action = `return await api.clickByNumber(Number(a.n));`
    } else if (call.name === 'browser_click') {
      action = `return await api.click(String(a.selector ?? ''));`
    } else {
      action = `const dataUrl = await api.screenshot();
                return { url: api.getURL(), dataUrl };`
    }
    const snippet = `(async () => {
      const api = window.verstakBrowser;
      if (!api) return { __err: 'Вкладка Browser не открыта — попроси пользователя открыть её' };
      const a = JSON.parse(${argsLiteral});
      ${action}
    })()`
    const result = await ctx.sender.exec(snippet)
    if (result && typeof result === 'object' && '__err' in result) {
      return { id: call.id, name: call.name, result: '', error: String((result as { __err: unknown }).__err) }
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
                    : call.name === 'browser_click_by_number' ? `Браузер: клик по элементу №${String(call.args.n ?? '')}`
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
