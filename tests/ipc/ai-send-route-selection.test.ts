// 2.1.10-E: маршрут ai:send (провайдер + модель + smart-routing) вынесен из
// registerAiIpc в ai-send/route-selection.ts. Раньше эта лестница приоритетов жила
// одним выражением внутри 1000-строчного хендлера и напрямую не проверялась —
// регрессия в порядке источников ловилась бы только глазами на ревью.
//
// Пины здесь фиксируют ровно те правила, ради которых лестница и существует:
//  · one-shot promptRoute бьёт всё (пользователь выбрал модель осознанно);
//  · сохранённый route чекпойнта применяется при resume — но модель только если
//    провайдер совпал (иначе молча уехали бы на дефолт чата);
//  · удалённый провайдер из чекпойнта не роняет прогон (гард isKnownProviderId);
//  · smart-routing молчит, когда выбор сделан руками или транспорт не API.
import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  app: { getPath: () => tmpdir() },
  BrowserWindow: { fromWebContents: () => null },
}))

const { selectSendProvider, selectSendModel, decideSmartRouting } = await import('../../electron/ipc/ai-send/route-selection')
const { PROVIDERS } = await import('../../electron/ai/registry')

const chatDefault = () => 'gemini-api' as const
const noCheckpoint = null

describe('selectSendProvider — лестница источников провайдера', () => {
  it('one-shot promptRoute бьёт override, чекпойнт, выбор в UI и дефолт чата', () => {
    const r = selectSendProvider({
      promptRoute: { providerId: 'openai', model: 'gpt-5', fallbackPolicy: 'strict' },
      overrideProviderId: 'grok',
      overrideSelectedProviderId: 'claude',
      checkpointRun: { requestedProviderId: 'yandex-gpt' },
      getProviderId: chatDefault,
    })
    expect(r.providerId).toBe('openai')
    expect(r.descriptor).toBe(PROVIDERS.openai)
  })

  it('override ревьюера бьёт чекпойнт и дефолт (Explicit Review — другой провайдер)', () => {
    const r = selectSendProvider({
      promptRoute: null,
      overrideProviderId: 'grok',
      checkpointRun: { requestedProviderId: 'yandex-gpt' },
      getProviderId: chatDefault,
    })
    expect(r.providerId).toBe('grok')
  })

  it('resume берёт сохранённый route прогона, а не дефолт чата', () => {
    const r = selectSendProvider({
      promptRoute: null,
      checkpointRun: { requestedProviderId: 'claude' },
      getProviderId: chatDefault,
    })
    expect(r.providerId).toBe('claude')
    expect(r.resumedProviderId).toBe('claude')
  })

  it('провайдер чекпойнта удалён из сборки → падаем на дефолт, а не на undefined-дескриптор', () => {
    const r = selectSendProvider({
      promptRoute: null,
      checkpointRun: { requestedProviderId: 'provider-which-no-longer-exists' },
      getProviderId: chatDefault,
    })
    expect(r.providerId).toBe('gemini-api')
    expect(r.resumedProviderId).toBeNull()
    expect(r.descriptor).toBeTruthy()
  })

  it('нет ничего — дефолт чата', () => {
    const r = selectSendProvider({ promptRoute: null, checkpointRun: noCheckpoint, getProviderId: chatDefault })
    expect(r.providerId).toBe('gemini-api')
  })
})

describe('selectSendModel — лестница источников модели', () => {
  const claude = PROVIDERS.claude

  it('promptRoute.model бьёт сохранённую и дефолтную', () => {
    const model = selectSendModel({
      promptRoute: { providerId: 'claude', model: claude.models![1], fallbackPolicy: 'strict' },
      overrideSelectedModel: claude.models![0],
      providerId: 'claude',
      resumedProviderId: 'claude',
      checkpointRun: { requestedModel: claude.models![0] },
      descriptor: claude,
      getProviderModel: () => claude.models![0],
    })
    expect(model).toBe(claude.models![1])
  })

  it('resume ТОГО ЖЕ провайдера применяет сохранённую модель прогона', () => {
    const model = selectSendModel({
      promptRoute: null,
      providerId: 'claude',
      resumedProviderId: 'claude',
      checkpointRun: { requestedModel: claude.models![1] },
      descriptor: claude,
      getProviderModel: () => claude.models![0],
    })
    expect(model).toBe(claude.models![1])
  })

  it('resume ДРУГОГО провайдера сохранённую модель НЕ применяет — берётся модель чата', () => {
    const model = selectSendModel({
      promptRoute: null,
      providerId: 'claude',
      resumedProviderId: 'openai',
      checkpointRun: { requestedModel: 'gpt-5' },
      descriptor: claude,
      getProviderModel: () => claude.models![0],
    })
    expect(model).toBe(claude.models![0])
  })

  it('чужая/неизвестная модель нормализуется в дефолт дескриптора', () => {
    const model = selectSendModel({
      promptRoute: null,
      providerId: 'claude',
      resumedProviderId: null,
      checkpointRun: noCheckpoint,
      descriptor: claude,
      getProviderModel: () => 'model-from-another-provider',
    })
    expect(model).toBe(claude.defaultModel)
  })
})

describe('decideSmartRouting — когда автоподбор молчит', () => {
  const base = {
    enabled: true,
    effortLevel: 'standard' as const,
    descriptor: PROVIDERS.claude,
    providerId: 'claude' as const,
    model: PROVIDERS.claude.defaultModel,
    messages: [{ role: 'user' as const, content: 'привет' }],
  }

  it('выключен настройкой — решения нет', () => {
    expect(decideSmartRouting({ ...base, enabled: false })).toBeNull()
  })

  it('модель выбрана руками (override/selected) — не переопределяем', () => {
    expect(decideSmartRouting({ ...base, overrideModel: 'claude-opus-4-1' })).toBeNull()
    expect(decideSmartRouting({ ...base, overrideSelectedModel: 'claude-opus-4-1' })).toBeNull()
  })

  it('Explicit Review (override провайдера) — не вмешиваемся', () => {
    expect(decideSmartRouting({ ...base, overrideProviderId: 'openai' })).toBeNull()
  })

  it('не-standard усилие — не вмешиваемся', () => {
    expect(decideSmartRouting({ ...base, effortLevel: 'deep' })).toBeNull()
    expect(decideSmartRouting({ ...base, effortLevel: 'quick' })).toBeNull()
  })

  it('не-API транспорт — не вмешиваемся (CLI сам выбирает модель)', () => {
    expect(decideSmartRouting({
      ...base, descriptor: PROVIDERS['claude-cli'], providerId: 'claude-cli', model: 'auto',
    })).toBeNull()
  })

  it('когда подбор срабатывает — несёт и новую, и прежнюю модель (иначе лог/событие врут)', () => {
    const pick = decideSmartRouting(base)
    expect(pick).toBeTruthy()
    expect(pick!.previousModel).toBe(base.model)   // sonnet — дефолт чата
    expect(pick!.model).toBe('claude-haiku-4-5')   // простой запрос уводится на дешёвую
    expect(pick!.complexity).toBe('Simple task')
  })
})
