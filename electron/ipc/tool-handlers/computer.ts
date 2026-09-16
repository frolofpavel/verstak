import { createHmac, randomBytes } from 'node:crypto'
import type { ToolCall, ToolResult } from '../../ai/types'
import type { ComputerAction, ComputerDispatchInput, ComputerKey } from '../../ai/computer/types'
import type { ComputerController, ComputerRunAuthorizationResult } from '../../ai/computer/controller'
import { wrapComputerObservationForModel } from '../../ai/computer/untrusted'
import { COMPUTER_TOOL_ACTION, isComputerToolName } from '../../ai/computer/tool-names'
import { isComputerElementRef, isComputerObservationRef } from '../../ai/computer/refs'
import { scanText } from '../../ai/secret-scanner'
import { blockReason } from '../../ai/mode-policy'
import { resolveDecision } from '../../ai/permission-rules'
import { projectToolCallForTelemetry } from '../../ai/tool-telemetry'
import type { ToolContext, ToolHandler } from './shared'
import { emitActivity, summarizeToolCall } from './shared'

export interface ComputerHandlerDeps {
  controller?: ComputerController | null
}

let depsRef: ComputerHandlerDeps = {}
interface TrackedComputerStop {
  controller: ComputerController
  browserTaskId: string
  runId: string
  promise: Promise<void> | null
}

interface SignalComputerStops {
  byLineage: Map<string, TrackedComputerStop>
  latest: Promise<void> | null
}

const computerStopBySignal = new WeakMap<AbortSignal, SignalComputerStops>()
const noComputerStop = Promise.resolve()
// Provider call ids and thought signatures may contain model-authored desktop
// content. The controller still needs stable per-process idempotency, so derive
// an opaque keyed id instead of persisting the provider envelope.
const computerActionIdKey = randomBytes(32)

export function configureComputerHandler(deps: ComputerHandlerDeps): void {
  depsRef = { ...deps }
}

/** Await the exact helper queue ACK started by a send AbortSignal, if any. */
export function waitForComputerRunStop(signal: AbortSignal): Promise<void> {
  return computerStopBySignal.get(signal)?.latest ?? noComputerStop
}

function trackComputerRunStop(
  signal: AbortSignal,
  controller: ComputerController,
  browserTaskId: string,
  runId: string,
): TrackedComputerStop {
  let state = computerStopBySignal.get(signal)
  if (!state) {
    state = { byLineage: new Map(), latest: null }
    computerStopBySignal.set(signal, state)
  }
  const key = `${browserTaskId.length}:${browserTaskId}:${runId}`
  let tracked = state.byLineage.get(key)
  if (!tracked) {
    tracked = { controller, browserTaskId, runId, promise: null }
    state.byLineage.set(key, tracked)
    const exactState = state
    const exactTracked = tracked
    const start = () => { void startComputerRunStop(exactState, exactTracked) }
    if (signal.aborted) start()
    else signal.addEventListener('abort', start, { once: true })
  }
  return tracked
}

function startComputerRunStop(state: SignalComputerStops, tracked: TrackedComputerStop): Promise<void> {
  if (tracked.promise) return tracked.promise
  // Install the shared promise before invoking cancelRun so every abort path
  // observes the same one-shot operation, including synchronous re-entrancy.
  const stopped = Promise.resolve().then(() => tracked.controller.cancelRun(
    tracked.browserTaskId,
    tracked.runId,
  ))
  tracked.promise = stopped
  state.latest = stopped
  void stopped.catch(() => undefined)
  return stopped
}

/** Main-only pre-model claim. Never call this from a model/tool argument. */
export function authorizeComputerRun(input: {
  browserTaskId: string
  runId: string
  signal?: AbortSignal
}): ComputerRunAuthorizationResult | { ok: false; error: 'computer-use-unavailable' } {
  const controller = depsRef.controller
  if (!controller) return { ok: false, error: 'computer-use-unavailable' }
  const authorization = controller.authorizeRun({
    browserTaskId: input.browserTaskId,
    runId: input.runId,
  })
  if (authorization.ok && input.signal) {
    trackComputerRunStop(input.signal, controller, input.browserTaskId, input.runId)
  }
  return authorization
}

function discreteScrollStep(value: unknown): value is -1 | 0 | 1 {
  return value === -1 || value === 0 || value === 1
}

const MAX_WAIT_TIMEOUT_MS = 5_000

