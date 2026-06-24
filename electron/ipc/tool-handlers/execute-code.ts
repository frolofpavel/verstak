// PTC (T1.4): execute_code — агент пишет JS-скрипт, оркестрирующий READ-ONLY тулзы
// (циклы/фильтры/агрегация), а в контекст попадает только итог (log/return), не
// каждый промежуточный результат. Меньше токенов на read-тяжёлых задачах. Движок
// (vm-песочница без process/require/fs, таймаут) — в electron/ai/ptc.ts.
import type { ToolHandler } from './shared'
import { emitActivity, awaitCommandConfirm } from './shared'
import { decide, blockReason } from '../../ai/mode-policy'
import { runPtcCode, PTC_READONLY_TOOLS } from '../../ai/ptc'

export const executeCodeHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    const code = typeof call.args.code === 'string' ? call.args.code : ''
    if (!code.trim()) {
      return { id: call.id, name: call.name, result: '', error: 'execute_code: пустой параметр code' }
    }
    // Гейтинг как КОМАНДА (vm не граница безопасности → trust = run_command): plan
    // блокирует, ask показывает код и ждёт подтверждения, auto/bypass — авто. Без
    // эскалации привилегий относительно уже имеющегося run_command.
    const decision = decide('execute_code', ctx.agentMode)
    if (decision === 'block') {
      const reason = blockReason('execute_code', ctx.agentMode)
      ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'tool-blocked', callId: call.id, name: 'execute_code', command: code, reason } })
      return { id: call.id, name: call.name, result: '', error: reason }
    }
    if (decision !== 'auto-accept') {
      ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'pending-command', callId: call.id, command: `execute_code:\n${code}` } })
      const accepted = await awaitCommandConfirm(ctx, call.id)
      if (!accepted) {
        ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'command-result', callId: call.id, command: 'execute_code', status: 'rejected' } })
        return { id: call.id, name: call.name, result: '', error: 'Пользователь отклонил execute_code' }
      }
    }
    // Внутри песочницы доступны только read-only тулзы — через generic executor
    // FileTools.execute (никаких write_file/run_command/connector_query).
    const tools: Record<string, (args: Record<string, unknown>) => Promise<string>> = {}
    for (const name of PTC_READONLY_TOOLS) {
      tools[name] = async (args) => {
        const r = await ctx.tools.execute(name, args ?? {})
        return typeof r === 'string' ? r : JSON.stringify(r)
      }
    }
    try {
      const res = await runPtcCode({ code, tools })
      const summary = `${res.toolCalls} tool-call(s)${res.error ? ` · ошибка: ${res.error}` : ''}`
      emitActivity(ctx, call, res.error ? 'error' : 'ok', 'execute_code', summary)
      const body = res.error
        ? `${res.output}\n\n[execute_code: ошибка исполнения: ${res.error}]`.trim()
        : res.output || '[execute_code: скрипт ничего не вывел — используй log(...) чтобы вернуть результат]'
      return { id: call.id, name: call.name, result: body }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}
