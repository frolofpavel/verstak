// ДЕФЕКТ 2 ЖИВОЙ ПРОВЕРКИ — РАЗРЫВ МЕЖДУ ПИНОМ И ПРОДУКТОМ (29.07, четвёртый заход).
//
// Пин `plan-generate-cli-provider` утверждает: провайдер без Base URL не остаётся
// активным, происходит фолбэк. Пин зелёный. А в продукте при активном «Своём
// провайдере» по-прежнему «Custom OpenAI-compatible: укажи Base URL».
//
// ПРИЧИНА РАЗРЫВА. Пин проверяет ПРЕДИКАТ ГОТОВНОСТИ в изоляции, а реальный путь
// идёт дальше и ломается ПОСЛЕ него: `runScheduledHeadless` собирает провайдера
// своим, урезанным набором опций — только `apiKey`/`model`/`cwd`/`codexHome`. Он
// написан под расписанные прогоны, где провайдеру достаточно ключа. Провайдерам,
// у которых есть ВТОРОЕ обязательное поле (custom-openai → Base URL, yandex-gpt →
// folder id, gigachat → client secret), это поле не передаётся вовсе. Поэтому
// НАСТРОЕННЫЙ custom-openai проходит предикат готовности — и падает на создании
// провайдера, будто он не настроен.
//
// `ai:send` этой болезнью не болеет: он собирает опции общим билдером
// `buildProviderRuntimeOptions`. Второго набора опций быть не должно.
//
// Тест идёт ТЕМ ЖЕ путём, которым идёт кнопка «Сгенерировать план»: настоящий
// `runScheduledHeadless`. Сигнал оборван заранее — до сети дело не доходит, а
// создание провайдера (где и живёт дефект) происходит ДО первого раунда цикла.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { getPath: () => tmpdir() } }))

const { runScheduledHeadless } = await import('../../electron/ipc/ai')

let dir: string

/** Настройки человека: ключ задан И адрес задан — провайдер полностью настроен. */
const CONFIGURED: Record<string, string> = {
  custom_openai_api_key: 'sk-test',
  custom_openai_baseurl: 'https://llm.example.com/v1',
  custom_openai_models: 'claude-opus-test',
  yandex_api_key: 'ya-test',
  yandex_folder_id: 'folder-123',
  gigachat_client_id: 'giga-id',
  gigachat_client_secret: 'giga-secret',
}

function deps() {
  return {
    getKnownRoots: () => [dir],
    getSecret: (k: string) => CONFIGURED[k] ?? null,
    recentWrites: () => [],
    recordWrite: () => {}, recordPlan: () => ({ id: 1 }), recordJournal: () => {},
    readJournal: () => [], saveMemory: () => {}, saveDecision: () => {},
    searchMemories: () => [], searchConversations: () => [],
    connectors: [], skillRegistry: null, plans: null, getPlan: () => null,
    mcpClient: null, agentJobs: null, agentJobScheduler: null,
  } as never
}

/** Прогон, каким его запускает кнопка «Сгенерировать план» (main.ts). */
async function runAsGenerator(providerId: string) {
  const aborted = new AbortController()
  aborted.abort()
  return runScheduledHeadless(deps(), {
    projectPath: dir,
    prompt: 'Составь план работы.',
    providerId: providerId as never,
    model: null,
    signal: aborted.signal,
    sendId: -1000,
    agentMode: 'plan',
    allowedTools: ['read_file', 'create_plan'],
    role: 'plan-generation',
    maxIterations: 24,
  })
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-provider-opts-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('прогон генерации получает ВСЕ опции настроенного провайдера', () => {
  it('НАСТРОЕННЫЙ custom-openai не падает на «укажи Base URL»', async () => {
    const res = await runAsGenerator('custom-openai')

    expect(
      res.error ?? '',
      'адрес задан в настройках, но до создания провайдера не доехал — предикат готовности говорит одно, прогон делает другое',
    ).not.toContain('Base URL')
  })

  it('НАСТРОЕННЫЙ yandex-gpt не падает на отсутствии folder id', async () => {
    const res = await runAsGenerator('yandex-gpt')
    expect((res.error ?? '').toLowerCase()).not.toContain('folder')
  })

  it('НАСТРОЕННЫЙ gigachat не падает на отсутствии client secret', async () => {
    const res = await runAsGenerator('gigachat')
    expect((res.error ?? '').toLowerCase()).not.toContain('secret')
  })

  // КОНТРОЛЬ ЗАГОТОВКИ: без него зелёное могло бы означать «прогон вообще не
  // доходит до создания провайдера». Провайдер без ключа обязан дать СВОЙ отказ.
  it('контроль: без ключа прогон честно отказывает ещё до провайдера', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const res = await runScheduledHeadless({ ...(deps() as object), getSecret: () => null } as never, {
      projectPath: dir, prompt: 'x', providerId: 'custom-openai' as never,
      model: null, signal: aborted.signal,
    })
    expect(res.ok).toBe(false)
    expect(res.error ?? '').toContain('Нет API-ключа')
  })

  // КОНТРОЛЬ ВТОРОЙ СТОРОНЫ: обычный провайдер с одним ключом по-прежнему создаётся.
  it('контроль: провайдер с одним лишь ключом работает как прежде', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const res = await runScheduledHeadless(
      { ...(deps() as object), getSecret: (k: string) => (k === 'anthropic_api_key' ? 'sk-a' : null) } as never,
      { projectPath: dir, prompt: 'x', providerId: 'claude' as never, model: null, signal: aborted.signal },
    )
    expect(res.error ?? '', 'сломали обычный путь').not.toContain('not set')
  })
})
