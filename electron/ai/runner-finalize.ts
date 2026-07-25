import type { InputAccounting } from '../../shared/contracts/usage'
import type { AgentRuns } from '../storage/agent-runs'
import { usageHash } from '../storage/agent-run-usage'
import { exitReasonToAgentRunStatus } from './run-lifecycle'
import { PROVIDERS, type ProviderId } from './registry'
import { suspendedSends } from './runner-shared'
import { scanText } from './secret-scanner'
import { writeSessionJournal, type ExitReason } from './session-journal'
import type { ChatMessage } from './types'

export interface RunnerSessionUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  inputAccounting: InputAccounting | undefined
}

export interface FinalizeApiRunInput {
  sendId: number
  projectPath: string
  exitReason: ExitReason
  lastAssistantText: string
  lastSummary: string
  filesTouched: Set<string>
  commandsRun: string[]
  sessionUsage: RunnerSessionUsage
  recordJournal: (
    projectPath: string,
    kind: 'tool' | 'session' | 'note',
    title: string,
    detail?: string | null
  ) => void
  saveMemory: (
    projectPath: string,
    kind: string,
    content: string,
    tags: string[]
  ) => unknown
  agentRuns?: AgentRuns
  runId?: string
  providerId?: ProviderId
  model?: string
  initialMessages: ChatMessage[]
  toolsSignature: string | null
  attestedThisRun: boolean
  toolCallCount: number
  agentsCount: number
  costCents: number
  clearCheckpointThrottle: (runId: string) => void
}

function persistSessionSummary(input: FinalizeApiRunInput): void {
  if (!input.lastSummary.trim() || !input.projectPath) return
  try {
    const safe = scanText(input.lastSummary.trim()).redacted.slice(0, 2000)
    input.saveMemory(
      input.projectPath,
      'fact',
      `Итог прошлой сессии: ${safe}`,
      ['session-summary']
    )
  } catch (err) {
    console.warn(
      '[runner-finalize] session-summary persist failed:',
      err instanceof Error ? err.message : err
    )
  }
}

function persistUsage(input: FinalizeApiRunInput, agentRuns: AgentRuns, runId: string): void {
  const { providerId, sessionUsage } = input
  const hasUsage =
    sessionUsage.inputTokens ||
    sessionUsage.outputTokens ||
    sessionUsage.cachedInputTokens
  if (!providerId || !hasUsage) return

  try {
    const systemText = input.initialMessages.find(message => message.role === 'system')?.content
    agentRuns.persistUsage({
      runId,
      providerId,
      model: input.model ?? '',
      transport: PROVIDERS[providerId]?.transport ?? null,
      inputTokens: sessionUsage.inputTokens,
      outputTokens: sessionUsage.outputTokens,
      cacheReadTokens: sessionUsage.cachedInputTokens,
      cacheWriteTokens: sessionUsage.cacheWriteTokens,
      inputAccounting: sessionUsage.inputAccounting,
      systemPromptHash: systemText ? usageHash(systemText) : null,
      toolsHash: input.toolsSignature ? usageHash(input.toolsSignature) : null,
    })
  } catch {
    // Usage persistence is diagnostic and must not break finalization.
  }
}

function persistAgentRun(input: FinalizeApiRunInput): void {
  const { agentRuns, runId } = input
  if (!agentRuns || !runId) return

  try {
    if (
      input.exitReason === 'completed' &&
      input.filesTouched.size > 0 &&
      !input.attestedThisRun
    ) {
      agentRuns.appendEvent(runId, 'verify', {
        status: 'not_run',
        label: 'DoD не запущен',
        detail: `Изменено файлов: ${input.filesTouched.size}, но attest_verification не вызван — итог не доказан проверками.`,
      })
    }

    if (input.lastAssistantText.trim()) {
      agentRuns.appendEvent(runId, 'assistant_msg', {
        detail: input.lastAssistantText.slice(0, 500),
        status: input.exitReason,
      })
    }

    const finishStatus = suspendedSends.has(input.sendId)
      ? 'suspended'
      : exitReasonToAgentRunStatus(input.exitReason)
    const failed =
      input.exitReason === 'error' || input.exitReason === 'crashed'
    agentRuns.finish(runId, finishStatus, {
      costCents: input.costCents,
      toolCount: input.toolCallCount,
      filesCount: input.filesTouched.size,
      agentsCount: input.agentsCount,
      error: failed
        ? input.lastAssistantText.slice(0, 500) || input.exitReason
        : null,
    })

    persistUsage(input, agentRuns, runId)

    if (input.exitReason === 'completed') {
      agentRuns.clearCheckpoint(runId)
    }
    input.clearCheckpointThrottle(runId)
  } catch (err) {
    console.warn(
      '[runner-finalize] agent run persistence failed:',
      err instanceof Error ? err.message : err
    )
  }
}

/**
 * Единая терминальная точка API-runner'а.
 *
 * Здесь собраны гарантированные side-effects завершения: журнал, безопасное
 * резюме, Timeline, usage и checkpoint. Провайдерный цикл выбирает exitReason,
 * а эта функция одинаково применяет его на всех выходах.
 */
export function finalizeApiRun(input: FinalizeApiRunInput): void {
  try {
    writeSessionJournal(
      input.recordJournal,
      input.projectPath,
      input.lastAssistantText,
      input.filesTouched,
      input.commandsRun,
      input.sessionUsage,
      input.exitReason
    )
  } catch (err) {
    console.error('[runner-finalize] writeSessionJournal failed:', err)
  }

  persistSessionSummary(input)
  persistAgentRun(input)
}
