// 2.1.10-G: последний крупный узел ai:send — сборка контекста и промпта — вынесен из
// registerAiIpc в ai-send/{memory-context,system-assembly,provider-options,run-input}.
// Раньше эти ~200 строк жили внутри 800-строчного хендлера и напрямую не проверялись:
// регрессия в приоритете веток системного слоя или в выборе аккаунта ловилась бы только
// глазами на ревью.
//
// Пины ниже фиксируют ровно те правила, ради которых узел и существует:
//  · resume по чекпойнту НЕ пересобирает контекст, но только при совпавшем провайдере;
//  · reviewer-промпт — полная замена, а не наслоение (иначе теряется смысл кросс-ревью);
//  · не-API транспорт получает system-сообщение ТОЛЬКО при скилл-override — recipe без
//    скилла не имеет права его подсунуть (расхождение, найденное при переносе);
//  · recall памяти греется один раз на чат и не блокирует ответ при падении;
//  · credentials и CODEX_HOME берутся из аккаунта попытки, а не из legacy-настроек.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  app: { getPath: () => tmpdir() },
  BrowserWindow: { fromWebContents: () => null },
}))

const prepareSystemContext = vi.fn(async () => ({ system: 'BASE_SYSTEM' }))
vi.mock('../../electron/ai/compose-system', () => ({
  prepareSystemContext: (...args: unknown[]) => prepareSystemContext(...(args as [])),
}))

const { assembleSendSystem } = await import('../../electron/ipc/ai-send/system-assembly')
const { buildSendMemoryContext, resetMemorizedChats } = await import('../../electron/ipc/ai-send/memory-context')
const { buildProviderRuntimeOptions } = await import('../../electron/ipc/ai-send/provider-options')
const { saveRunInputSnapshot } = await import('../../electron/ipc/ai-send/run-input')
const { REVIEWER_SYSTEM_PROMPT } = await import('../../electron/ai/review-prompt')
const { PROVIDERS } = await import('../../electron/ai/registry')

const messages = [{ role: 'user' as const, content: 'почини сборку' }]

const baseInput = {
  messages,
  projectPath: null as string | null,
  providerId: 'claude' as const,
  descriptor: PROVIDERS.claude,
  agentMode: 'ask' as const,
  resumedMessages: null,
  checkpointRun: null,
  skillLayerPrompt: undefined as string | null | undefined,
  skillOverridePrompt: undefined as string | null | undefined,
  useReviewerPrompt: false,
  memories: [],
  consolidationHint: null,
  coreMemory: { memory: '', user: '' },
  intensitySystemHint: '<intensity>turbo</intensity>',
  deps: { getSecret: () => null, recentWrites: () => [] },
}

beforeEach(() => {
  prepareSystemContext.mockClear()
})