const COMPUTER_ACTION_ARG_KEYS: Record<ComputerAction, ReadonlySet<string>> = {
  observe: new Set(),
  click: new Set(['observationId', 'elementRef']),
  type: new Set(['observationId', 'elementRef', 'text']),
  key: new Set(['observationId', 'elementRef', 'key']),
  scroll: new Set(['observationId', 'elementRef', 'deltaX', 'deltaY']),
  wait_for: new Set(['elementRef', 'text', 'timeoutMs']),
}

function hasOnlyActionArgs(action: ComputerAction, args: Record<string, unknown>): boolean {
  const allowed = COMPUTER_ACTION_ARG_KEYS[action]
  return Object.keys(args).every(key => allowed.has(key))
}

function waitTimeout(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_WAIT_TIMEOUT_MS
    ? value
    : undefined
}

function opaqueComputerActionId(call: ToolCall, runId: string): string {
  const digest = createHmac('sha256', computerActionIdKey)
    .update(runId)
    .update('\0')
    .update(call.id)
    .digest('hex')
    .slice(0, 32)
  return `${runId}:computer-${digest}`
}

function dispatchInput(call: ToolCall, ctx: ToolContext, action: ComputerAction): ComputerDispatchInput {
  const args = call.args ?? {}
  const runId = ctx.runId ?? `run-${ctx.sendId}`
  const browserTaskId = ctx.browserTaskId ?? `bt-run-${runId}`
  const base: ComputerDispatchInput = {
    actionId: opaqueComputerActionId(call, runId),
    browserTaskId,
    runId,
    action,
  }
  const observationId = typeof args.observationId === 'string' ? args.observationId : undefined
  const elementRef = typeof args.elementRef === 'string' ? args.elementRef : undefined

  const effectAction = action === 'click' || action === 'type' || action === 'key' || action === 'scroll'
  if (effectAction && observationId) base.observationId = observationId
  if (effectAction && elementRef) base.elementRef = elementRef
  if (action === 'type') {
    base.text = typeof args.text === 'string' ? args.text : ''
  } else if (action === 'key') {
    base.key = String(args.key ?? '') as ComputerKey
  } else if (action === 'scroll') {
    base.deltaX = discreteScrollStep(args.deltaX) ? args.deltaX : 0
    base.deltaY = discreteScrollStep(args.deltaY) ? args.deltaY : 0
  } else if (action === 'wait_for') {
    base.waitFor = {
      ...(elementRef ? { elementRef } : {}),
      ...(typeof args.text === 'string' ? { text: args.text } : {}),
    }
    const timeoutMs = waitTimeout(args.timeoutMs)
    if (timeoutMs !== undefined) base.timeoutMs = timeoutMs
  }
  return base
}

