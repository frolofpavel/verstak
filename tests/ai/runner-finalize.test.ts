import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuns } from '../../electron/storage/agent-runs'
import { finalizeApiRun, type FinalizeApiRunInput } from '../../electron/ai/runner-finalize'
import { suspendedSends } from '../../electron/ai/runner-shared'

function createRuns() {
  return {
    appendEvent: vi.fn(),
    finish: vi.fn(),
    persistUsage: vi.fn(),
    clearCheckpoint: vi.fn(),
  }
}

function createInput(
  overrides: Partial<FinalizeApiRunInput> = {}
): FinalizeApiRunInput {
  return {
    sendId: 101,
    projectPath: 'C:\\project',
    exitReason: 'completed',
    lastAssistantText: 'Готово: задача завершена и проверена.',
    lastSummary: '',
    filesTouched: new Set(),
    commandsRun: [],
    sessionUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      inputAccounting: undefined,
    },
    recordJournal: vi.fn(),
    saveMemory: vi.fn(),
    initialMessages: [{ role: 'system', content: 'system prompt' }],
    toolsSignature: null,
    attestedThisRun: false,
    toolCallCount: 0,
    agentsCount: 1,
    costCents: 0,
    clearCheckpointThrottle: vi.fn(),
    ...overrides,
  }
}

afterEach(() => {
  suspendedSends.clear()
})

describe('runner-finalize — единая терминальная точка API-runner', () => {
  it('completed сохраняет доказательства, usage и очищает checkpoint', () => {
    const runs = createRuns()
    const saveMemory = vi.fn()
    const clearCheckpointThrottle = vi.fn()
    const input = createInput({
      agentRuns: runs as unknown as AgentRuns,
      runId: 'run-1',
      providerId: 'gemini-api',
      model: 'gemini-3-flash',
      filesTouched: new Set(['src/a.ts']),
      commandsRun: ['npm run type'],
      lastSummary: 'Ключ sk-proj-abcdefghijklmnopqrstuvwx использован в задаче',
      sessionUsage: {
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 50,
        cacheWriteTokens: 10,
        inputAccounting: 'inclusive',
      },
      toolsSignature: 'read_file,write_file',
      toolCallCount: 3,
      agentsCount: 2,
      costCents: 17,
      saveMemory,
      clearCheckpointThrottle,
    })

    finalizeApiRun(input)

    expect(input.recordJournal).toHaveBeenCalledWith(
      'C:\\project',
      'session',
      expect.any(String),
      expect.stringContaining('src/a.ts')
    )
    expect(saveMemory).toHaveBeenCalledOnce()
    const savedSummary = String(saveMemory.mock.calls[0]?.[2])
    expect(savedSummary).toContain('REDACTED')
    expect(savedSummary).not.toContain('sk-proj-abcdefghijklmnopqrstuvwx')
    expect(runs.appendEvent).toHaveBeenCalledWith(
      'run-1',
      'verify',
      expect.objectContaining({ status: 'not_run' })
    )
    expect(runs.finish).toHaveBeenCalledWith('run-1', 'done', {
      costCents: 17,
      toolCount: 3,
      filesCount: 1,
      agentsCount: 2,
      error: null,
    })
    expect(runs.persistUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        providerId: 'gemini-api',
        model: 'gemini-3-flash',
        inputTokens: 100,
        outputTokens: 20,
      })
    )
    expect(runs.clearCheckpoint).toHaveBeenCalledWith('run-1')
    expect(clearCheckpointThrottle).toHaveBeenCalledWith('run-1')
  })

  it('failed фиксирует ошибку и сохраняет checkpoint для resume', () => {
    const runs = createRuns()
    const clearCheckpointThrottle = vi.fn()

    finalizeApiRun(
      createInput({
        agentRuns: runs as unknown as AgentRuns,
        runId: 'run-failed',
        exitReason: 'crashed',
        lastAssistantText: 'provider crashed',
        clearCheckpointThrottle,
      })
    )

    expect(runs.finish).toHaveBeenCalledWith(
      'run-failed',
      'failed',
      expect.objectContaining({ error: 'provider crashed' })
    )
    expect(runs.clearCheckpoint).not.toHaveBeenCalled()
    expect(clearCheckpointThrottle).toHaveBeenCalledWith('run-failed')
  })

  it('suspended имеет приоритет над обычным статусом завершения', () => {
    const runs = createRuns()
    suspendedSends.add(101)

    finalizeApiRun(
      createInput({
        agentRuns: runs as unknown as AgentRuns,
        runId: 'run-suspended',
      })
    )

    expect(runs.finish).toHaveBeenCalledWith(
      'run-suspended',
      'suspended',
      expect.any(Object)
    )
  })

  it('без AgentRuns всё равно пишет журнал и безопасное резюме', () => {
    const recordJournal = vi.fn()
    const saveMemory = vi.fn()

    finalizeApiRun(
      createInput({
        exitReason: 'aborted',
        lastAssistantText: '',
        lastSummary: 'Работа остановлена пользователем',
        recordJournal,
        saveMemory,
      })
    )

    expect(recordJournal).toHaveBeenCalledWith(
      'C:\\project',
      'session',
      expect.stringContaining('Прерывание'),
      expect.stringContaining('aborted')
    )
    expect(saveMemory).toHaveBeenCalledOnce()
  })
})
