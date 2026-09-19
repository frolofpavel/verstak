import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompiledHooks } from '../../../electron/ai/hooks'
import { dispatchToolTurn } from '../../../electron/ai/runner-tool-turn'
import {
  COMPUTER_CONTEXT_OMITTED,
  COMPUTER_CONTEXT_OMITTED_CALL_ID,
  COMPUTER_CONTEXT_OMITTED_ERROR,
  COMPUTER_CONTEXT_OMITTED_TOOL,
  COMPUTER_PROVIDER_ERROR,
  projectToolArgsForTelemetry,
  projectToolCallForTelemetry,
  projectMessagesForPersistence,
  createEphemeralToolCallProjector,
  projectToolResultForTelemetry,
} from '../../../electron/ai/tool-telemetry'
import type { ChatEvent, ChatMessage, ChatProvider, ToolCall } from '../../../electron/ai/types'
import type { ToolContext } from '../../../electron/ipc/tool-handlers'
import { usageHash } from '../../../electron/storage/agent-run-usage'
import { composeSkillSystemPrompt } from '../../../src/components/chat/skill-prompts'
import type { Skill } from '../../../src/types/api'

const SECRET = 'Пароль🔐-never-persist-42'
const COMPUTER_USE_SYSTEM = '<verstak_computer_use_envelope marker="VERSTAK_COMPUTER_USE_ENVELOPE_V1">trusted</verstak_computer_use_envelope>'

const captured = vi.hoisted(() => ({
  signatures: [] as ToolCall[],
  stepInputs: [] as unknown[],
  memoryObservations: [] as unknown[],
  progressTurns: [] as unknown[],
  handlerArgs: [] as Array<Record<string, unknown>>,
  hookPayloads: [] as Array<{ event: string; payload: Record<string, unknown> }>,
  runtimeErrors: [] as unknown[][],
}))

vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { getPath: () => tmpdir() } }))

vi.mock('../../../electron/runtime-log', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../electron/runtime-log')>()
  return {
    ...actual,
    logRuntimeError: (...args: unknown[]) => {
      captured.runtimeErrors.push(args)
    },
  }
})

vi.mock('../../../electron/ai/session-journal', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../electron/ai/session-journal')>()
  return {
    ...actual,
    callSignature: (call: ToolCall) => {
      captured.signatures.push(call)
      return actual.callSignature(call)
    },
  }
})

vi.mock('../../../electron/ai/step-log', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../electron/ai/step-log')>()
  return {
    ...actual,
    formatStepLine: (input: Parameters<typeof actual.formatStepLine>[0]) => {
      captured.stepInputs.push(input)
      return actual.formatStepLine(input)
    },
  }
})

vi.mock('../../../electron/ai/memory-hooks', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../electron/ai/memory-hooks')>()
  return {
    ...actual,
    captureToolObservation: (...args: Parameters<typeof actual.captureToolObservation>) => {
      captured.memoryObservations.push(args[1])
      return actual.captureToolObservation(...args)
    },
  }
})

vi.mock('../../../electron/ai/progress', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../electron/ai/progress')>()
  return {
    ...actual,
    recordTurn: (...args: Parameters<typeof actual.recordTurn>) => {
      captured.progressTurns.push(args[1])
      return actual.recordTurn(...args)
    },
  }
})

vi.mock('../../../electron/ai/hooks', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../electron/ai/hooks')>()
  return {
    ...actual,
    runHooks: async (
      event: Parameters<typeof actual.runHooks>[0],
      hooks: Parameters<typeof actual.runHooks>[1],
      payload: Parameters<typeof actual.runHooks>[2],
    ) => {
      captured.hookPayloads.push({
        event,
        payload: payload as unknown as Record<string, unknown>,
      })
      return actual.runHooks(event, hooks, payload)
    },
  }
})

vi.mock('../../../electron/ipc/tool-handlers', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../electron/ipc/tool-handlers')>()
  return {
    ...actual,
    lookupHandler: (name: string, context?: ToolContext) => name === 'computer_type'
      ? {
          mode: 'sequential' as const,
          handle: async (call: ToolCall) => {
            captured.handlerArgs.push(call.args)
            return {
              id: call.id,
              name: call.name,
              result: {
                actionId: 'opaque-controller-action-1',
                status: 'verified',
                observation: {
                  observationId: 'observation-20',
                  observationVersion: 20,
                  text: SECRET,
                  elements: [{ label: SECRET }],
                  screenshotDataUrl: `data:image/png;base64,${SECRET}`,
                  omissions: [],
                },
              },
            }
          },
        }
      : actual.lookupHandler(name, context),
  }
})

