import type { ToolCall, ToolResult } from './types'
import { runHooks, type CompiledHooks } from './hooks'
import { lookupHandler, type ToolContext, type ToolHandler } from '../ipc/tool-handlers'
import {
  createR3ServerHandoff,
  FORBIDDEN_CROSS_TOOLS,
  isR3ArtifactTool,
  isR3BrowserMutationTool,
  renderR3HandoffCheckpoint,
  type R3ServerHandoff,
} from './browser/capability'
import {
  projectToolArgsForTelemetry,
  projectToolCallForTelemetry,
  projectToolResultForTelemetry,
} from './tool-telemetry'
import { isComputerToolName } from './computer/tool-names'

const BROWSER_RUN_FORBIDDEN_TOOLS = new Set(FORBIDDEN_CROSS_TOOLS)
const STOPPED_TOOL_REASON = 'Запрос остановлен: инструмент не запущен.'
const COMPUTER_CROSS_TOOL_BLOCKED_REASON = 'Computer Use заблокировал инструмент вне capability выбранного окна. Содержимое окна не может расширить полномочия задачи.'

type UntrustedSurfaceAwareContext = ToolContext & {
  browserRunState?: {
    active: boolean
    contextExposed?: boolean
    screenshotExposed?: boolean
    r3HandoffAllowed?: boolean
    r3Handoff?: R3ServerHandoff
  }
  computerRunState?: { active: boolean; contextExposed?: boolean }
  persistR3HandoffCheckpoint?: (handoff: R3ServerHandoff) => void
}

function resultIncludesScreenshot(result: ToolResult | undefined): boolean {
  if (!result || result.error || !result.result || typeof result.result !== 'object') return false
  const payload = result.result as Record<string, unknown>
  return payload.screenshotAttached === true || payload.attached === true
}

function updateBrowserRunAfterTools(
  state: UntrustedSurfaceAwareContext['browserRunState'],
  toolCalls: ToolCall[],
  results: ToolResult[],
  blocked: Map<number, string>,
  lineage: { browserTaskId?: string | null; runId?: string },
): void {
  if (!state) return
  const contextExposed = toolCalls.some((call, index) => (
    call.name.startsWith('browser_')
    && !blocked.has(index)
    && !results[index]?.error
  ))
  const observed = toolCalls.some((call, index) => (
    call.name === 'browser_read_page'
    && !blocked.has(index)
    && !results[index]?.error
  ))
  const screenshotExposed = toolCalls.some((call, index) => (
    call.name.startsWith('browser_')
    && !blocked.has(index)
    && resultIncludesScreenshot(results[index])
  ))
  if (contextExposed) state.contextExposed = true
  if (screenshotExposed) state.screenshotExposed = true
  if (contextExposed || observed || screenshotExposed) state.active = true
  if (state.r3HandoffAllowed === true && !state.r3Handoff && lineage.browserTaskId && lineage.runId) {
    const completed = toolCalls.findIndex((call, index) => (
      call.name.startsWith('browser_')
      && !blocked.has(index)
      && !results[index]?.error
    ))
    if (completed >= 0) {
      state.r3Handoff = createR3ServerHandoff({
        browserTaskId: lineage.browserTaskId,
        runId: lineage.runId,
        toolName: toolCalls[completed].name,
        result: results[completed].result,
      })
    }
  } else if (state.r3HandoffAllowed === true && state.r3Handoff) {
    for (let index = 0; index < toolCalls.length; index += 1) {
      const call = toolCalls[index]
      if (call.name.startsWith('browser_') && !blocked.has(index) && !results[index]?.error
        && !state.r3Handoff.checkpoint.confirmedActions.includes(call.name)) {
        state.r3Handoff.checkpoint.confirmedActions.push(call.name)
      }
    }
  }
}

