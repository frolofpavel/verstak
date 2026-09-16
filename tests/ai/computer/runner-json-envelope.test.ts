import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, ChatMessage, ChatProvider } from '../../../electron/ai/types'

vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  app: { getPath: () => tmpdir() },
}))

const { runApiConversation } = await import('../../../electron/ai/runner-api')
const { createFileTools } = await import('../../../electron/ai/tools')

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'verstak-computer-json-envelope-'))
  tempRoots.push(root)
  return root
}

function makeProvider(calls: ChatMessage[][]): ChatProvider {
  return {
    id: 'ollama',
    name: 'Ollama',
    models: ['qwen3'],
    async *send(messages): AsyncGenerator<ChatEvent> {
      calls.push(messages.map(message => ({ ...message })))
      yield { type: 'text', text: 'Нужно уточнение.' }
      yield { type: 'done' }
    },
  }
}

function makeContext(input: {
  messages: ChatMessage[]
  calls: ChatMessage[][]
  computerUseAllowedActions?: string[]
  computerUseProviderEnvelope?: 'fresh-composer-ticket-v1'
}) {
  const root = makeRoot()
  const signal = new AbortController().signal
  return {
    sender: { send: vi.fn(), exec: vi.fn(async () => undefined) },
    sendId: 401,
    provider: makeProvider(input.calls),
    tools: createFileTools(root, signal),
    projectPath: root,
    initialMessages: input.messages,
    signal,
    recordWrite: vi.fn(),
    recordPlan: vi.fn(() => ({ id: 1 })),
    recordJournal: vi.fn(),
    readJournal: vi.fn(() => []),
    saveMemory: vi.fn(() => ({ id: 'memory-1' })),
    saveDecision: vi.fn(() => ({ id: 1 })),
    invalidateMemory: vi.fn(),
    searchMemories: vi.fn(() => []),
    searchConversations: vi.fn(() => []),
    connectors: { list: () => [], query: async () => ({}) },
    agentMode: 'bypass',
    turnsBudget: 3,
    skillRegistry: undefined,
    getSecretForDelegate: () => null,
    providerId: 'ollama',
    model: 'qwen3',
    toolsAllow: null,
    computerUseAllowedActions: input.computerUseAllowedActions,
    computerUseProviderEnvelope: input.computerUseProviderEnvelope,
  } as unknown as Parameters<typeof runApiConversation>[0]
}

const COMPUTER_SYSTEM = '<verstak_computer_use_envelope marker="VERSTAK_COMPUTER_USE_ENVELOPE_V1">trusted</verstak_computer_use_envelope>'
const EXACT_USER = '/computer-use наблюдай выбранное окно'

describe('Computer Use JSON provider envelope', () => {
  it('Ollama получает ровно immutable Computer system + exact user, а JSON-протокол слит в system', async () => {
    const calls: ChatMessage[][] = []

    await runApiConversation(makeContext({
      calls,
      messages: [
        { role: 'system', content: COMPUTER_SYSTEM },
        { role: 'user', content: EXACT_USER },
      ],
      computerUseAllowedActions: ['observe'],
      computerUseProviderEnvelope: 'fresh-composer-ticket-v1',
    }))

    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(2)
    expect(calls[0].map(message => message.role)).toEqual(['system', 'user'])
    expect(calls[0][0]?.content).toContain('VERSTAK_COMPUTER_USE_ENVELOPE_V1')
    expect(calls[0][0]?.content).toContain('<!-- tool_mode:json -->')
    expect(calls[0][1]?.content).toBe(EXACT_USER)
  })

  it('обычный Ollama-прогон сохраняет отдельную JSON system-инструкцию', async () => {
    const calls: ChatMessage[][] = []

    await runApiConversation(makeContext({
      calls,
      messages: [
        { role: 'system', content: 'ordinary system' },
        { role: 'user', content: 'обычная задача' },
      ],
    }))

    expect(calls).toHaveLength(1)
    expect(calls[0].map(message => message.role)).toEqual(['system', 'system', 'user'])
    expect(calls[0][0]?.content).toBe('ordinary system')
    expect(calls[0][1]?.content).toContain('<!-- tool_mode:json -->')
  })

  it('active Computer без fresh-composer provenance останавливается до provider.send', async () => {
    const calls: ChatMessage[][] = []

    await runApiConversation(makeContext({
      calls,
      messages: [
        { role: 'system', content: COMPUTER_SYSTEM },
        { role: 'user', content: EXACT_USER },
      ],
      computerUseAllowedActions: ['observe'],
    }))

    expect(calls).toEqual([])
  })

  it('fresh provenance не разрешает Computer envelope с третьим сообщением', async () => {
    const calls: ChatMessage[][] = []

    await runApiConversation(makeContext({
      calls,
      messages: [
        { role: 'system', content: COMPUTER_SYSTEM },
        { role: 'system', content: 'POISON_SECOND_SYSTEM' },
        { role: 'user', content: EXACT_USER },
      ],
      computerUseAllowedActions: ['observe'],
      computerUseProviderEnvelope: 'fresh-composer-ticket-v1',
    }))

    expect(calls).toEqual([])
  })
})
