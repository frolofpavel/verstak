/**
 * Sub-agent agent-loop (Фаза 1 спринта мультиагентности).
 *
 * Раньше субагент был one-shot: provider.send → собрать текст → вернуть.
 * Теперь это облегчённая версия главного agent-loop (см. ipc/ai.ts
 * runApiConversation): provider.send → если модель зовёт tools, выполняем
 * РАЗРЕШЁННЫЕ по роли → возвращаем tool_result → повторяем, пока модель не
 * закончит или не упрёмся в лимит итераций.
 *
 * Принципиально проще главного цикла: нет авто-компакшна, нет sliding-window,
 * нет journal-снапшотов, нет verify-hints, нет MCP. Это узкий рабочий цикл
 * субагента. Выполнение конкретного tool переиспользуется из главного реестра
 * (tool-handlers.lookupHandler) — мы НЕ дублируем логику read_file/apply_patch/
 * run_command, только фильтруем набор и гейтим команды по роли.
 */

import type { ChatMessage, ChatProvider, ToolCall, ToolResult, ToolDefinition } from './types'
import { TOOL_DEFS } from './tools'
import { isVerifierCommand } from './command-policy'
import { lookupHandler, type ToolContext } from '../ipc/tool-handlers'

// Лимиты субагентного цикла — вынесены константами с комментариями.
// MAX_SUB_ITERATIONS — сколько раундов «модель зовёт tools → выполняем» допускаем.
// 8 хватает для узкой подзадачи (прочитать пару файлов, применить патч, проверить),
// но не даёт субагенту уйти в спираль и жечь токены/деньги.
export const MAX_SUB_ITERATIONS = 8

export interface SubAgentLoopParams {
  provider: ChatProvider
  /** Системный + первый user — стартовые сообщения субагента. */
  messages: ChatMessage[]
  /** Имена tools, разрешённых этой роли (getRoleToolset). */
  allowedToolNames: string[]
  /** Родительский ToolContext — переиспользуем sender/projectPath/tools/
   *  pendingWrites/pendingCommands/agentMode/cost-guard и т.д. */
  ctx: ToolContext
  /** AbortSignal субзадачи (per-task timeout + проброс родительского abort). */
  signal: AbortSignal
  /** Роль субагента — нужна для гейта run_command у verifier. */
  role?: string | null
  /** Вызывается при каждом выполненном tool-вызове — для индикации
   *  tool-активности в карточке subagent-run (UI). */
  onToolActivity?: (toolName: string) => void
}

export interface SubAgentLoopResult {
  /** Финальный текстовый ответ субагента. */
  text: string
  /** Сколько tool-вызовов выполнил субагент (для журнала/индикации). */
  toolCallCount: number
  /** Почему цикл завершился. */
  exitReason: 'completed' | 'max-iterations' | 'aborted' | 'error'
  /** Сообщение об ошибке если exitReason==='error'. */
  error?: string
}

/**
 * Запустить subagent agent-loop. Возвращает финальный текст + метаданные.
 * Не эмитит subagent-run карточки сам — это делает вызывающий handler (он
 * знает label/provider/skill). Зато зовёт onToolActivity для счётчика tools.
 */
