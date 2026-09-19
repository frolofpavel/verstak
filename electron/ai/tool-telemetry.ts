import type { ChatMessage, ToolCall, ToolResult } from './types'
import { isComputerToolName } from './computer/tool-names'

const COMPUTER_TYPE_TOOL = 'computer_type'
export const COMPUTER_CONTEXT_OMITTED = '[Computer Use context omitted from durable run state]'
export const COMPUTER_CONTEXT_OMITTED_TOOL = 'computer_context_omitted'
export const COMPUTER_CONTEXT_OMITTED_ERROR = '[Computer Use technical detail omitted]'
export const COMPUTER_CONTEXT_OMITTED_CALL_ID = 'computer-call-omitted'
export const COMPUTER_PROVIDER_ERROR = 'Computer Use: ошибка провайдера; технические детали скрыты.'

export interface PersistenceProjectionOptions {
  /** The caller already knows a selected-window observation reached the model. */
  computerContextInitiallyExposed?: boolean
  /** Active desktop runs keep provider conversation in memory only. System
   *  policy may remain, but user/assistant text is omitted from checkpoints. */
  omitConversationContent?: boolean
}

export interface ToolTelemetryProjectionOptions {
  /** A selected-window capability envelope is active. Non-computer calls are
   * blocked, and their model-authored name/args may contain desktop-derived text. */
  omitNonComputerArgs?: boolean
  /** Per-run opaque correlation id. Provider ids and thought signatures are
   * execution-only data once a Computer capability envelope is active. */
  opaqueId?: string
}

/**
 * Safe telemetry view of tool arguments.
 *
 * `computer_type.text` is execution data, not observability data: it can contain
 * passwords, personal text, or clipboard contents. Keep only the routing fields
 * required to correlate a call with an observation plus non-reversible metadata.
 * Every other tool deliberately retains the exact args object so this boundary is
 * a no-op until a tool receives an explicit projection here.
 */
export function projectToolArgsForTelemetry(
  toolName: string,
  args: Record<string, unknown>,
  options: ToolTelemetryProjectionOptions = {},
): Record<string, unknown> {
  if (!isComputerToolName(toolName)) {
    return options.omitNonComputerArgs ? { computerContextOmitted: true } : args
  }

  const projected: Record<string, unknown> = {}
  if (typeof args.observationId === 'string') projected.hasObservationId = true
  if (typeof args.elementRef === 'string') projected.hasElementRef = true
  if (toolName === COMPUTER_TYPE_TOOL) {
    if (typeof args.clearFirst === 'boolean') projected.clearFirst = args.clearFirst
  } else if (toolName === 'computer_wait_for' && args.timeoutMs !== undefined) {
    projected.timeoutMs = typeof args.timeoutMs === 'number'
      && Number.isSafeInteger(args.timeoutMs)
      && args.timeoutMs >= 0
      && args.timeoutMs <= 5_000
      ? 'bounded'
      : 'invalid'
  }

  if (toolName === 'computer_key' && typeof args.key === 'string') {
    projected.key = ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown'].includes(args.key)
      ? args.key
      : 'invalid'
  }
  if (toolName === 'computer_scroll') {
    if (args.deltaX !== undefined) {
      projected.deltaX = args.deltaX === -1 || args.deltaX === 0 || args.deltaX === 1
        ? args.deltaX
        : 'invalid'
    }
    if (args.deltaY !== undefined) {
      projected.deltaY = args.deltaY === -1 || args.deltaY === 0 || args.deltaY === 1
        ? args.deltaY
        : 'invalid'
    }
  }

  if (typeof args.text === 'string') {
    projected.textLength = Array.from(args.text).length
  }

  return projected
}

/** Clone only the call envelope; handler/provider execution continues to use the original call. */
export function projectToolCallForTelemetry(
  call: ToolCall,
  options: ToolTelemetryProjectionOptions = {},
): ToolCall {
  const args = projectToolArgsForTelemetry(call.name, call.args, options)
  const protectedEnvelope = isComputerToolName(call.name) || options.omitNonComputerArgs === true
  const envelope = protectedEnvelope
    ? {
        id: options.opaqueId ?? COMPUTER_CONTEXT_OMITTED_CALL_ID,
        name: call.name,
        args: call.args,
        ...(call.argsError ? { argsError: call.argsError } : {}),
      }
    : call
  if (options.omitNonComputerArgs && !isComputerToolName(call.name)) {
    return { ...envelope, name: COMPUTER_CONTEXT_OMITTED_TOOL, args }
  }
  return args === call.args && envelope === call ? call : { ...envelope, args }
}

