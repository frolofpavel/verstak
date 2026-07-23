import { describe, it, expect, vi } from 'vitest'
import { runSubAgentLoop } from '../../electron/ai/sub-agent-loop'
import { delegateTaskHandler, buildSubCreateOptions } from '../../electron/ipc/tool-handlers/delegation'
import type { ToolContext } from '../../electron/ipc/tool-handlers'
import type { ChatProvider, ChatEvent, ChatMessage, ToolDefinition } from '../../electron/ai/types'

/**
 * Транспорт Сценария Б гибридного оркестратора: API-агент делегирует тяжёлый
 * терминальный шаг на CLI-провайдера (Claude Code/Codex) через delegate_task.
 *
 * Принципиальное отличие CLI от API: CLI-провайдер крутит СВОЙ tool-loop внутри
 * себя (читает файлы, гоняет команды) и стримит обратно ТОЛЬКО текст + usage +
 * done — он НЕ эмитит tool-call события для Verstak. runSubAgentLoop должен это
 * корректно обработать: собрать текст, увидеть «нет tool-call» → completed, и
 * НЕ пытаться выполнять Verstak-хендлеры (их вызов = баг роутинга).
 *
 * Эти тесты фиксируют, что delegate→CLI работает на уровне цикла (без живого ssh
 * к CLI-бинарю). buildSubCreateOptions(claude-cli) + claude-cli.send(buildCliPrompt)
 * проверяются отдельно — здесь чистая логика sub-agent-loop.
 */

/** Мок CLI-провайдера: стримит только текст + usage + done (как Claude Code). */
function makeCliStyleProvider(chunks: string[], usage?: { inputTokens: number; outputTokens: number }): ChatProvider {
  return {
    id: 'claude-cli',
    name: 'Claude Code',
    models: ['claude-code'],
    async *send(_messages: ChatMessage[], _tools: ToolDefinition[]): AsyncGenerator<ChatEvent> {
      for (const c of chunks) yield { type: 'text', text: c }
      if (usage) yield { type: 'usage', usage }
      yield { type: 'done' }
    }
  }
}

function makeCtx(signal: AbortSignal, extra?: Partial<ToolContext>): ToolContext {
  return {
    sender: { send: vi.fn(), exec: vi.fn() },
    sendId: 1,
    signal,
    projectPath: '/tmp/project',
    tools: {
      execute: vi.fn(async () => 'ok'),
      runCommand: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      classifyCommand: vi.fn(() => ({ allowed: true })) as never
    } as never,
    recordWrite: vi.fn(),
    recordPlan: vi.fn(),
    recordJournal: vi.fn(),
    readJournal: vi.fn(() => []),
    saveMemory: vi.fn(() => ({ id: 'm1' })),
    searchMemories: vi.fn(() => []),
    searchConversations: vi.fn(() => []),
    connectors: { list: () => [], query: async () => ({}) },
    pendingAttachments: [],
    pendingWrites: new Map(),
    pendingCommands: new Map(),
    scopedKey: (sendId: number, callId: string) => `${sendId}::${callId}`,
    agentMode: 'ask',
    ...extra
  } as unknown as ToolContext
}