export async function runSubAgentLoop(params: SubAgentLoopParams): Promise<SubAgentLoopResult> {
  const { provider, messages, allowedToolNames, ctx, signal, role, onToolActivity } = params

  // Фильтруем TOOL_DEFS по whitelist роли. Субагент физически НЕ видит
  // запрещённые tools — модель не сможет их вызвать.
  const allowed = new Set(allowedToolNames)
  const subToolDefs: ToolDefinition[] = TOOL_DEFS.filter(t => allowed.has(t.name))

  // Под-контекст: тот же ctx, но с signal субзадачи. Все безопасностные гейты
  // (path-policy, secret-scanner, mode-policy.decide, command denylist)
  // выполняются ВНУТРИ переиспользуемых handler'ов — субагент проходит ровно
  // те же проверки, что и главный агент. Мы их не ослабляем.
  const subCtx: ToolContext = { ...ctx, signal }

  const convo: ChatMessage[] = [...messages]
  let lastText = ''
  let toolCallCount = 0

  for (let iter = 0; iter < MAX_SUB_ITERATIONS; iter++) {
    if (signal.aborted) return { text: lastText, toolCallCount, exitReason: 'aborted' }

    const toolCalls: ToolCall[] = []
    let assistantText = ''
    try {
      for await (const event of provider.send(convo, subToolDefs, undefined, signal)) {
        if (signal.aborted) return { text: lastText, toolCallCount, exitReason: 'aborted' }
        if (event.type === 'text' && typeof event.text === 'string') {
          assistantText += event.text
        } else if (event.type === 'tool-call') {
          toolCalls.push(event.call)
        } else if (event.type === 'usage' && event.usage) {
          // Cost guard: токены субагента учитываются в общий cap сессии.
          // Берём guard из ctx (родитель прокинул свой costGuard через
          // ctx.subCostGuard). Если cap превышен — обрываем субцикл с ошибкой,
          // чтобы суб не обошёл лимит сессии.
          const guard = ctx.subCostGuard
          if (guard && ctx.subProviderId) {
            const check = guard.recordAndCheck(
              ctx.subProviderId, ctx.subModel ?? '',
              event.usage.inputTokens ?? null, event.usage.outputTokens ?? null,
              event.usage.cacheReadTokens ?? event.usage.cachedInputTokens ?? null,
              event.usage.inputAccounting, // 2.0.8-E: фикс дефекта B для субагента
              event.usage.cacheWriteTokens ?? event.usage.cacheCreationInputTokens ?? null,
            )
            if (check.exceeded) {
              return { text: lastText, toolCallCount, exitReason: 'error', error: check.message ?? 'cost cap exceeded' }
            }
          }
        } else if (event.type === 'error') {
          return { text: assistantText || lastText, toolCallCount, exitReason: 'error', error: event.message }
        } else if (event.type === 'done') {
          break
        }
      }
    } catch (err) {
      return { text: lastText, toolCallCount, exitReason: 'error', error: err instanceof Error ? err.message : String(err) }
    }

    if (assistantText) lastText = assistantText

    // Модель ничего не зовёт — субагент закончил.
    if (toolCalls.length === 0) {
      return { text: lastText, toolCallCount, exitReason: 'completed' }
    }

    convo.push({ role: 'assistant', content: assistantText, toolCalls })

    const toolResults: ToolResult[] = []
    for (const call of toolCalls) {
      if (signal.aborted) return { text: lastText, toolCallCount, exitReason: 'aborted' }
      // Двойная защита: даже если модель как-то вызвала не-whitelisted tool —
      // отказываем (не выполняем).
      if (!allowed.has(call.name)) {
        toolResults.push({ id: call.id, name: call.name, result: '', error: `Субагенту (роль ${role ?? 'default'}) запрещён инструмент "${call.name}".` })
        continue
      }
      // verifier: run_command ограничен whitelist'ом проверочных команд.
      if (call.name === 'run_command' && role === 'verifier') {
        const cmd = String(call.args.command ?? '')
        if (!isVerifierCommand(cmd)) {
          toolResults.push({ id: call.id, name: call.name, result: '', error: `verifier может запускать только проверочные команды (test/typecheck/lint). Команда "${cmd}" отклонена.` })
          continue
        }
      }
      try {
        const handler = lookupHandler(call.name, subCtx)
        const result = await handler.handle(call, subCtx)
        toolResults.push(result)
        toolCallCount++
        onToolActivity?.(call.name)
      } catch (err) {
        toolResults.push({ id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) })
      }
    }

    convo.push({ role: 'user', content: '', toolResults })
  }

  // Исчерпали итерации — отдаём что есть.
  return { text: lastText, toolCallCount, exitReason: 'max-iterations' }
}