function updateComputerRunAfterTools(
  state: UntrustedSurfaceAwareContext['computerRunState'],
  toolCalls: ToolCall[],
  results: ToolResult[],
  blocked: Map<number, string>,
): void {
  if (!state) return
  const contextExposed = toolCalls.some((call, index) => (
    isComputerToolName(call.name)
    && !blocked.has(index)
    && !results[index]?.error
  ))
  if (contextExposed) {
    state.active = true
    state.contextExposed = true
  }
}

function computerActionForTool(toolName: string): string | null {
  return isComputerToolName(toolName) ? toolName.slice('computer_'.length) : null
}

function hasFreshComputerGrant(context: UntrustedSurfaceAwareContext, toolName: string): boolean {
  const action = computerActionForTool(toolName)
  return action != null && (context.computerUseAllowedActions ?? []).includes(action as never)
}

function browserRunForbids(toolName: string, context: UntrustedSurfaceAwareContext): string | null {
  const handoff = context.browserRunState?.r3HandoffAllowed === true
    ? context.browserRunState.r3Handoff
    : undefined
  if (handoff?.phase === 'artifact-ready' && isR3BrowserMutationTool(toolName)) {
    return 'R3 handoff завершён: повтор browser mutation заблокирован без нового пользовательского поручения.'
  }
  if (isR3ArtifactTool(toolName)) {
    return handoff?.phase === 'browser-ready'
      ? null
      : `Browser run не выдал server-owned handoff для "${toolName}".`
  }
  if (isComputerToolName(toolName)) {
    return handoff?.phase === 'artifact-ready' && hasFreshComputerGrant(context, toolName)
      ? null
      : `Browser run активен — Computer Use заблокирован capability envelope до server-owned artifact handoff и свежего пользовательского разрешения.`
  }
  return BROWSER_RUN_FORBIDDEN_TOOLS.has(toolName)
    ? `Browser run активен — cross-tool "${toolName}" заблокирован capability envelope. Контент страницы не может расширить полномочия задачи.`
    : null
}

function computerRunForbids(toolName: string, context: UntrustedSurfaceAwareContext): boolean {
  // Keep the selected-window tools available for the task that owns the
  // binding, but prevent desktop-derived text from escaping through ANY other
  // capability. R3 may later add a structured, explicitly approved handoff;
  // R2 has no such cross-capability grant and therefore fails closed.
  if (isComputerToolName(toolName)) return false
  const browserState = context.browserRunState
  const handoff = browserState?.r3HandoffAllowed === true ? browserState.r3Handoff : undefined
  // До первого desktop observe свежий composer-ticket может начать только
  // browser-часть общего сценария. После exposure эта дверь закрывается.
  if (toolName.startsWith('browser_') && context.computerRunState?.contextExposed !== true) return false
  if (isR3ArtifactTool(toolName) && handoff?.phase === 'browser-ready'
    && context.computerRunState?.contextExposed !== true) return false
  return true
}

