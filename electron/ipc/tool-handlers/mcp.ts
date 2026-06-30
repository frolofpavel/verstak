// MCP-хендлер: роутинг вызовов внешних MCP-инструментов. Вынесено при распиле.
import type { ToolHandler } from './shared'
import { emitActivity, awaitCommandConfirm } from './shared'
import { classifyMcpToolScope, mcpDecision, mcpBlockReason, parseMcpScopeOverrides } from '../../ai/mcp-policy'
import { applyPermissionRules } from '../../ai/permission-rules'
import { scanText } from '../../ai/secret-scanner'

export const mcpToolHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    if (!ctx.mcpClient) {
      return { id: call.id, name: call.name, result: '', error: 'MCP client not available' }
    }
    // Определяем serverId: ищем tool среди всех подключённых серверов по имени
    const allMcpTools = ctx.mcpClient.getAllTools()
    const matchedTool = allMcpTools.find(t => t.name === call.name)
    if (!matchedTool) {
      return { id: call.id, name: call.name, result: '', error: `MCP tool "${call.name}" not found in connected servers` }
    }
    // Mode policy: внешние MCP-тулзы — не локальные правки, а side-effects на чужих
    // серверах. Гейтим их так же, как connector_query: scope тулза классифицируем
    // по name + description (read → авто, write/command/network/unknown → команда),
    // затем mcpDecision(scope, mode) даёт block/confirm/auto-accept.
    // #2 приоритет гейтинга: override (Settings, per-tool) > annotations (MCP-хинты
    // readOnlyHint/destructiveHint) > keyword-угадайка. Убирает зависимость от угадайки.
    const overrides = parseMcpScopeOverrides(ctx.getSecretForDelegate?.('mcp_scope_overrides'))
    const scope = classifyMcpToolScope(matchedTool.name, matchedTool.description, matchedTool.annotations, overrides[matchedTool.name])
    let decision = mcpDecision(scope, ctx.agentMode)
    // Декларативные permission-правила применяются и к MCP-тулзам (ревью: deny на имя
    // MCP-тула игнорировался). deny бьёт даже bypass; правила не ослабляют scope-block.
    // Имя MCP-тула без скобок матчится правилом с argMatcher===null.
    const permRule = applyPermissionRules(call.name, JSON.stringify(call.args ?? {}), ctx.permissionRules)
    if (permRule?.decision === 'deny') {
      decision = 'block'
    } else if (decision !== 'block') {
      if (permRule?.decision === 'ask') decision = 'confirm'
      else if (permRule?.decision === 'allow') decision = 'auto-accept'
    }
    // Короткая сводка аргументов для модалки подтверждения (без раскрытия больших значений)
    const argKeys = Object.keys(call.args ?? {})
    const argsSummary = argKeys.length ? argKeys.join(', ') : ''
    const summary = `MCP ${call.name}${argsSummary ? ` · ${argsSummary}` : ''}`
    if (decision === 'block') {
      const reason = mcpBlockReason(call.name, scope, ctx.agentMode)
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-blocked', callId: call.id, name: call.name, command: summary, reason }
      })
      return { id: call.id, name: call.name, result: '', error: reason }
    }
    if (decision === 'confirm') {
      // 'confirm' — переиспользуем pending-command поток (та же модалка подтверждения)
      ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'pending-command', callId: call.id, command: summary } })
      const accepted = await awaitCommandConfirm(ctx, call.id)
      if (!accepted) {
        ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'command-result', callId: call.id, command: summary, status: 'rejected' } })
        return { id: call.id, name: call.name, result: summary, error: 'User rejected' }
      }
    }
    try {
      emitActivity(ctx, call, 'ok', `mcp:${call.name}`, matchedTool.serverId)
      const result = await ctx.mcpClient.callTool(matchedTool.serverId, call.name, call.args)
      // Редактируем вывод внешнего MCP-сервера — он не доверенный, может вернуть
      // токены/ключи, которые иначе утекут в контекст модели.
      const raw = typeof result === 'string' ? result : JSON.stringify(result)
      return { id: call.id, name: call.name, result: scanText(raw).redacted }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', `mcp:${call.name}`, scanText(msg).redacted)
      return { id: call.id, name: call.name, result: '', error: scanText(msg).redacted }
    }
  }
}