describe('assembleSendSystem — приоритет веток системного слоя', () => {
  it('resume того же провайдера подаёт историю чекпойнта как есть, без пере-сборки', async () => {
    const resumed = [{ role: 'system' as const, content: 'OLD' }, { role: 'user' as const, content: 'ранее' }]
    const r = await assembleSendSystem({
      ...baseInput,
      resumedMessages: resumed,
      checkpointRun: { providerId: 'claude' },
    })
    expect(r.messagesWithSystem).toBe(resumed)
    expect(r.composedSystem).toBeNull()
    expect(prepareSystemContext).not.toHaveBeenCalled()
  })

  it('resume ДРУГОГО провайдера не реплеит историю — свежая сборка (формат tool_use не переносится)', async () => {
    const resumed = [{ role: 'system' as const, content: 'OLD' }]
    const r = await assembleSendSystem({
      ...baseInput,
      resumedMessages: resumed,
      checkpointRun: { providerId: 'openai' },
    })
    expect(r.messagesWithSystem).not.toBe(resumed)
    expect(prepareSystemContext).toHaveBeenCalledOnce()
  })

  it('reviewer-промпт ПОЛНОСТЬЮ заменяет системный слой и не тянет контекст проекта', async () => {
    const r = await assembleSendSystem({ ...baseInput, useReviewerPrompt: true, projectPath: tmpdir() })
    expect(r.messagesWithSystem[0]).toEqual({ role: 'system', content: REVIEWER_SYSTEM_PROMPT })
    expect(r.composedSystem).toBeNull()
    expect(r.brain).toBeNull()
    expect(prepareSystemContext).not.toHaveBeenCalled()
  })

  it('API-путь наслаивает интенсивность поверх собранного промпта', async () => {
    const r = await assembleSendSystem(baseInput)
    expect(r.composedSystem).toBe('BASE_SYSTEM\n\n<intensity>turbo</intensity>')
    expect(r.messagesWithSystem[0].role).toBe('system')
    expect(r.messagesWithSystem.slice(1)).toEqual(messages)
  })

  // ЗАДАЧА B (штаб): «первый файл правил выигрывает — МОЛЧА». Проброс из
  // meta.userLayerIgnored (loadUserLayer) через composeSystemPrompt в assembled →
  // прогон эмитит предупреждение. Здесь фиксируем сам проброс до ruleConflictWarning.
  it('API-путь: два файла правил в проекте → ruleConflictWarning с обоими именами', async () => {
    prepareSystemContext.mockResolvedValueOnce({
      system: 'BASE_SYSTEM',
      meta: { userLayerPath: 'AGENTS.md', userLayerIgnored: ['CLAUDE.md'] },
    } as never)
    const r = await assembleSendSystem(baseInput)
    expect(r.ruleConflictWarning).not.toBeNull()
    const text = `${r.ruleConflictWarning!.title} ${r.ruleConflictWarning!.detail}`
    expect(text).toContain('AGENTS.md')
    expect(text).toContain('CLAUDE.md')
  })

  it('API-путь: один файл правил → ruleConflictWarning null (ТИШИНА)', async () => {
    prepareSystemContext.mockResolvedValueOnce({
      system: 'BASE_SYSTEM',
      meta: { userLayerPath: 'AGENTS.md', userLayerIgnored: [] },
    } as never)
    const r = await assembleSendSystem(baseInput)
    expect(r.ruleConflictWarning).toBeNull()
  })

  it('use_project_brain=false — Мозг не запрашивается', async () => {
    const getBrainContext = vi.fn(() => ({ content: 'PACK', packType: 'task' }))
    const r = await assembleSendSystem({
      ...baseInput,
      projectPath: tmpdir(),
      deps: { getSecret: (k: string) => (k === 'use_project_brain' ? 'false' : null), recentWrites: () => [], getBrainContext },
    })
    expect(getBrainContext).not.toHaveBeenCalled()
    expect(r.brain).toBeNull()
  })

  // Расхождение, найденное при переносе: условие не-API ветки стоит на СЫРОМ
  // overrides.systemPrompt. applyRecipeToSkillPrompt возвращает протокол даже когда
  // скилл-промпта нет, поэтому условие на его результате подсунуло бы CLI-провайдеру
  // system-сообщение, которого в исходном коде не было. Мутация условия → красный.
  it('CLI + recipe БЕЗ скилл-промпта не получает system-сообщение', async () => {
    const r = await assembleSendSystem({
      ...baseInput,
      providerId: 'claude-cli',
      descriptor: PROVIDERS['claude-cli'],
      skillLayerPrompt: '<recipe_protocol>шаги</recipe_protocol>',
      skillOverridePrompt: undefined,
    })
    expect(r.messagesWithSystem).toBe(messages)
    expect(r.messagesWithSystem[0].role).toBe('user')
  })

  it('CLI со скилл-override получает system с наслоённым recipe', async () => {
    const r = await assembleSendSystem({
      ...baseInput,
      providerId: 'claude-cli',
      descriptor: PROVIDERS['claude-cli'],
      skillLayerPrompt: 'SKILL\n\nPROTOCOL',
      skillOverridePrompt: 'SKILL',
    })
    expect(r.messagesWithSystem[0]).toEqual({ role: 'system', content: 'SKILL\n\nPROTOCOL' })
  })
})

describe('buildSendMemoryContext — recall памяти проекта', () => {
  const noopProgress = () => {}
  const deps = { searchMemories: () => [] }

  beforeEach(() => {
    resetMemorizedChats()
  })

  it('без projectPath память не трогается и ни одного события не уходит', () => {
    const emitProgress = vi.fn()
    const r = buildSendMemoryContext({
      projectPath: null, chatId: '1', messages, deps, sendId: 1, runId: 'r1', emitProgress,
    })
    expect(emitProgress).not.toHaveBeenCalled()
    expect(r).toEqual({ memories: [], consolidationHint: null, coreMemory: { memory: '', user: '' } })
  })

  it('recall греется один раз на чат: второй send того же чата уже не ищет', () => {
    const searchMemories = vi.fn(() => [])
    const args = { projectPath: tmpdir(), chatId: '7', messages, deps: { searchMemories }, sendId: 1, runId: 'r1', emitProgress: noopProgress }
    buildSendMemoryContext(args)
    const afterFirst = searchMemories.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)
    buildSendMemoryContext({ ...args, sendId: 2, runId: 'r2' })
    expect(searchMemories.mock.calls.length).toBe(afterFirst)
  })

  it('падение поиска не роняет прогон — сообщаем и продолжаем без памяти', () => {
    const emitProgress = vi.fn()
    const r = buildSendMemoryContext({
      projectPath: tmpdir(),
      chatId: '9',
      messages,
      deps: { searchMemories: () => { throw new Error('db locked') } },
      sendId: 1,
      runId: 'r1',
      emitProgress,
    })
    expect(r.memories).toEqual([])
    const last = emitProgress.mock.calls.at(-1)?.[0]
    expect(last?.title).toBe('Память проекта недоступна')
    expect(last?.status).toBe('done')
  })
})

