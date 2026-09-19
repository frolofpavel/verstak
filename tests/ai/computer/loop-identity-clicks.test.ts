/**
 * Живой путь Computer Use: детектор зацикливания и РАЗНЫЕ клики.
 *
 * ЧТО БЫЛО СЛОМАНО (живая приёмка 19.09, «125 × 47» в Калькуляторе). Подпись
 * вызова для детектора строится из ПРОЕКЦИИ аргументов (`tool-telemetry`), а она
 * ради приватности сводит `computer_click` к `{hasObservationId, hasElementRef}`
 * — без самих значений. Значит подпись клика по «1», по «2» и по «5» одна и та
 * же, счётчик доходит до LOOP_THRESHOLD на ТРЕТЬЕМ клике прогона, каким бы он ни
 * был. На экране это выглядело как «12»: две цифры введены, третья заблокирована.
 *
 * Тот же класс дефекта уже чинили для безаргументных вызовов (`loop-detect.ts`,
 * Д4): подпись вырождается в константу и детектор блокирует работу, а не цикл.
 *
 * ПОРЯДОК ПРОВЕРКИ. Ниже пара: клики по РАЗНЫМ элементам обязаны исполниться все
 * три, клики по ОДНОМУ И ТОМУ ЖЕ элементу в одном наблюдении обязаны быть
 * заблокированы. Без второго кейса первый ничего не измеряет (§3.1).
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, ChatProvider, ToolCall } from '../../../electron/ai/types'
import type { ToolContext } from '../../../electron/ipc/tool-handlers'

const COMPUTER_USE_SYSTEM = '<verstak_computer_use_envelope marker="VERSTAK_COMPUTER_USE_ENVELOPE_V1">trusted</verstak_computer_use_envelope>'

const captured = vi.hoisted(() => ({
  clicks: [] as Array<{ observationId: unknown; elementRef: unknown }>,
}))

vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { getPath: () => tmpdir() } }))

vi.mock('../../../electron/ipc/tool-handlers', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../electron/ipc/tool-handlers')>()
  return {
    ...actual,
    lookupHandler: (name: string, context?: ToolContext) => name === 'computer_click'
      ? {
          mode: 'sequential' as const,
          handle: async (call: ToolCall) => {
            captured.clicks.push({
              observationId: call.args.observationId,
              elementRef: call.args.elementRef,
            })
            return {
              id: call.id,
              name: call.name,
              result: {
                actionId: `opaque-action-${captured.clicks.length}`,
                status: 'verified',
                observation: {
                  observationId: 'observation-1',
                  observationVersion: 1,
                  text: 'Калькулятор',
                  elements: [],
                  omissions: [],
                },
              },
            }
          },
        }
      : actual.lookupHandler(name, context),
  }
})

/** Провайдер, выдающий по одному клику за ход, затем финальный текст. */
function clickingProvider(refs: readonly string[], observationId = 'observation-1'): ChatProvider {
  let turn = 0
  return {
    id: 'loop-identity-provider',
    name: 'loop-identity-provider',
    models: ['loop-identity-model'],
    async *send(): AsyncGenerator<ChatEvent> {
      const ref = refs[turn]
      turn++
      if (ref !== undefined) {
        yield {
          type: 'tool-call',
          call: { id: `click-${turn}`, name: 'computer_click', args: { observationId, elementRef: ref } },
        }
        yield { type: 'done' }
        return
      }
      yield { type: 'text', text: 'Готово' }
      yield { type: 'done' }
    },
  }
}

describe('детектор зацикливания различает клики по разным элементам', () => {
  let projectPath: string

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'verstak-loop-identity-'))
    captured.clicks.length = 0
  })

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true })
  })

  const run = async (provider: ChatProvider, sendId: number) => {
    const sender = { send: vi.fn(), exec: vi.fn(async () => undefined) }
    const signal = new AbortController().signal
    const { createFileTools } = await import('../../../electron/ai/tools')
    const { runApiConversation } = await import('../../../electron/ai/runner-api')
    await runApiConversation({
      sender,
      sendId,
      provider,
      tools: createFileTools(projectPath, signal),
      projectPath,
      initialMessages: [
        { role: 'system', content: COMPUTER_USE_SYSTEM },
        { role: 'user', content: '/computer-use: посчитай 125 × 47' },
      ],
      signal,
      recordWrite: vi.fn(),
      recordPlan: vi.fn(() => ({ id: 1 })),
      recordJournal: vi.fn(),
      readJournal: vi.fn(() => []),
      saveMemory: vi.fn(() => ({ id: 'memory-loop-identity' })),
      invalidateMemory: vi.fn(),
      saveDecision: vi.fn(() => ({ id: 1 })) as never,
      searchMemories: vi.fn(() => []),
      searchConversations: vi.fn(() => []),
      connectors: { list: () => [], query: async () => ({}) },
      agentMode: 'bypass',
      turnsBudget: 6,
      getSecretForDelegate: () => null,
      providerId: 'deepseek',
      model: 'loop-identity-model',
      computerUseAllowedActions: ['observe', 'click'],
      computerUseProviderEnvelope: 'fresh-composer-ticket-v1',
    })
    const blocked = sender.send.mock.calls
      .map(args => (args[1] as { event?: { type?: string; reason?: string } } | undefined)?.event)
      .filter((event): event is { type: string; reason?: string } => event?.type === 'tool-blocked')
    return { blocked }
  }

  it('три клика по РАЗНЫМ кнопкам исполняются все — детектор их не путает', async () => {
    const { blocked } = await run(clickingProvider(['digit-1', 'digit-2', 'digit-5']), 91)

    expect(captured.clicks.map(item => item.elementRef)).toEqual(['digit-1', 'digit-2', 'digit-5'])
    expect(blocked).toEqual([])
  })

  it('три клика по ОДНОЙ кнопке в одном наблюдении блокируются — цикл ловится по-прежнему', async () => {
    const { blocked } = await run(clickingProvider(['digit-1', 'digit-1', 'digit-1']), 92)

    expect(captured.clicks.map(item => item.elementRef)).toEqual(['digit-1', 'digit-1'])
    expect(blocked.map(event => event.reason).join('\n')).toContain('Зацикливание')
  })
})