describe('delegate→CLI: транспорт Сценария Б (sub-agent-loop с CLI-стилем)', () => {
  it('CLI стримит только текст → completed с этим текстом, Verstak-хендлеры НЕ зовутся', async () => {
    const ac = new AbortController()
    const ctx = makeCtx(ac.signal)

    const result = await runSubAgentLoop({
      provider: makeCliStyleProvider(['Исправил типы. ', 'Тесты зелёные.']),
      messages: [
        { role: 'system', content: 'sub' },
        { role: 'user', content: 'почини сборку tsc и запусти тесты' }
      ],
      allowedToolNames: ['read_file', 'write_file', 'run_command'],
      ctx,
      signal: ac.signal,
      role: 'executor'
    })

    expect(result.exitReason).toBe('completed')
    expect(result.text).toBe('Исправил типы. Тесты зелёные.')
    // CLI исполнил всё внутри себя — Verstak ничего не выполнял.
    expect(ctx.tools.execute).not.toHaveBeenCalled()
    expect(ctx.tools.runCommand).not.toHaveBeenCalled()
    expect(result.toolCallCount).toBe(0)
  }, 3000)

  it('usage от CLI учитывается в cost-guard сессии (суб не обходит лимит)', async () => {
    const ac = new AbortController()
    const recordAndCheck = vi.fn(() => ({ exceeded: false }))
    const ctx = makeCtx(ac.signal, {
      subCostGuard: { recordAndCheck } as never,
      subProviderId: 'claude-cli',
      subModel: 'claude-code'
    })

    await runSubAgentLoop({
      provider: makeCliStyleProvider(['ок'], { inputTokens: 1000, outputTokens: 500 }),
      messages: [{ role: 'system', content: 'sub' }, { role: 'user', content: 'собери проект' }],
      allowedToolNames: ['run_command'],
      ctx,
      signal: ac.signal,
      role: 'executor'
    })

    // 2.0.8-E commit 2: cached не сообщён → null (не 0, каветат #1); +6-й арг inputAccounting (undefined).
    expect(recordAndCheck).toHaveBeenCalledWith('claude-cli', 'claude-code', 1000, 500, null, undefined, null)
  }, 3000)

  it('cost-cap превышен на usage CLI → обрыв с error (не даём сжечь больше лимита)', async () => {
    const ac = new AbortController()
    const ctx = makeCtx(ac.signal, {
      subCostGuard: { recordAndCheck: vi.fn(() => ({ exceeded: true, message: 'cost cap exceeded' })) } as never,
      subProviderId: 'claude-cli',
      subModel: 'claude-code'
    })

    const result = await runSubAgentLoop({
      provider: makeCliStyleProvider(['работаю'], { inputTokens: 999999, outputTokens: 999999 }),
      messages: [{ role: 'system', content: 'sub' }, { role: 'user', content: 'рефактор' }],
      allowedToolNames: ['run_command'],
      ctx,
      signal: ac.signal,
      role: 'executor'
    })

    expect(result.exitReason).toBe('error')
    expect(result.error).toMatch(/cost cap/)
  }, 3000)
})


// EF-R1 Б2: delegate_task НЕ обходит единый resolver — заблокированный аккаунт
// останавливает sub-agent ДО сети (человеческая карточка), default credential запрещён.
describe('delegate_task: pre-flight аккаунта (EF-R1 Б2)', () => {
  const call = { id: 'c1', name: 'delegate_task' }

  it('claude-cli аккаунт cooling (blocked) → явный стоп, default env-токен НЕ используется', async () => {
    const ac = new AbortController()
    const ctx = makeCtx(ac.signal, {
      resolveSubscriptionAccount: () => ({ blocked: true, reason: 'cooling', resetAt: null, label: 'Макс A' }),
      getSecretForDelegate: () => 'sk-LEGACY-DEFAULT', // ловушка: не должна понадобиться
    })
    const res = await delegateTaskHandler.handle(
      { ...call, args: { prompt: 'сделай', provider_id: 'claude-cli' } },
      ctx,
    )
    expect(res.error ?? res.result).toContain('Макс A')
    expect(res.error ?? res.result).toMatch(/остывает|остановлено/i)
    expect(JSON.stringify(res)).not.toContain('sk-LEGACY-DEFAULT')
  }, 3000)

  it('claude-cli все аккаунты неготовы (allBlocked) → явный стоп с числом', async () => {
    const ac = new AbortController()
    const ctx = makeCtx(ac.signal, {
      resolveSubscriptionAccount: () => ({ allBlocked: true, reason: 'login-required', resetAt: null, count: 2 }),
    })
    const res = await delegateTaskHandler.handle(
      { ...call, args: { prompt: 'сделай', provider_id: 'claude-cli' } },
      ctx,
    )
    expect(res.error ?? res.result).toMatch(/требуют входа|остановлено/i)
    expect(res.error ?? res.result).toContain('2')
  }, 3000)

  it('парка нет (resolver → null) → прежний legacy env-путь (не стоп)', () => {
    const ac = new AbortController()
    const ctx = makeCtx(ac.signal, {
      resolveSubscriptionAccount: () => null,
      getSecretForDelegate: (k: string) => (k === 'claude_code_oauth_token' ? 'sk-env' : null),
    })
    // Гейт пропускает null → buildSubCreateOptions берёт legacy env-токен и НЕ бросает
    // «Делегирование остановлено». Прямой unit-вызов: e2e через handle() уходит в
    // реальный CLI spawn и не завершается в тестовой среде.
    const opts = buildSubCreateOptions('claude-cli', null, 'claude-sonnet-4', ac.signal, ctx)
    expect(opts.claudeOauthToken).toBe('sk-env')
  })
})