function computerTypeCall(): ToolCall {
  return {
    id: 'computer-type-1',
    name: 'computer_type',
    args: {
      elementRef: 'element-7',
      observationId: 'observation-19',
      clearFirst: true,
      text: SECRET,
      ignoredUnsafeField: `prefix:${SECRET}:suffix`,
    },
  }
}

describe('computer tool telemetry projection', () => {
  beforeEach(() => {
    captured.signatures.length = 0
    captured.stepInputs.length = 0
    captured.memoryObservations.length = 0
    captured.progressTurns.length = 0
    captured.handlerArgs.length = 0
    captured.hookPayloads.length = 0
    captured.runtimeErrors.length = 0
  })

  it('computer_type оставляет routing и длину по Unicode code points без текста или словарного fingerprint', () => {
    const call = computerTypeCall()

    const projected = projectToolArgsForTelemetry(call.name, call.args)

    expect(projected).toEqual({
      hasElementRef: true,
      hasObservationId: true,
      clearFirst: true,
      textLength: Array.from(SECRET).length,
    })
    expect(JSON.stringify(projected)).not.toContain(SECRET)
    expect(projected).not.toHaveProperty('text')
    expect(projected).not.toHaveProperty('ignoredUnsafeField')
    expect(projected).not.toHaveProperty('textDigest')
    expect(call.args.text).toBe(SECRET)
  })

  it('computer_wait_for не сохраняет искомый текст desktop UI', () => {
    const args = {
      elementRef: 'element-8',
      timeoutMs: 1200,
      text: SECRET,
      ignoredUnsafeField: `prefix:${SECRET}`,
    }
    const projected = projectToolArgsForTelemetry('computer_wait_for', args)

    expect(projected).toEqual({
      hasElementRef: true,
      timeoutMs: 'bounded',
      textLength: Array.from(SECRET).length,
    })
    expect(JSON.stringify(projected)).not.toContain(SECRET)
    expect(projected).not.toHaveProperty('textDigest')
  })

  it('несекретные tools получают прежний объект args без копии и изменения shape', () => {
    const args = { path: 'src/a.ts', nested: { unchanged: true } }
    const readCall: ToolCall = { id: `read-${SECRET}`, name: 'read_file', args, thoughtSignature: SECRET }

    expect(projectToolArgsForTelemetry('read_file', args)).toBe(args)
    const projectedCall = projectToolCallForTelemetry(readCall)
    expect(projectedCall).toBe(readCall)
    expect(projectedCall.args).toBe(args)
    expect(projectedCall).toEqual({ id: `read-${SECRET}`, name: 'read_file', args, thoughtSignature: SECRET })

    expect(projectToolCallForTelemetry(readCall, { omitNonComputerArgs: true })).toEqual({
      id: COMPUTER_CONTEXT_OMITTED_CALL_ID,
      name: COMPUTER_CONTEXT_OMITTED_TOOL,
      args: { computerContextOmitted: true },
    })
  })

  it('normalizes numeric Computer metadata instead of persisting model-authored markers', () => {
    expect(projectToolArgsForTelemetry('computer_scroll', {
      deltaX: 1,
      deltaY: 424_242,
    })).toEqual({ deltaX: 1, deltaY: 'invalid' })
  })

  it.each([0, 1, 5_000])(
    'classifies safe Computer wait timeout %s inside 0..5000 as bounded',
    timeoutMs => {
      expect(projectToolArgsForTelemetry('computer_wait_for', { timeoutMs }))
        .toEqual({ timeoutMs: 'bounded' })
    },
  )

  it.each([-1, 5_001, 3.14, Number.NaN, Number.POSITIVE_INFINITY, '1200'])(
    'classifies invalid Computer wait timeout %s without retaining its value',
    timeoutMs => {
      expect(projectToolArgsForTelemetry('computer_wait_for', { timeoutMs }))
        .toEqual({ timeoutMs: 'invalid' })
    },
  )

  it('omits absent Computer wait timeout metadata', () => {
    expect(projectToolArgsForTelemetry('computer_wait_for', {})).toEqual({})
  })

  it('active Computer checkpoint скрывает system-эхо applied/auto skill и весь provider conversation content', () => {
    const privateUser = `/computer-use: введи ${SECRET}`
    const privateAssistant = `В окне вижу ${SECRET}`
    const manualSkill: Skill = {
      id: 'manual-test', name: 'Manual', systemPrompt: 'MANUAL_STATIC_POLICY', source: 'user', sourceRef: 'test',
    }
    const autoSkill: Skill = {
      id: 'auto-test', name: 'Auto', systemPrompt: 'AUTO_STATIC_POLICY', source: 'user', sourceRef: 'test',
    }
    const echoedSkillSystem = composeSkillSystemPrompt(null, [manualSkill], privateUser, [autoSkill])!
    const activeMessages: ChatMessage[] = [
      { role: 'system', content: echoedSkillSystem },
      { role: 'user', content: privateUser },
      { role: 'assistant', content: privateAssistant, thinking: `thinking:${SECRET}` },
    ]

    const projected = projectMessagesForPersistence(activeMessages, {
      computerContextInitiallyExposed: true,
      omitConversationContent: true,
    })

    expect(echoedSkillSystem).toContain(SECRET)
    expect(projected[0]).toEqual({ role: 'system', content: COMPUTER_CONTEXT_OMITTED })
    expect(projected[1]?.content).toBe(COMPUTER_CONTEXT_OMITTED)
    expect(projected[2]?.content).toBe(COMPUTER_CONTEXT_OMITTED)
    expect(projected[2]?.thinking).toBe('')
    expect(JSON.stringify(projected)).not.toContain(SECRET)
    expect(JSON.stringify(activeMessages)).toContain(SECRET)
  })

  it('loop identity distinguishes equal-length private text with a run-local opaque tag', () => {
    const project = createEphemeralToolCallProjector()
    const first = computerTypeCall()
    const same = { ...first, id: 'same', args: { ...first.args } }
    const other = {
      ...first,
      id: 'other',
      args: { ...first.args, text: 'X'.repeat(Array.from(SECRET).length) },
    }

    const firstProjected = project(first)
    const sameProjected = project(same)
    const otherProjected = project(other)
    expect(firstProjected.args.ephemeralTextTag).toBe(sameProjected.args.ephemeralTextTag)
    expect(firstProjected.args.ephemeralTextTag).not.toBe(otherProjected.args.ephemeralTextTag)
    expect(JSON.stringify([firstProjected, sameProjected, otherProjected])).not.toContain(SECRET)
    expect(JSON.stringify([firstProjected, sameProjected, otherProjected])).not.toContain('textDigest')
  })

  it('desktop observation output is reduced to structural metadata for persistence and hooks', () => {
    const raw = {
      actionId: 'action-1',
      status: 'verified',
      detail: 'independent-readback-verified',
      observation: {
        observationId: 'observation-2',
        observationVersion: 2,
        text: SECRET,
        processName: SECRET,
        title: SECRET,
        screenshotDataUrl: `data:image/png;base64,${SECRET}`,
        elements: [{ elementRef: 'e-1', label: SECRET }],
        omissions: ['screenshot-unavailable'],
      },
    }
    const projected = projectToolResultForTelemetry('computer_observe', raw)

    expect(projected).toEqual({
      actionId: 'action-1',
      status: 'verified',
      detail: 'independent-readback-verified',
      observation: {
        observationId: 'observation-2',
        observationVersion: 2,
        elementCount: 1,
        textLength: Array.from(SECRET).length,
        screenshotPresent: true,
        omissions: ['screenshot-unavailable'],
      },
    })
    expect(JSON.stringify(projected)).not.toContain(SECRET)
  })

  it('does not project arbitrary desktop-looking names or MCP prefix collisions', () => {
    const privateRef = `PRIVATE UI TEXT ${SECRET}`
    const projected = projectToolArgsForTelemetry('computer_click', {
      observationId: privateRef,
      elementRef: privateRef,
    })
    expect(projected).toEqual({ hasObservationId: true, hasElementRef: true })
    expect(JSON.stringify(projected)).not.toContain(privateRef)

    const collision = { observation: { text: SECRET } }
    expect(projectToolResultForTelemetry('computer_upload', collision)).toBe(collision)
  })

  it('checkpoint projection не меняет live messages и сохраняет ссылки для несекретных сообщений', () => {
    const call: ToolCall = {
      ...computerTypeCall(),
      id: `provider-call-${SECRET}`,
      thoughtSignature: `provider-signature-${SECRET}`,
    }
    const userMessage = { role: 'user' as const, content: 'type it' }
    const assistantMessage = { role: 'assistant' as const, content: '', toolCalls: [call] }
    const toolResultMessage = {
      role: 'user' as const,
      content: '',
      toolResults: [{
        id: call.id,
        name: call.name,
        result: { observation: { text: SECRET, elements: [{ label: SECRET }] } },
        error: `controller-error-${SECRET}`,
      }],
    }
    const echoedAssistant = {
      role: 'assistant' as const,
      content: `I saw ${SECRET} in the selected window.`,
      toolCalls: [{
        id: 'blocked-cross-tool',
        name: 'write_file',
        args: { path: 'out.txt', content: SECRET },
      }],
    }
    const messages = [userMessage, assistantMessage, toolResultMessage, echoedAssistant]

    const projected = projectMessagesForPersistence(messages)

    expect(projected).not.toBe(messages)
    expect(projected[0]).toBe(userMessage)
    expect(projected[1]).not.toBe(assistantMessage)
    expect(projected[1].toolCalls?.[0].args).toEqual(projectToolArgsForTelemetry(call.name, call.args))
    expect(projected[1].toolCalls?.[0].id).toBe(projected[2].toolResults?.[0].id)
    expect(projected[1].toolCalls?.[0].id).toMatch(/^computer-call-/)
    expect(projected[1].toolCalls?.[0]).not.toHaveProperty('thoughtSignature')
    expect(projected[2]).not.toBe(toolResultMessage)
    expect(projected[2].toolResults?.[0].error).toBe(COMPUTER_CONTEXT_OMITTED_ERROR)
    expect(projected[3]?.content).not.toContain(SECRET)
    expect(projected[3]?.toolCalls?.[0]?.name).toBe(COMPUTER_CONTEXT_OMITTED_TOOL)
    expect(projected[3]?.toolCalls?.[0]?.args).toEqual({ computerContextOmitted: true })
    expect(JSON.stringify(projected)).not.toContain(SECRET)
    expect(call.args.text).toBe(SECRET)

    const ordinaryMessages = [{
      role: 'assistant' as const,
      content: '',
      toolCalls: [{ id: 'read-2', name: 'read_file', args: { path: 'a.ts' } }],
    }]
    expect(projectMessagesForPersistence(ordinaryMessages)).toBe(ordinaryMessages)
  })

  it('Pre/PostToolUse получают projection, а handler исполняется с исходным text', async () => {
    const call = computerTypeCall()
    const hookPayloads: Array<Record<string, unknown>> = []
    const handledArgs: unknown[] = []
    const hooks = {} as CompiledHooks
    const signal = new AbortController().signal
    const context = {
      sender: { send: vi.fn(), exec: vi.fn() },
      sendId: 7,
      signal,
      projectPath: 'C:\\repo',
    } as unknown as ToolContext

    await dispatchToolTurn({
      toolCalls: [call],
      context,
      hooks,
      addContext: vi.fn(),
      resolveHandler: () => ({
        mode: 'sequential',
        handle: async current => {
          handledArgs.push(current.args)
          return {
            id: current.id,
            name: current.name,
            result: { observation: { text: SECRET, elements: [{ label: SECRET }] } },
          }
        },
      }),
      invokeHooks: vi.fn(async (event, _hooks, payload) => {
        if (event === 'PreToolUse' || event === 'PostToolUse') {
          hookPayloads.push(payload as unknown as Record<string, unknown>)
        }
        return { block: false }
      }),
    })

    expect(handledArgs).toEqual([call.args])
    expect(hookPayloads).toHaveLength(2)
    expect(hookPayloads.every(payload => (
      JSON.stringify(payload.tool_input) === JSON.stringify(projectToolArgsForTelemetry(call.name, call.args))
    ))).toBe(true)
    expect(JSON.stringify(hookPayloads)).not.toContain(SECRET)
  })
})