describe('buildProviderRuntimeOptions — секреты берутся из аккаунта попытки', () => {
  const account = { secret: 'ACCOUNT_TOKEN', configDir: 'C:/codex-home-b', label: 'B' }

  it('claude-cli: токен аккаунта прогона бьёт legacy-настройку', () => {
    const r = buildProviderRuntimeOptions({
      providerId: 'claude-cli',
      account: account as never,
      getSecret: () => 'LEGACY_TOKEN',
    })
    expect(r.claudeOauthToken).toBe('ACCOUNT_TOKEN')
  })

  it('claude-cli без парка аккаунтов падает на legacy-токен настроек', () => {
    const r = buildProviderRuntimeOptions({
      providerId: 'claude-cli',
      account: null,
      getSecret: (k: string) => (k === 'claude_code_oauth_token' ? 'LEGACY_TOKEN' : null),
    })
    expect(r.claudeOauthToken).toBe('LEGACY_TOKEN')
  })

  it('codex-cli изолируется CODEX_HOME аккаунта прогона', () => {
    const r = buildProviderRuntimeOptions({
      providerId: 'codex-cli',
      account: account as never,
      getSecret: () => null,
    })
    expect(r.codexHome).toBe('C:/codex-home-b')
  })

  it('не-Codex провайдер CODEX_HOME не получает', () => {
    const r = buildProviderRuntimeOptions({ providerId: 'openai', account: account as never, getSecret: () => null })
    expect(r.codexHome).toBeNull()
  })

  it('custom-openai парсит список моделей и отбрасывает пустые', () => {
    const r = buildProviderRuntimeOptions({
      providerId: 'custom-openai',
      account: null,
      getSecret: (k: string) => k === 'custom_openai_models' ? 'a, b , ,c' : (k === 'custom_openai_baseurl' ? 'http://local' : null),
    })
    expect(r.customModels).toEqual(['a', 'b', 'c'])
    expect(r.customBaseUrl).toBe('http://local')
  })

  it('TLS-верификация GigaChat включается строго значением true', () => {
    const on = buildProviderRuntimeOptions({ providerId: 'gigachat', account: null, getSecret: () => 'true' })
    const off = buildProviderRuntimeOptions({ providerId: 'gigachat', account: null, getSecret: () => '1' })
    expect(on.gigachatTlsVerify).toBe(true)
    expect(off.gigachatTlsVerify).toBe(false)
  })

  it('гейт живого каталога заводится только для grok-cli', () => {
    expect(buildProviderRuntimeOptions({ providerId: 'grok-cli', account: null, getSecret: () => null }).checkModel).toBeTypeOf('function')
    expect(buildProviderRuntimeOptions({ providerId: 'claude', account: null, getSecret: () => null }).checkModel).toBeUndefined()
  })
})

describe('saveRunInputSnapshot — снапшот Debug Packet не критичен', () => {
  const common = {
    runId: 'r1', projectPath: null, chatId: null, providerId: 'claude' as const, model: 'sonnet', messages,
  }

  it('берёт последнее user-сообщение истории', () => {
    const save = vi.fn()
    saveRunInputSnapshot({
      ...common,
      save,
      systemPrompt: 'SYS',
      messages: [{ role: 'user', content: 'первое' }, { role: 'assistant', content: 'ответ' }, { role: 'user', content: 'последнее' }],
    })
    expect(save.mock.calls[0][0].userMessage).toBe('последнее')
    expect(save.mock.calls[0][0].systemPrompt).toBe('SYS')
  })

  it('без saveRunInput — тихий no-op', () => {
    expect(() => saveRunInputSnapshot({ ...common, save: undefined, systemPrompt: 'SYS' })).not.toThrow()
  })

  it('исключение внутри записи не уходит в прогон', () => {
    const save = () => { throw new Error('disk full') }
    expect(() => saveRunInputSnapshot({ ...common, save, systemPrompt: 'SYS' })).not.toThrow()
  })
})