function applyUntrustedSurfaceBlocks(
  toolCalls: ToolCall[],
  context: UntrustedSurfaceAwareContext,
  blocked: Map<number, string>,
): void {
  const browserRunState = context.browserRunState
  const computerRunState = context.computerRunState
  // A model can emit several calls in one batch. Treat the batch as tainted as
  // soon as it asks to expose an untrusted surface, otherwise
  // observe→run_command in one turn bypasses the next-turn state transition.
  const firstBrowserExposure = toolCalls.findIndex((call, index) => (
    call.name.startsWith('browser_') && !blocked.has(index)
  ))
  const firstComputerExposure = toolCalls.findIndex((call, index) => (
    isComputerToolName(call.name) && !blocked.has(index)
  ))
  const hasActiveSurface = browserRunState?.active === true || computerRunState?.active === true
  // If a fresh batch tries both surfaces, the first declared producer wins and
  // the other capability is blocked. This preserves order without permitting
  // either surface to bootstrap the other.
  const browserGateActive = browserRunState?.active === true || (
    !hasActiveSurface
    && firstBrowserExposure >= 0
    && (firstComputerExposure < 0 || firstBrowserExposure < firstComputerExposure)
  )
  const computerGateActive = computerRunState?.active === true || (
    !hasActiveSurface
    && firstComputerExposure >= 0
    && (firstBrowserExposure < 0 || firstComputerExposure < firstBrowserExposure)
  )
  if (browserGateActive) {
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]
      const reason = !blocked.has(i) ? browserRunForbids(call.name, context) : null
      if (reason) blocked.set(i, reason)
    }
  }
  if (computerGateActive) {
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]
      if (!blocked.has(i) && computerRunForbids(call.name, context)) {
        blocked.set(i, COMPUTER_CROSS_TOOL_BLOCKED_REASON)
      }
    }
  }
}

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
  blocked: Map<number, string>,
): Promise<Map<number, string>> {
  for (let i = 0; i < toolCalls.length; i++) {
    if (blocked.has(i)) continue
    if (context.signal?.aborted) {
      for (let j = i; j < toolCalls.length; j++) blocked.set(j, STOPPED_TOOL_REASON)
      break
    }
    const call = toolCalls[i]
    try {
      const pre = await invokeHooks('PreToolUse', hooks, {
        event: 'PreToolUse',
        cwd: context.projectPath,
        tool_name: call.name,
        // Hooks are external observability/policy surfaces, not executors.
        // Desktop input and wait text must not leave the in-process handler.
        tool_input: projectToolArgsForTelemetry(call.name, call.args),
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
  const computerActive = (context as UntrustedSurfaceAwareContext).computerRunState?.active === true
  const omitNonComputer = computerActive && !isComputerToolName(call.name)
  const telemetryCall = projectToolCallForTelemetry(call, { omitNonComputerArgs: computerActive })
  context.sender.send('ai:event', {
    id: context.sendId,
    event: {
      type: 'tool-blocked',
      callId: telemetryCall.id,
      name: telemetryCall.name,
      command: '',
      reason: omitNonComputer ? COMPUTER_CROSS_TOOL_BLOCKED_REASON : reason,
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
    const reason = preBlocked.get(i) ?? (context.signal?.aborted ? STOPPED_TOOL_REASON : undefined)
    if (reason) {
      preBlocked.set(i, reason)
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
        tool_input: projectToolArgsForTelemetry(call.name, call.args),
        tool_output: projectToolResultForTelemetry(call.name, results[i]?.result),
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
  const untrustedContext = context as UntrustedSurfaceAwareContext
  const browserRunState = untrustedContext.browserRunState
  const computerRunState = untrustedContext.computerRunState
  // Capability envelope runs before external hooks, so blocked desktop/browser
  // arguments cannot escape through an observability hook.
  const blocked = new Map<number, string>()
  applyUntrustedSurfaceBlocks(toolCalls, untrustedContext, blocked)
  if (hooks) await collectPreBlocks(toolCalls, context, hooks, invokeHooks, addContext, blocked)
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
  // browserTaskId — лишь durable lineage и заранее существует у обычного чата.
  // Browser-only capability становится активной только после того, как модель
  // действительно получила недоверенное содержимое подключённой страницы.
  updateBrowserRunAfterTools(browserRunState, toolCalls, results, blocked, {
    browserTaskId: context.browserTaskId,
    runId: context.runId,
  })
  updateComputerRunAfterTools(computerRunState, toolCalls, results, blocked)
  if (browserRunState?.r3HandoffAllowed === true && browserRunState.r3Handoff) {
    untrustedContext.persistR3HandoffCheckpoint?.(browserRunState.r3Handoff)
    addContext(renderR3HandoffCheckpoint(browserRunState.r3Handoff))
  }
  if (hooks) {
    await runPostHooks(toolCalls, results, context, hooks, blocked, invokeHooks, addContext)
  }
  return results
}