/** Builds a per-run opaque call-id projector without adding any private-value
 * equality signal to the returned telemetry envelope. */
export function createToolCallProjector(): (
  call: ToolCall,
  options?: ToolTelemetryProjectionOptions,
) => ToolCall {
  const idTags = new Map<string, string>()
  let nextId = 0
  return (call, options = {}) => {
    const protectedEnvelope = isComputerToolName(call.name) || options.omitNonComputerArgs === true
    let opaqueId = options.opaqueId
    if (protectedEnvelope && !opaqueId) {
      opaqueId = idTags.get(call.id)
      if (!opaqueId) {
        opaqueId = idTags.size < 2_048 ? `computer-call-${++nextId}` : 'computer-call-overflow'
        if (idTags.size < 2_048) idTags.set(call.id, opaqueId)
      }
    }
    return projectToolCallForTelemetry(call, { ...options, opaqueId })
  }
}

/**
 * Builds a per-run projector for loop identity. Raw private text remains only
 * as an in-memory Map key and never reaches a hook, checkpoint, event or log.
 * Equal-length but different inputs receive different opaque ordinals, while
 * retries of the exact same value keep one signature. The tag is for an
 * in-memory callSignature only; durable sinks must use createToolCallProjector.
 *
 * Живая приёмка 19.09: маршрутные поля (`elementRef`, `observationId`) нуждаются
 * в том же теге, что и текст. Durable-проекция сводит их к `hasElementRef` /
 * `hasObservationId`, поэтому без тега подпись КАЖДОГО клика прогона одинакова и
 * детектор зацикливания глушит третий клик подряд, чем бы он ни был — в
 * Калькуляторе «125» обрывалось на «12». Тот же класс, что Д4 в `loop-detect.ts`:
 * вырожденная подпись блокирует работу, а не цикл.
 */
export function createEphemeralToolCallProjector(
  projectCall = createToolCallProjector(),
): (
  call: ToolCall,
  options?: ToolTelemetryProjectionOptions,
) => ToolCall {
  const createTagger = (prefix: string) => {
    const tags = new Map<string, string>()
    let next = 0
    return (privateKey: string): string => {
      let tag = tags.get(privateKey)
      if (!tag) {
        tag = tags.size < 2_048 ? `${prefix}-${++next}` : `${prefix}-overflow`
        if (tags.size < 2_048) tags.set(privateKey, tag)
      }
      return tag
    }
  }
  const textTag = createTagger('text')
  const elementTag = createTagger('element')
  const observationTag = createTagger('observation')
  return (call, options = {}) => {
    const projected = projectCall(call, options)
    if (!isComputerToolName(call.name) || projected === call) return projected
    const args: Record<string, unknown> = { ...projected.args }
    let tagged = false
    if (typeof call.args.text === 'string') {
      args.ephemeralTextTag = textTag(`${call.name}\u0000${call.args.text}`)
      tagged = true
    }
    if (typeof call.args.elementRef === 'string') {
      args.ephemeralElementTag = elementTag(call.args.elementRef)
      tagged = true
    }
    if (typeof call.args.observationId === 'string') {
      args.ephemeralObservationTag = observationTag(call.args.observationId)
      tagged = true
    }
    return tagged ? { ...projected, args } : projected
  }
}

/** Selected-window content is execution context, never durable telemetry. */
export function projectToolResultForTelemetry(toolName: string, result: unknown): unknown {
  if (!isComputerToolName(toolName) || !result || typeof result !== 'object' || Array.isArray(result)) {
    return result
  }
  const raw = result as Record<string, unknown>
  const projected: Record<string, unknown> = {}
  for (const key of ['actionId', 'status', 'detail', 'reason'] as const) {
    if (typeof raw[key] === 'string') projected[key] = raw[key]
  }
  if (raw.observation && typeof raw.observation === 'object' && !Array.isArray(raw.observation)) {
    const observation = raw.observation as Record<string, unknown>
    const structural: Record<string, unknown> = {}
    if (typeof observation.observationId === 'string') structural.observationId = observation.observationId
    if (typeof observation.observationVersion === 'number' && Number.isFinite(observation.observationVersion)) {
      structural.observationVersion = observation.observationVersion
    }
    structural.elementCount = Array.isArray(observation.elements) ? observation.elements.length : 0
    structural.textLength = typeof observation.text === 'string' ? Array.from(observation.text).length : 0
    structural.screenshotPresent = typeof observation.screenshotDataUrl === 'string'
    structural.omissions = Array.isArray(observation.omissions)
      ? observation.omissions.filter(value => typeof value === 'string').slice(0, 32)
      : []
    projected.observation = structural
  }
  return projected
}