export const computerHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx): Promise<ToolResult> {
    if (!isComputerToolName(call.name)) {
      return { id: call.id, name: call.name, result: '', error: 'Неизвестное действие Computer Use.' }
    }
    const action = COMPUTER_TOOL_ACTION[call.name]
    if (!ctx.computerUseAllowedActions?.includes(action)) {
      return {
        id: call.id,
        name: call.name,
        result: '',
        error: `Computer Use заблокирован: исходная команда пользователя не разрешает действие ${action} в выбранном окне.`,
      }
    }
    if (typeof call.args?.text === 'string' && scanText(call.args.text).hits.length > 0) {
      return {
        id: call.id,
        name: call.name,
        result: '',
        error: 'Computer Use заблокирован: секретные данные нельзя передавать через управление окном.',
      }
    }
    if (action === 'type' && Object.prototype.hasOwnProperty.call(call.args ?? {}, 'clearFirst')) {
      return {
        id: call.id,
        name: call.name,
        result: '',
        error: 'Computer Use заблокирован: clearFirst и замена содержимого не поддерживаются; разрешён только явный append без этого поля.',
      }
    }
    const args = call.args ?? {}
    if (!hasOnlyActionArgs(action, args)) {
      return {
        id: call.id,
        name: call.name,
        result: '',
        error: 'Computer Use заблокирован: действие содержит несовместимое поле или маршрут параметров.',
      }
    }
    if (action === 'wait_for' && Object.prototype.hasOwnProperty.call(args, 'timeoutMs')
      && waitTimeout(args.timeoutMs) === undefined) {
      return {
        id: call.id,
        name: call.name,
        result: '',
        error: `Computer Use заблокирован: timeoutMs должен быть целым числом от 0 до ${MAX_WAIT_TIMEOUT_MS}.`,
      }
    }
    if ((call.args?.observationId !== undefined && !isComputerObservationRef(call.args.observationId))
      || (call.args?.elementRef !== undefined && !isComputerElementRef(call.args.elementRef))) {
      return {
        id: call.id,
        name: call.name,
        result: '',
        error: 'Computer Use заблокирован: ссылка на наблюдение или элемент не выдана текущим контроллером.',
      }
    }
    if (action === 'scroll') {
      const deltaX = call.args?.deltaX ?? 0
      const deltaY = call.args?.deltaY
      if (!discreteScrollStep(deltaX) || !discreteScrollStep(deltaY)
        || (deltaX === 0 && deltaY === 0)) {
        return {
          id: call.id,
          name: call.name,
          result: '',
          error: 'Computer Use заблокирован: scroll разрешает один UIA small step по оси (-1, 0 или 1).',
        }
      }
    }

    const { decision, reason } = resolveDecision(call.name, call.args, ctx.agentMode, ctx.autoApprove, ctx.permissionRules, ctx.capabilityTrust)
    if (decision === 'block') {
      return { id: call.id, name: call.name, result: '', error: reason ?? blockReason(call.name, ctx.agentMode) }
    }
    if (decision === 'confirm') {
      // The selected-window capability is the R2 consent boundary. There is no
      // generic command modal that could truthfully approve an OS-input action;
      // a trust/ask rule that demands an additional pause therefore fails closed.
      return { id: call.id, name: call.name, result: '', error: 'Computer Use требует отдельного подтверждения, но поверхность подтверждения недоступна — действие заблокировано.' }
    }

    const controller = depsRef.controller
    if (!controller) {
      return { id: call.id, name: call.name, result: '', error: 'Computer Use не настроен — выберите окно в настройках.' }
    }
    const trackedStop = trackComputerRunStop(
      ctx.signal,
      controller,
      browserTaskIdFor(ctx),
      runIdFor(ctx),
    )
    if (ctx.signal.aborted) {
      await startComputerRunStop(computerStopBySignal.get(ctx.signal)!, trackedStop)
      return { id: call.id, name: call.name, result: '', error: 'Запрос остановлен до действия Computer Use.' }
    }
    const input = dispatchInput(call, ctx, action)
    const activityCall = projectToolCallForTelemetry(call, { opaqueId: input.actionId })
    try {
      const rawOutcome = await controller.dispatch(input)
      const outcome = { ...rawOutcome, actionId: input.actionId }
      const summary = summarizeToolCall(activityCall.name, activityCall.args, outcome)
      emitActivity(ctx, activityCall, outcome.ok ? 'ok' : 'error', summary?.label ?? call.name, summary?.detail ?? 'действие выбранного окна')
      const observationForModel = outcome.observation
        ? wrapComputerObservationForModel(outcome.observation)
        : null
      const result = {
        actionId: outcome.actionId,
        status: outcome.status,
        detail: outcome.detail,
        ...(observationForModel ? {
          observation: observationForModel.structured,
          observationText: observationForModel.text,
          ...(observationForModel.redactionHits.length > 0
            ? { redacted: observationForModel.redactionHits }
            : {}),
          ...(observationForModel.truncated ? { truncated: true } : {}),
        } : {}),
      }
      if (outcome.status === 'verified' && outcome.ok) {
        return { id: call.id, name: call.name, result }
      }
      const error = outcome.status === 'uncertain'
        ? `${outcome.detail} Исход действия неизвестен; автоматический повтор запрещён.`
        : outcome.detail || outcome.reason || 'Действие Computer Use отклонено.'
      return { id: call.id, name: call.name, result, error }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const summary = summarizeToolCall(activityCall.name, activityCall.args, null)
      emitActivity(ctx, activityCall, 'error', summary?.label ?? call.name, summary?.detail ?? 'ошибка Computer Use')
      return { id: call.id, name: call.name, result: '', error: `Computer Use: ${message}` }
    }
  },
}

function runIdFor(ctx: ToolContext): string {
  return ctx.runId ?? `run-${ctx.sendId}`
}

function browserTaskIdFor(ctx: ToolContext): string {
  return ctx.browserTaskId ?? `bt-run-${runIdFor(ctx)}`
}
