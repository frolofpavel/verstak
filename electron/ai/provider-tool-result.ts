import { isComputerToolName } from './computer/tool-names'
import type { ToolResult } from './types'

/** Ordinary OpenAI/Claude tool-result cap. Computer observations cannot use it:
 *  Calculator's unlabeled `observation.elements` already fills the budget, so
 *  digit labels in `observationText` never reach verstak-gateway / Claude. */
const PROVIDER_TOOL_RESULT_CAP = 5000

export function serializeProviderToolResult(result: ToolResult): string {
  const body = serializeProviderToolResultBody(result)
  return result.error ? `Error: ${result.error}\n${body}` : body
}

export function serializeProviderToolResultBody(result: ToolResult): string {
  if (typeof result.result === 'string') return result.result
  if (result.result == null) return ''
  if (isComputerToolName(result.name)) return serializeComputerToolResult(result.result)
  return JSON.stringify(result.result).slice(0, PROVIDER_TOOL_RESULT_CAP)
}

function serializeComputerToolResult(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  const record = value as Record<string, unknown>
  const observation = record.observation && typeof record.observation === 'object'
    ? record.observation as Record<string, unknown>
    : null
  return JSON.stringify({
    actionId: record.actionId,
    status: record.status,
    detail: record.detail,
    observationId: observation?.observationId,
    observationVersion: observation?.observationVersion,
    bindingGeneration: observation?.bindingGeneration,
    foreground: observation?.foreground,
    observationText: record.observationText,
    ...(Array.isArray(record.redacted) && record.redacted.length > 0
      ? { redacted: record.redacted }
      : {}),
    ...(record.truncated === true ? { truncated: true } : {}),
  })
}