/**
 * Persistence-only conversation view. Live provider history keeps the original
 * tool calls; crash-resume storage receives cloned envelopes only where a
 * sensitive computer_type call is present.
 */
export function projectMessagesForPersistence(
  messages: ChatMessage[],
  options: PersistenceProjectionOptions = {},
): ChatMessage[] {
  let changed = false
  const callIds = new Map<string, string>()
  let nextCallId = 0
  const opaqueCallId = (id: string): string => {
    let opaque = callIds.get(id)
    if (!opaque) {
      opaque = callIds.size < 2_048 ? `computer-call-${++nextCallId}` : 'computer-call-overflow'
      if (callIds.size < 2_048) callIds.set(id, opaque)
    }
    return opaque
  }
  let computerContextSeen = options.computerContextInitiallyExposed === true
    || options.omitConversationContent === true
  const projected = messages.map(message => {
    // The capability boundary is tainted by the attempt itself, not only by a
    // successful observation. A failed Computer call can still carry private
    // typed text, provider ids or controller diagnostics, and a same-batch
    // cross-tool must be projected before durable storage as well.
    if (message.toolCalls?.some(call => isComputerToolName(call.name))
      || message.toolResults?.some(result => isComputerToolName(result.name))) {
      computerContextSeen = true
    }
    const toolCalls = message.toolCalls?.map(call => {
      const protectEnvelope = computerContextSeen || isComputerToolName(call.name)
      const safeCall = projectToolCallForTelemetry(call, {
        omitNonComputerArgs: computerContextSeen,
        ...(protectEnvelope ? { opaqueId: opaqueCallId(call.id) } : {}),
      })
      if (safeCall !== call) changed = true
      return safeCall
    })
    const toolResults = message.toolResults?.map(result => {
      const omitNonComputer = computerContextSeen && !isComputerToolName(result.name)
      const protectEnvelope = computerContextSeen || isComputerToolName(result.name)
      const safeResult = omitNonComputer
        ? { computerContextOmitted: true }
        : projectToolResultForTelemetry(result.name, result.result)
      const safeName = omitNonComputer ? COMPUTER_CONTEXT_OMITTED_TOOL : result.name
      const safeError = protectEnvelope && result.error
        ? COMPUTER_CONTEXT_OMITTED_ERROR
        : result.error
      const safeId = protectEnvelope ? opaqueCallId(result.id) : result.id
      if (safeResult === result.result && safeName === result.name && safeError === result.error && safeId === result.id) return result
      changed = true
      return { ...result, id: safeId, name: safeName, result: safeResult, error: safeError } as ToolResult
    })
    // Renderer-composed skill/task system layers can echo the current request.
    // During an active Computer run they are as private as user/assistant text,
    // so no conversation role is exempt from the durable projection.
    const omitConversation = options.omitConversationContent === true
    const omitAssistant = computerContextSeen && message.role === 'assistant'
    const omitContent = omitConversation || omitAssistant
    const content = omitContent && message.content
      ? COMPUTER_CONTEXT_OMITTED
      : message.content
    const thinking = omitContent && message.thinking ? '' : message.thinking
    const attachments = omitConversation && message.attachments ? undefined : message.attachments
    if (content !== message.content) changed = true
    if (thinking !== message.thinking) changed = true
    if (attachments !== message.attachments) changed = true
    const callsChanged = toolCalls?.some((call, index) => call !== message.toolCalls?.[index]) === true
    const resultsChanged = toolResults?.some((result, index) => result !== message.toolResults?.[index]) === true
    const next = callsChanged || resultsChanged || content !== message.content || thinking !== message.thinking || attachments !== message.attachments
      ? { ...message, content, thinking, attachments, toolCalls, toolResults }
      : message
    return next
  })
  return changed ? projected : messages
}
