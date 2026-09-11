// @vitest-environment jsdom
//
// BUG 11.09.2026: Settings подмешивал пользовательские custom-openai модели только
// в собственную страницу. ModelPicker повторно читал providers:list, получал пустой
// статический каталог и показывал одну сохранённую модель вместо всех включённых.
// Заодно выбор «текущей модели в чате» в Settings сохранял только глобальный default,
// но не provider/model уже открытой chat_session.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeApiMock, CHAT_API_DEFAULTS, type ApiMock } from './helpers/window-api-mock'

const { useProject } = await import('../../src/store/projectStore')
const { ModelPicker } = await import('../../src/components/ModelPicker')

const MODELS = ['claude-opus-4-8', 'claude-opus-5', 'gpt-6-astra', 'gpt-5.6-sol']
const PROVIDER = {
  id: 'custom-openai',
  name: 'Свой провайдер (OpenAI-compatible)',
  shortLabel: 'Свой провайдер',
  transport: 'API',
  executionMode: 'native-agent-loop',
  authKind: 'api-key',
  experimental: false,
  catalogSource: 'static',
  secretKey: 'custom_openai_api_key',
  models: [],
  defaultModel: '',
  supportsTools: true,
  capabilities: [],
}

function settingValue(key: string): string | null {
  if (key === 'provider') return 'custom-openai'
  if (key === 'custom_openai_api_key') return 'configured'
  if (key === 'custom_openai_baseurl') return 'https://gateway.example/v1'
  if (key === 'custom_openai_models') return MODELS.join(', ')
  if (key === 'model_custom-openai') return MODELS[0]
  if (key === 'enabled_models') return JSON.stringify(MODELS.map(model => `custom-openai::${model}`))
  if (key === 'app_language') return 'ru'
  return null
}

let mock: ApiMock

beforeEach(() => {
  mock = makeApiMock({
    ...CHAT_API_DEFAULTS,
    providers: { list: async () => [PROVIDER], catalogStatus: async () => null },
    settings: {
      getKey: async (key: string) => settingValue(key),
      envSecretKeys: async () => [],
    },
    subscriptionAccounts: { list: async () => [] },
    cliAuth: { statusAll: async () => ({}) },
    localModels: { scan: async () => [] },
    usage: { summary: async () => null, list: async () => [] },
    userProfiles: { list: async () => [] },
  })
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
  useProject.setState({ activeChatId: 78, path: 'C:\\project' }, false)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('custom-openai: единый список моделей Settings -> чат', () => {
  it('показывает в ModelPicker все включённые пользовательские модели', async () => {
    render(createElement(ModelPicker, { onOpenSettings: vi.fn() }))
    const trigger = await screen.findByRole('button', { name: /Свой провайдер/i }, { timeout: 4000 })
    fireEvent.click(trigger)

    for (const model of MODELS.slice(1)) {
      await waitFor(() => expect(screen.getByText(model)).toBeTruthy())
    }
  })

  it('выбор текущей модели в Settings сохраняет её в открытый чат', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/Settings.tsx'), 'utf8')
    expect(source).toMatch(/chatSessions\.setModel\(activeChatId, activeProvider, selectedModel\)/)
  })
})
