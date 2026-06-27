// Browser-хендлер: navigate / read_page / screenshot. Вынесено при распиле.
import type { ToolHandler, ToolContext } from './shared'
import type { ToolCall, ToolResult } from '../../ai/types'
import { emitActivity, summarizeToolCall } from './shared'
import { addProofFrame } from '../../ai/proof-frames'

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
    const result = await dispatchBrowser(call, ctx)
    // Journal what AI looked at on the web
    try {
      if (!result.error) {
        const url = String(call.args.url ?? '')
        const label = call.name === 'browser_navigate' ? `Браузер → ${url}`
                    : call.name === 'browser_read_page' ? `Браузер: прочитан текст`
                    : `Браузер: скриншот`
        ctx.recordJournal(ctx.projectPath, 'tool', label, null)
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
    const s = summarizeToolCall(call.name, call.args, undefined)
    if (s) emitActivity(ctx, call, result.error ? 'error' : 'ok', s.label, s.detail)
    return result
  }
}
