import type { ToolCall, ToolResult } from './types'
import { runHooks, type CompiledHooks } from './hooks'
import { lookupHandler, type ToolContext, type ToolHandler } from '../ipc/tool-handlers'

interface DispatchToolTurnOptions {
  toolCalls: ToolCall[]
  context: ToolContext
  hooks: CompiledHooks | null
  addContext: (context: string) => void
  resolveHandler?: (name: string, context: ToolContext) => ToolHandler
  invokeHooks?: typeof runHooks
}

type HookRunner = typeof runHooks

async function collectPreBlocks(
  toolCalls: ToolCall[],
  context: ToolContext,
  hooks: CompiledHooks,
  invokeHooks: HookRunner,
  addContext: (context: string) => void,
): Promise<Map<number, string>> {
  const blocked = new Map<number, string>()
  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i]
    try {
      const pre = await invokeHooks('PreToolUse', hooks, {
        event: 'PreToolUse',
        cwd: context.projectPath,
        tool_name: call.name,
        tool_input: call.args,
      })
      if (pre.additionalContext) addContext(pre.additionalContext)
      if (pre.block) blocked.set(i, pre.reason ?? `Вызов "${call.name}" заблокирован PreToolUse-хуком.`)
    } catch {
      // Хуки best-effort: их сбой не должен ломать agent loop.
    }
  }
  return blocked
}

function blockedResult(context: ToolContext, call: ToolCall, reason: string): ToolResult {
  context.sender.send('ai:event', {
    id: context.sendId,
    event: {
      type: 'tool-blocked',
      callId: call.id,
      name: call.name,
      command: '',
      reason,
    },
  })
  return { id: call.id, name: call.name, result: '', error: reason }
}

async function executeHandlers(
  toolCalls: ToolCall[],
  context: ToolContext,
  preBlocked: Map<number, string>,
  resolveHandler: (name: string, context: ToolContext) => ToolHandler,
): Promise<ToolResult[]> {
  const results: ToolResult[] = new Array(toolCalls.length)
  const reads: Array<{ index: number; promise: Promise<ToolResult> }> = []
  const writes: Array<{ index: number; promise: Promise<ToolResult> }> = []
  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i]
    const reason = preBlocked.get(i)
    if (reason) {
      results[i] = blockedResult(context, call, reason)
      continue
    }
    const handler = resolveHandler(call.name, context)
    if (handler.mode === 'parallel-read') {
      reads.push({ index: i, promise: handler.handle(call, context) })
    } else if (handler.mode === 'confirm-write') {
      writes.push({ index: i, promise: handler.handle(call, context) })
    } else {
      results[i] = await handler.handle(call, context)
    }
  }
  for (const { index, promise } of reads) results[index] = await promise
  for (const { index, promise } of writes) results[index] = await promise
  return results
}

async function runPostHooks(
  toolCalls: ToolCall[],
  results: ToolResult[],
  context: ToolContext,
  hooks: CompiledHooks,
  preBlocked: Map<number, string>,
  invokeHooks: HookRunner,
  addContext: (context: string) => void,
): Promise<void> {
  for (let i = 0; i < toolCalls.length; i++) {
    if (preBlocked.has(i)) continue
    const call = toolCalls[i]
    try {
      const post = await invokeHooks('PostToolUse', hooks, {
        event: 'PostToolUse',
        cwd: context.projectPath,
        tool_name: call.name,
        tool_input: call.args,
        tool_output: results[i]?.result,
      })
      if (post.additionalContext) addContext(post.additionalContext)
    } catch {
      // Post-hook best-effort и не меняет уже полученный ToolResult.
    }
  }
}

/**
 * Отказ гейта tools_allow — ОБЪЯСНЯЮЩИЙ, а не немой «инструмент недоступен». У дочерней
 * сессии называет причину прямо: набор унаследован от родителя. Без объяснения человек
 * упрётся в глухой отказ и не поймёт почему — ровно тот класс немых отказов, что мы чиним.
 */
export function toolsAllowBlockReason(toolName: string, isChildSession: boolean | undefined): string {
  return isChildSession
    ? `Инструмент "${toolName}" недоступен: набор инструментов УНАСЛЕДОВАН от родительской сессии ` +
      `(её скилл ограничил доступ). Вынесенная задача не может быть шире родителя — родитель тоже ` +
      `не мог им пользоваться. Если инструмент действительно нужен, сними ограничение осознанно.`
    : `Инструмент "${toolName}" недоступен: активный скилл ограничил набор инструментов (tools_allow), ` +
      `и этот инструмент вне разрешённого набора.`
}

/**
 * Один turn исполнения инструментов: PreToolUse → гейт tools_allow → dispatch по режиму →
 * PostToolUse. Порядок и параллельность — часть контракта runner'а, поэтому они живут в
 * одной тестируемой функции, а не размазаны по главному agent loop.
 */
export async function dispatchToolTurn(opts: DispatchToolTurnOptions): Promise<ToolResult[]> {
  const {
    toolCalls,
    context,
    hooks,
    addContext,
    resolveHandler = lookupHandler,
    invokeHooks = runHooks,
  } = opts
  const blocked = hooks
    ? await collectPreBlocks(toolCalls, context, hooks, invokeHooks, addContext)
    : new Map<number, string>()
  // Гейт tools_allow на ИСПОЛНЕНИИ (штаб, аудит 09.08): список предлагаемых инструментов —
  // это МЕНЮ для модели, а не граница. Вызов инструмента вне разрешённого набора — будь то
  // галлюцинация, инъекция в читаемый контент, или дочерняя сессия под унаследованным
  // ограничением — блокируется ЗДЕСЬ, с объясняющим отказом. allowedToolNames=null (нет
  // скилла / fail-open) → ограничения нет → no-op для подавляющего большинства сессий.
  const allowed = context.allowedToolNames
  if (allowed) {
    for (let i = 0; i < toolCalls.length; i++) {
      if (blocked.has(i)) continue
      if (!allowed.has(toolCalls[i].name)) {
        blocked.set(i, toolsAllowBlockReason(toolCalls[i].name, context.isChildSession))
      }
    }
  }
  const results = await executeHandlers(toolCalls, context, blocked, resolveHandler)
  if (hooks) {
    await runPostHooks(toolCalls, results, context, hooks, blocked, invokeHooks, addContext)
  }
  return results
}