describe('runApiConversation telemetry sinks', () => {
  let projectPath: string

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'verstak-computer-telemetry-'))
    captured.signatures.length = 0
    captured.stepInputs.length = 0
    captured.memoryObservations.length = 0
    captured.progressTurns.length = 0
    captured.handlerArgs.length = 0
    captured.hookPayloads.length = 0
    captured.runtimeErrors.length = 0
  })

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true })
  })

  it('проносит projection через signature, step, memory, pattern и progress, сохраняя raw только для исполнения', async () => {
    const call: ToolCall = {
      ...computerTypeCall(),
      id: `computer-type-${SECRET}`,
      thoughtSignature: `signature-${SECRET}`,
    }
    const blockedCrossCall: ToolCall = {
      id: `blocked-cross-tool-${SECRET}`,
      name: 'run_command',
      args: { command: `npm test -- desktop-derived ${SECRET} outside the selected window` },
      thoughtSignature: `blocked-signature-${SECRET}`,
    }
    const blockedNameCall: ToolCall = {
      id: `blocked-private-name-${SECRET}`,
      name: `desktop_private_${SECRET}`,
      args: { note: `desktop-derived:${SECRET}` },
      thoughtSignature: `blocked-name-signature-${SECRET}`,
    }
    let turn = 0
    const provider: ChatProvider = {
      id: 'telemetry-provider',
      name: 'telemetry-provider',
      models: ['telemetry-model'],
      async *send(): AsyncGenerator<ChatEvent> {
        turn++
        if (turn === 1) {
          yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 1 } }
          yield { type: 'tool-call', call }
          yield { type: 'tool-call', call: blockedCrossCall }
          yield { type: 'done' }
          return
        }
        if (turn === 2) {
          yield { type: 'tool-call', call: blockedNameCall }
          yield { type: 'done' }
          return
        }
        yield { type: 'text', text: 'Готово: действие в выбранном окне завершено' }
        yield { type: 'done' }
      },
    }
    const sender = { send: vi.fn(), exec: vi.fn(async () => undefined) }
    const appendEvent = vi.fn()
    const saveCheckpoint = vi.fn()
    const trackToolPatternFn = vi.fn()
    const recordJournal = vi.fn()
    const saveMemory = vi.fn(() => ({ id: 'memory-1' }))
    const finish = vi.fn()
    const tick = vi.fn()
    const persistUsage = vi.fn()
    const { createFileTools } = await import('../../../electron/ai/tools')
    const { runApiConversation } = await import('../../../electron/ai/runner-api')
    const signal = new AbortController().signal

    await runApiConversation({
      sender,
      sendId: 71,
      provider,
      tools: createFileTools(projectPath, signal),
      projectPath,
      initialMessages: [
        { role: 'system', content: COMPUTER_USE_SYSTEM },
        { role: 'user', content: '/computer-use: введи тест в выбранное окно' },
      ],
      signal,
      recordWrite: vi.fn(),
      recordPlan: vi.fn(() => ({ id: 1 })),
      recordJournal,
      readJournal: vi.fn(() => []),
      saveMemory,
      invalidateMemory: vi.fn(),
      saveDecision: vi.fn(() => ({ id: 1 })) as never,
      searchMemories: vi.fn(() => []),
      searchConversations: vi.fn(() => []),
      connectors: { list: () => [], query: async () => ({}) },
      agentMode: 'bypass',
      turnsBudget: 3,
      getSecretForDelegate: key => key === 'auto_capture_memory' ? 'true' : null,
      providerId: 'deepseek',
      model: 'telemetry-model',
      computerUseAllowedActions: ['observe', 'wait_for', 'type'],
      computerUseProviderEnvelope: 'fresh-composer-ticket-v1',
      trackToolPatternFn,
      agentRuns: {
        finish,
        appendEvent,
        tick,
        persistUsage,
        saveCheckpoint,
        clearCheckpoint: vi.fn(),
      } as never,
      runId: 'computer-telemetry-run',
    })

    const projection = projectToolArgsForTelemetry(call.name, call.args)
    const omittedCrossProjection = { computerContextOmitted: true }
    const stringify = (value: unknown) => JSON.stringify(value)

    expect(captured.handlerArgs).toEqual([call.args])
    const computerSignatures = captured.signatures.filter(item => item.name === call.name)
    expect(computerSignatures.length).toBeGreaterThanOrEqual(2)
    // Приватные поля вызова получают опаковый порядковый тег — по одному на
    // поле. Их три, а не один: маршрутные elementRef/observationId нужны loop
    // identity ровно так же, как текст (см. loop-identity-clicks.test.ts).
    const ephemeralTagKeys = ['ephemeralTextTag', 'ephemeralElementTag', 'ephemeralObservationTag'] as const
    const withoutEphemeralTags = (args: Record<string, unknown>) => {
      const rest = { ...args }
      for (const key of ephemeralTagKeys) delete rest[key]
      return rest
    }
    expect(computerSignatures.every(item => (
      item.args !== call.args
      && ephemeralTagKeys.every(key => /^(text|element|observation)-\d+$/.test(String(item.args[key])))
      && stringify(withoutEphemeralTags(item.args)) === stringify(projection)
    ))).toBe(true)
    expect(new Set(computerSignatures.map(item => item.args.ephemeralTextTag))).toEqual(new Set(['text-1']))
    const blockedSignatures = captured.signatures.filter(item => item.name === COMPUTER_CONTEXT_OMITTED_TOOL)
    expect(blockedSignatures.length).toBeGreaterThanOrEqual(4)
    expect(blockedSignatures.every(item => (
      stringify(item.args) === stringify(omittedCrossProjection)
    ))).toBe(true)
    expect(captured.signatures.every(item => item.name !== blockedCrossCall.name && item.name !== blockedNameCall.name)).toBe(true)

    const stepCalls = captured.stepInputs.flatMap(input => (
      (input as { calls?: Array<{ name: string; args: unknown }> }).calls ?? []
    )).filter(item => item.name === 'computer_type')
    expect(stepCalls).toHaveLength(1)
    expect(stepCalls[0]).toEqual(expect.objectContaining({
      name: 'computer_type',
      args: projection,
    }))
    const blockedStepCalls = captured.stepInputs.flatMap(input => (
      (input as { calls?: Array<{ name: string; args: unknown }> }).calls ?? []
    )).filter(item => item.name === COMPUTER_CONTEXT_OMITTED_TOOL) as Array<{
      name: string
      args: unknown
      error?: unknown
    }>
    expect(blockedStepCalls).toHaveLength(2)
    expect(blockedStepCalls.every(item => (
      stringify(item.args) === stringify(omittedCrossProjection)
      && item.error === COMPUTER_CONTEXT_OMITTED_ERROR
    ))).toBe(true)
    expect(captured.stepInputs).toContainEqual(expect.objectContaining({
      goal: COMPUTER_CONTEXT_OMITTED,
    }))

    const memoryCall = captured.memoryObservations.find(item => (
      (item as { tool?: string }).tool === 'computer_type'
    )) as { args: unknown }
    expect(memoryCall.args).toEqual(projection)
    const blockedMemoryCalls = captured.memoryObservations.filter(item => (
      (item as { tool?: string }).tool === COMPUTER_CONTEXT_OMITTED_TOOL
    )) as Array<{ args: unknown }>
    expect(blockedMemoryCalls).toHaveLength(2)
    expect(blockedMemoryCalls.every(item => stringify(item.args) === stringify(omittedCrossProjection))).toBe(true)
    expect(trackToolPatternFn).toHaveBeenCalledWith(projectPath, expect.objectContaining({
      tool: 'computer_type',
      args: projection,
    }))
    expect(trackToolPatternFn).toHaveBeenCalledWith(projectPath, expect.objectContaining({
      tool: COMPUTER_CONTEXT_OMITTED_TOOL,
      args: omittedCrossProjection,
    }))
    expect(captured.progressTurns).toHaveLength(2)
    expect(captured.progressTurns[0]).toEqual([
      expect.objectContaining({ name: 'computer_type', args: projection }),
      expect.objectContaining({ name: COMPUTER_CONTEXT_OMITTED_TOOL, args: omittedCrossProjection }),
    ])

    const stepEvents = appendEvent.mock.calls.filter((args: unknown[]) => args[1] === 'step')
    expect(stepEvents).toHaveLength(2)
    expect(stringify(stepEvents)).not.toContain(SECRET)
    const telemetrySinks = {
      signatures: captured.signatures,
      steps: captured.stepInputs,
      memory: captured.memoryObservations,
      patterns: trackToolPatternFn.mock.calls,
      progress: captured.progressTurns,
      events: stepEvents,
      rendererEvents: sender.send.mock.calls,
      tick: tick.mock.calls,
    }
    expect(stringify(telemetrySinks)).not.toContain(SECRET)
    expect(stringify(telemetrySinks)).not.toContain('textDigest')
    expect(captured.signatures.every(item => item.id.startsWith('computer-call-'))).toBe(true)
    expect(captured.signatures.every(item => item.thoughtSignature === undefined)).toBe(true)
    expect(saveCheckpoint).toHaveBeenCalled()
    const checkpointJson = stringify(saveCheckpoint.mock.calls)
    expect(checkpointJson).not.toContain(SECRET)
    expect(checkpointJson).not.toContain('textDigest')
    expect(checkpointJson).not.toContain('ephemeralTextTag')
    expect(checkpointJson).not.toContain('ephemeralElementTag')
    expect(checkpointJson).not.toContain('ephemeralObservationTag')
    expect(persistUsage).toHaveBeenCalledWith(expect.objectContaining({
      systemPromptHash: usageHash(COMPUTER_CONTEXT_OMITTED),
    }))
    expect(stringify({
      journal: recordJournal.mock.calls,
      memory: saveMemory.mock.calls,
      events: appendEvent.mock.calls,
      finish: finish.mock.calls,
    })).not.toContain(SECRET)
  })

  it('replaces provider event and thrown errors before renderer and runtime sinks', async () => {
    const { createFileTools } = await import('../../../electron/ai/tools')
    const { runApiConversation } = await import('../../../electron/ai/runner-api')
    const runProvider = async (provider: ChatProvider, sendId: number) => {
      const sender = { send: vi.fn(), exec: vi.fn(async () => undefined) }
      const signal = new AbortController().signal
      await runApiConversation({
        sender,
        sendId,
        provider,
        tools: createFileTools(projectPath, signal),
        projectPath,
        initialMessages: [
          { role: 'system', content: COMPUTER_USE_SYSTEM },
          { role: 'user', content: '/computer-use: observe selected window' },
        ],
        signal,
        recordWrite: vi.fn(),
        recordPlan: vi.fn(() => ({ id: 1 })),
        recordJournal: vi.fn(),
        readJournal: vi.fn(() => []),
        saveMemory: vi.fn(() => ({ id: 'memory-provider-error' })),
        invalidateMemory: vi.fn(),
        saveDecision: vi.fn(() => ({ id: 1 })) as never,
        searchMemories: vi.fn(() => []),
        searchConversations: vi.fn(() => []),
        connectors: { list: () => [], query: async () => ({}) },
        agentMode: 'bypass',
        turnsBudget: 1,
        getSecretForDelegate: () => null,
        providerId: 'deepseek',
        model: 'provider-error-model',
        computerUseAllowedActions: ['observe'],
        computerUseProviderEnvelope: 'fresh-composer-ticket-v1',
      })
      return sender
    }

    const eventProvider: ChatProvider = {
      id: 'event-error-provider',
      name: 'event-error-provider',
      models: ['event-error-model'],
      async *send(): AsyncGenerator<ChatEvent> {
        yield { type: 'error', message: `provider-event-${SECRET}` }
      },
    }
    const eventSender = await runProvider(eventProvider, 75)
    expect(JSON.stringify(eventSender.send.mock.calls)).not.toContain(SECRET)
    expect(JSON.stringify(eventSender.send.mock.calls)).toContain(COMPUTER_PROVIDER_ERROR)

    captured.runtimeErrors.length = 0
    const thrownProvider: ChatProvider = {
      id: 'thrown-error-provider',
      name: 'thrown-error-provider',
      models: ['thrown-error-model'],
      async *send(): AsyncGenerator<ChatEvent> {
        throw new Error(`HTTP 401 provider-thrown-${SECRET}`)
      },
    }
    const thrownSender = await runProvider(thrownProvider, 76)
    expect(JSON.stringify(thrownSender.send.mock.calls)).not.toContain(SECRET)
    expect(captured.runtimeErrors).not.toHaveLength(0)
    expect(captured.runtimeErrors.map(args => String(args[1])).join('\n')).toContain(COMPUTER_PROVIDER_ERROR)
    expect(captured.runtimeErrors.map(args => String(args[1])).join('\n')).not.toContain(SECRET)
  })

  it('disables UserPromptSubmit hooks for Computer Use while ordinary prompts stay unchanged', async () => {
    const { createFileTools } = await import('../../../electron/ai/tools')
    const { runApiConversation } = await import('../../../electron/ai/runner-api')

    const run = async (prompt: string, computerUseAllowedActions?: Array<'observe' | 'type'>) => {
      const signal = new AbortController().signal
      const provider: ChatProvider = {
        id: 'hook-provider',
        name: 'hook-provider',
        models: ['hook-model'],
        async *send(): AsyncGenerator<ChatEvent> {
          yield { type: 'text', text: 'Готово' }
          yield { type: 'done' }
        },
      }
      await runApiConversation({
        sender: { send: vi.fn(), exec: vi.fn(async () => undefined) },
        sendId: computerUseAllowedActions ? 73 : 74,
        provider,
        tools: createFileTools(projectPath, signal),
        projectPath,
        initialMessages: computerUseAllowedActions
          ? [
              { role: 'system', content: COMPUTER_USE_SYSTEM },
              { role: 'user', content: prompt },
            ]
          : [{ role: 'user', content: prompt }],
        signal,
        recordWrite: vi.fn(),
        recordPlan: vi.fn(() => ({ id: 1 })),
        recordJournal: vi.fn(),
        readJournal: vi.fn(() => []),
        saveMemory: vi.fn(() => ({ id: 'memory-hook' })),
        invalidateMemory: vi.fn(),
        saveDecision: vi.fn(() => ({ id: 1 })) as never,
        searchMemories: vi.fn(() => []),
        searchConversations: vi.fn(() => []),
        connectors: { list: () => [], query: async () => ({}) },
        agentMode: 'bypass',
        turnsBudget: 1,
        getSecretForDelegate: key => key === 'hooks_enabled' ? 'true' : null,
        providerId: 'deepseek',
        model: 'hook-model',
        ...(computerUseAllowedActions
          ? { computerUseAllowedActions, computerUseProviderEnvelope: 'fresh-composer-ticket-v1' as const }
          : {}),
      })
    }

    const computerPrompt = `/computer-use: введи ${SECRET} в выбранное окно`
    await run(computerPrompt, ['observe', 'type'])
    const computerHook = captured.hookPayloads.find(item => item.event === 'UserPromptSubmit')
    expect(computerHook).toBeUndefined()
    expect(JSON.stringify(captured.hookPayloads)).not.toContain(SECRET)

    captured.hookPayloads.length = 0
    const ordinaryPrompt = 'Проверь список файлов проекта без Computer Use'
    await run(ordinaryPrompt)
    const ordinaryHook = captured.hookPayloads.find(item => item.event === 'UserPromptSubmit')
    expect(ordinaryHook?.payload.prompt).toBe(ordinaryPrompt)
  })

  it('сохраняет обычную user goal в step telemetry вне Computer Use', async () => {
    const ordinaryGoal = 'Проверь список файлов проекта'
    let turn = 0
    const provider: ChatProvider = {
      id: 'telemetry-provider',
      name: 'telemetry-provider',
      models: ['telemetry-model'],
      async *send(): AsyncGenerator<ChatEvent> {
        turn++
        if (turn === 1) {
          yield { type: 'tool-call', call: { id: 'list-1', name: 'list_files', args: { path: '.' } } }
          yield { type: 'done' }
          return
        }
        yield { type: 'text', text: 'Готово' }
        yield { type: 'done' }
      },
    }
    const appendEvent = vi.fn()
    const { createFileTools } = await import('../../../electron/ai/tools')
    const { runApiConversation } = await import('../../../electron/ai/runner-api')
    const signal = new AbortController().signal

    await runApiConversation({
      sender: { send: vi.fn(), exec: vi.fn(async () => undefined) },
      sendId: 72,
      provider,
      tools: createFileTools(projectPath, signal),
      projectPath,
      initialMessages: [{ role: 'user', content: ordinaryGoal }],
      signal,
      recordWrite: vi.fn(),
      recordPlan: vi.fn(() => ({ id: 1 })),
      recordJournal: vi.fn(),
      readJournal: vi.fn(() => []),
      saveMemory: vi.fn(() => ({ id: 'memory-2' })),
      invalidateMemory: vi.fn(),
      saveDecision: vi.fn(() => ({ id: 1 })) as never,
      searchMemories: vi.fn(() => []),
      searchConversations: vi.fn(() => []),
      connectors: { list: () => [], query: async () => ({}) },
      agentMode: 'bypass',
      turnsBudget: 2,
      getSecretForDelegate: () => null,
      providerId: 'deepseek',
      model: 'telemetry-model',
      agentRuns: {
        finish: vi.fn(),
        appendEvent,
        tick: vi.fn(),
        saveCheckpoint: vi.fn(),
        clearCheckpoint: vi.fn(),
      } as never,
      runId: 'ordinary-telemetry-run',
    })

    expect(captured.stepInputs).toContainEqual(expect.objectContaining({ goal: ordinaryGoal }))
    expect(JSON.stringify(appendEvent.mock.calls)).toContain(ordinaryGoal)
  })
})
