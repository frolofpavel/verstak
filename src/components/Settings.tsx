import React, { useEffect, useMemo, useState, useCallback } from 'react'
import { useProject } from '../store/projectStore'
import type { Memory, DetectedCli } from '../types/api'
import type { ProviderId } from '../hooks/useProvider'
import { useTheme } from '../hooks/useTheme'
import type { AutonomousStatus } from '../types/api'
import { ProfilesTab } from './ProfilesTab'
import { buildCatalog, connectionStatus, type ConnectionStatus } from '../lib/model-catalog'
import {
  IconClaude, Icon1C, IconGoogleSheets, IconTelegram,
  IconSSH, IconBitrix, IconYandexDirect, IconYandexDisk,
  IconSkillsServer, IconPlug, IconHTTP, IconGitHub
} from './ConnectorIcons'

interface ProviderConfig {
  id: ProviderId
  name: string
  transport: 'API' | 'CLI'
  description: string
  models: string[]
  defaultModel: string
  secretKey: string | null
  keyHint: string
  keyLink?: { url: string; label: string }
  supportsTools: boolean
}

const PROVIDERS: ProviderConfig[] = [
  {
    id: 'gemini-api',
    name: 'Gemini',
    transport: 'API',
    description: 'Google. Полный агентский режим с tools.',
    models: ['gemini-3-pro', 'gemini-3.5-flash', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    defaultModel: 'gemini-3.5-flash',
    secretKey: 'gemini_api_key',
    keyHint: 'AIzaSy…',
    keyLink: { url: 'https://aistudio.google.com', label: 'AI Studio' },
    supportsTools: true
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    transport: 'CLI',
    description: 'Твоя Gemini Ultra подписка через gemini-cli. Без API ключа.',
    models: ['auto', 'gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    defaultModel: 'auto',
    secretKey: null,
    keyHint: '',
    supportsTools: false
  },
  {
    id: 'claude',
    name: 'Claude',
    transport: 'API',
    description: 'Anthropic. Полный агентский режим с tools.',
    models: ['claude-opus-4-5-20251101', 'claude-sonnet-4-5-20251101', 'claude-haiku-4-5-20251101'],
    defaultModel: 'claude-sonnet-4-5-20251101',
    secretKey: 'anthropic_api_key',
    keyHint: 'sk-ant-…',
    keyLink: { url: 'https://console.anthropic.com', label: 'Anthropic Console' },
    supportsTools: true
  },
  {
    id: 'claude-cli',
    name: 'Claude Code',
    transport: 'CLI',
    description: 'Твоя Claude Pro/Max подписка через claude CLI.',
    models: ['auto', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-haiku-4-5', 'claude-sonnet-4-5'],
    defaultModel: 'auto',
    secretKey: null,
    keyHint: '',
    supportsTools: false
  },
  {
    id: 'grok',
    name: 'Grok',
    transport: 'API',
    description: 'xAI. Полный агентский режим с tools.',
    models: ['grok-4', 'grok-4-fast', 'grok-3'],
    defaultModel: 'grok-4',
    secretKey: 'xai_api_key',
    keyHint: 'xai-…',
    keyLink: { url: 'https://console.x.ai', label: 'xAI Console' },
    supportsTools: true
  },
  {
    id: 'grok-cli',
    name: 'Grok Build',
    transport: 'CLI',
    description: 'Твоя x.com/SuperGrok подписка через grok CLI.',
    models: ['auto', 'grok-4', 'grok-4-fast', 'grok-code-fast-1', 'grok-3'],
    defaultModel: 'auto',
    secretKey: null,
    keyHint: '',
    supportsTools: false
  },
  {
    id: 'openai',
    name: 'ChatGPT',
    transport: 'API',
    description: 'OpenAI. Полный агентский режим с tools.',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini'],
    defaultModel: 'gpt-5',
    secretKey: 'openai_api_key',
    keyHint: 'sk-…',
    keyLink: { url: 'https://platform.openai.com/api-keys', label: 'OpenAI Platform' },
    supportsTools: true
  },
  {
    id: 'codex-cli',
    name: 'Codex CLI',
    transport: 'CLI',
    description: 'Твоя ChatGPT Plus/Pro подписка через codex CLI.',
    models: ['auto', 'gpt-5-codex', 'gpt-5', 'gpt-5-mini', 'o3', 'o3-mini', 'gpt-4o'],
    defaultModel: 'auto',
    secretKey: null,
    keyHint: '',
    supportsTools: false
  },
  // OpenAI-compatible extra-провайдеры (zеркало EXTRA_PROVIDERS из electron/ai/extra-providers.ts).
  // При обновлении расширений — обновляй ОБА файла; renderer не имеет доступа к main.
  {
    id: 'openrouter',
    name: 'OpenRouter',
    transport: 'API',
    description: 'Один ключ → все модели (Claude, GPT, Gemini, Grok, open-source).',
    models: ['anthropic/claude-opus-4-5', 'anthropic/claude-sonnet-4-6', 'openai/gpt-5', 'openai/gpt-5-mini', 'google/gemini-3-pro', 'google/gemini-3.5-flash', 'x-ai/grok-4', 'deepseek/deepseek-v3', 'meta-llama/llama-3.3-70b-instruct'],
    defaultModel: 'anthropic/claude-sonnet-4-6',
    secretKey: 'openrouter_api_key',
    keyHint: 'sk-or-...',
    keyLink: { url: 'https://openrouter.ai/keys', label: 'openrouter.ai/keys' },
    supportsTools: true
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    transport: 'API',
    description: 'Китайские модели, reasoner R1 за копейки. Хороший fallback для бюджета.',
    models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'],
    defaultModel: 'deepseek-chat',
    secretKey: 'deepseek_api_key',
    keyHint: 'sk-...',
    keyLink: { url: 'https://platform.deepseek.com/api_keys', label: 'platform.deepseek.com' },
    supportsTools: true
  },
  {
    id: 'mistral',
    name: 'Mistral',
    transport: 'API',
    description: 'Европейский провайдер. Без санкционных рисков. Codestral хорош для кода.',
    models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest', 'ministral-8b-latest'],
    defaultModel: 'mistral-large-latest',
    secretKey: 'mistral_api_key',
    keyHint: 'API key...',
    keyLink: { url: 'https://console.mistral.ai/api-keys', label: 'console.mistral.ai' },
    supportsTools: true
  },
  {
    id: 'groq',
    name: 'Groq',
    transport: 'API',
    description: 'LPU-инференс: Llama/Mixtral на 500+ tok/s. Для streaming-чатов где важна реакция.',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
    defaultModel: 'llama-3.3-70b-versatile',
    secretKey: 'groq_api_key',
    keyHint: 'gsk_...',
    keyLink: { url: 'https://console.groq.com/keys', label: 'console.groq.com' },
    supportsTools: true
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    transport: 'API',
    description: 'Локальный сервер. Запусти `ollama serve`. $0, без интернета, данные не уходят.',
    models: ['llama3.3', 'qwen2.5-coder', 'deepseek-r1', 'mistral', 'gemma2'],
    defaultModel: 'llama3.3',
    secretKey: null,
    keyHint: '',
    supportsTools: true
  },
  // 🇷🇺 Российские провайдеры. Mark в description для отличия.
  {
    id: 'yandex-gpt',
    name: 'YandexGPT',
    transport: 'API',
    description: '🇷🇺 152-ФЗ совместим. Yandex Cloud Foundation Models.',
    models: ['yandexgpt/latest', 'yandexgpt-lite/latest', 'yandexgpt-32k/latest'],
    defaultModel: 'yandexgpt/latest',
    secretKey: 'yandex_api_key',
    keyHint: 'AQVN…',
    keyLink: { url: 'https://console.yandex.cloud/iam', label: 'Yandex Cloud Console' },
    supportsTools: false
  },
  {
    id: 'gigachat',
    name: 'GigaChat',
    transport: 'API',
    description: '🇷🇺 152-ФЗ совместим. Сбер. GigaChat Lite / Plus / Pro / Max.',
    models: ['GigaChat', 'GigaChat-Plus', 'GigaChat-Pro', 'GigaChat-Max'],
    defaultModel: 'GigaChat',
    secretKey: 'gigachat_client_id',
    keyHint: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    keyLink: { url: 'https://developers.sber.ru/portal/products/gigachat-api', label: 'developers.sber.ru' },
    supportsTools: false
  },
  {
    id: 'custom-openai',
    name: 'Свой провайдер (OpenAI-compatible)',
    transport: 'API',
    description: 'Любой self-hosted endpoint совместимый с OpenAI API: vLLM, LM Studio, корпоративный шлюз.',
    models: [], // Заполняется юзером через custom-блок в UI
    defaultModel: '',
    secretKey: 'custom_openai_api_key',
    keyHint: '(опционально если endpoint требует)',
    supportsTools: true
  }
]

type Tab = 'appearance' | 'profiles' | 'providers' | 'models' | 'connectors' | 'autonomous' | 'memory'

// Группы для левой sidebar — повторяет OpenCode Desktop структуру.
const TAB_GROUPS: ReadonlyArray<{ title: string; tabs: ReadonlyArray<{ id: Tab; label: string; icon: React.ReactNode }> }> = [
  { title: 'Приложение', tabs: [
    { id: 'appearance', label: 'Внешний вид',  icon: '🎨' },
    { id: 'profiles',   label: 'Профили',      icon: '👤' }
  ] },
  { title: 'Сервер', tabs: [
    { id: 'providers',  label: 'Провайдеры',   icon: '🔌' },
    { id: 'models',     label: 'Модели',       icon: '✨' },
    { id: 'connectors', label: 'Коннекторы',   icon: <IconPlug size={16} /> },
    { id: 'autonomous', label: 'Ночной режим', icon: '🌙' },
    { id: 'memory',     label: 'Память',       icon: '🧠' }
  ] }
]

function modelKey(providerId: ProviderId, model: string): string {
  return `${providerId}::${model}`
}
function allModelsSet(): Set<string> {
  const s = new Set<string>()
  for (const p of PROVIDERS) {
    for (const m of p.models) s.add(modelKey(p.id, m))
  }
  return s
}

interface ConnectorDef {
  id: string
  name: string
  description: string
  icon: React.FC<{ size?: number }>
  configuredKey: string  // settings key to check — if non-empty, connector is "connected"
}

const CONNECTORS: ConnectorDef[] = [
  { id: 'claude-oauth', name: 'Claude Code', description: 'OAuth token для Max подписки', icon: IconClaude, configuredKey: 'claude_code_oauth_token' },
  { id: 'onec', name: '1С OData', description: 'ERP-система, справочники, документы', icon: Icon1C, configuredKey: 'onec_base_url' },
  { id: 'http', name: 'HTTP API', description: 'Произвольные REST endpoints', icon: IconHTTP, configuredKey: '' },
  { id: 'gsheets', name: 'Google Sheets', description: 'Таблицы, данные, отчёты', icon: IconGoogleSheets, configuredKey: 'gsheets_service_account_json' },
  { id: 'telegram', name: 'Telegram', description: 'Бот для уведомлений и команд', icon: IconTelegram, configuredKey: 'telegram_bot_token' },
  { id: 'ssh', name: 'SSH', description: 'Удалённое выполнение команд', icon: IconSSH, configuredKey: 'ssh_default_host' },
  { id: 'bitrix', name: 'Битрикс24', description: 'CRM, сделки, задачи', icon: IconBitrix, configuredKey: 'bitrix24_webhook_url' },
  { id: 'ydirect', name: 'Яндекс.Директ', description: 'Рекламные кампании и отчёты', icon: IconYandexDirect, configuredKey: 'yandex_direct_token' },
  { id: 'ydisk', name: 'Яндекс.Диск', description: 'Файлы и шеринг артефактов', icon: IconYandexDisk, configuredKey: 'yandex_disk_token' },
  { id: 'skills-server', name: 'Сервер скиллов', description: 'Удалённые AI-скиллы', icon: IconSkillsServer, configuredKey: 'skills_server_base' },
  { id: 'github', name: 'GitHub', description: 'Репозитории, issues, PR, code search', icon: IconGitHub, configuredKey: 'github_token' },
]

export function Settings({ onClose }: { onClose: () => void }) {
  const activeProjectPath = useProject(s => s.path)
  const [tab, setTab] = useState<Tab>('providers')
  const [activeProvider, setActiveProvider] = useState<ProviderId>('gemini-api')
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [models, setModels] = useState<Record<string, string>>({})
  const [enabledModels, setEnabledModels] = useState<Set<string>>(new Set())
  const [saved, setSaved] = useState(false)
  const [onec, setOneC] = useState({ url: '', user: '', pass: '' })
  const [autonomous, setAutonomousState] = useState<AutonomousStatus>({
    enabled: false, intervalMin: 30, lastRunAt: null, lastRunSuggestions: 0, lastRunError: null, nextRunAt: null
  })
  const [httpEndpoints, setHttpEndpoints] = useState<Array<{ name: string; base: string; auth: string; paths: string }>>(
    [{ name: '', base: '', auth: '', paths: '' }, { name: '', base: '', auth: '', paths: '' }, { name: '', base: '', auth: '', paths: '' }, { name: '', base: '', auth: '', paths: '' }]
  )
  // V3 — российские коннекторы (раздел 5 плана).
  const [gsheetsJson, setGsheetsJson] = useState('')
  const [telegramBotToken, setTelegramBotToken] = useState('')
  const [telegramWhitelist, setTelegramWhitelist] = useState('')
  const [sshHost, setSshHost] = useState('')
  const [sshKeyPath, setSshKeyPath] = useState('')
  const [bitrixWebhook, setBitrixWebhook] = useState('')
  const [yDirectToken, setYDirectToken] = useState('')
  const [yDirectLogin, setYDirectLogin] = useState('')
  const [skillsServerBase, setSkillsServerBase] = useState('')
  const [claudeOauthToken, setClaudeOauthToken] = useState('')
  const [yDiskToken, setYDiskToken] = useState('')
  const [githubToken, setGithubToken] = useState('')
  const [costCap, setCostCap] = useState('')
  const [configuredConnectors, setConfiguredConnectors] = useState<Set<string>>(new Set())
  const [openConnector, setOpenConnector] = useState<string | null>(null)
  // Custom OpenAI-compatible: base URL + список моделей через запятую.
  // Сохраняется в settings.custom_openai_baseurl / custom_openai_models.
  const [customOpenaiBaseUrl, setCustomOpenaiBaseUrl] = useState('')
  const [customOpenaiModels, setCustomOpenaiModels] = useState('')
  const [memories, setMemories] = useState<Memory[]>([])
  const [memoriesPath, setMemoriesPath] = useState<string | null>(null)
  // Core memory — MEMORY.md и USER.md
  const [coreMemoryText, setCoreMemoryText] = useState('')
  const [coreUserText, setCoreUserText] = useState('')
  const [coreMemorySaved, setCoreMemorySaved] = useState(false)
  const { theme, setTheme } = useTheme()

  useEffect(() => {
    void (async () => {
      const provider = await window.api.settings.getKey('provider')
      const valid = ['gemini-api', 'gemini-cli', 'claude', 'grok', 'openai'].includes(provider ?? '') ? (provider as ProviderId) : 'gemini-api'
      setActiveProvider(valid)
      const keyVals: Record<string, string> = {}
      const modelVals: Record<string, string> = {}
      for (const p of PROVIDERS) {
        if (p.secretKey) {
          const v = await window.api.settings.getKey(p.secretKey)
          if (v) keyVals[p.secretKey] = v
        }
        let m = await window.api.settings.getKey(`model_${p.id}`)
        // Migration: drop saved model values that aren't in the current list
        // (e.g. gemini-3.5-flash for gemini-cli — alias only works for API)
        if (m && !p.models.includes(m)) {
          await window.api.settings.setKey(`model_${p.id}`, p.defaultModel)
          m = p.defaultModel
        }
        modelVals[p.id] = m ?? p.defaultModel
      }
      setKeys(keyVals)
      setModels(modelVals)
      // 1С connector creds
      const url = await window.api.settings.getKey('onec_base_url')
      const user = await window.api.settings.getKey('onec_username')
      const pass = await window.api.settings.getKey('onec_password')
      setOneC({ url: url ?? '', user: user ?? '', pass: pass ?? '' })
      // HTTP endpoints
      const eps: typeof httpEndpoints = []
      for (let i = 1; i <= 4; i++) {
        eps.push({
          name:  (await window.api.settings.getKey(`http_endpoint_${i}_name`))  ?? '',
          base:  (await window.api.settings.getKey(`http_endpoint_${i}_base`))  ?? '',
          auth:  (await window.api.settings.getKey(`http_endpoint_${i}_auth`))  ?? '',
          paths: (await window.api.settings.getKey(`http_endpoint_${i}_paths`)) ?? ''
        })
      }
      setHttpEndpoints(eps)
      // Autonomous loop status
      try {
        const st = await window.api.autonomous.status()
        setAutonomousState(st)
      } catch { /* ignore */ }
      // V3 коннекторы
      setGsheetsJson((await window.api.settings.getKey('gsheets_service_account_json')) ?? '')
      setTelegramBotToken((await window.api.settings.getKey('telegram_bot_token')) ?? '')
      setTelegramWhitelist((await window.api.settings.getKey('telegram_chat_whitelist')) ?? '')
      setSshHost((await window.api.settings.getKey('ssh_default_host')) ?? '')
      setSshKeyPath((await window.api.settings.getKey('ssh_key_path')) ?? '')
      setBitrixWebhook((await window.api.settings.getKey('bitrix24_webhook_url')) ?? '')
      setYDirectToken((await window.api.settings.getKey('yandex_direct_token')) ?? '')
      setYDirectLogin((await window.api.settings.getKey('yandex_direct_login')) ?? '')
      setSkillsServerBase((await window.api.settings.getKey('skills_server_base')) ?? '')
      setClaudeOauthToken((await window.api.settings.getKey('claude_code_oauth_token')) ?? '')
      setYDiskToken((await window.api.settings.getKey('yandex_disk_token')) ?? '')
      setGithubToken((await window.api.settings.getKey('github_token')) ?? '')
      setCostCap((await window.api.settings.getKey('cost_cap_usd_per_session')) ?? '')
      setCustomOpenaiBaseUrl((await window.api.settings.getKey('custom_openai_baseurl')) ?? '')
      setCustomOpenaiModels((await window.api.settings.getKey('custom_openai_models')) ?? '')
      // Какие модели «включены» в picker'е. Пусто = все.
      const em = await window.api.settings.getKey('enabled_models')
      if (em) {
        try {
          const arr = JSON.parse(em) as string[]
          setEnabledModels(Array.isArray(arr) && arr.length > 0 ? new Set(arr) : allModelsSet())
        } catch {
          setEnabledModels(allModelsSet())
        }
      } else {
        setEnabledModels(allModelsSet())
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadMemories = useCallback(async (path: string) => {
    try {
      const list = await window.api.memory.list(path)
      setMemories(list)
    } catch { /* ignore */ }
  }, [])

  // Загружаем память когда открывается вкладка «Память»
  useEffect(() => {
    if (tab !== 'memory') return
    void (async () => {
      // Приоритет — активный проект из store; fallback на lastOpenedAt
      let path = activeProjectPath
      if (!path) {
        const projects = await window.api.projects.list()
        if (projects.length === 0) return
        const sorted = [...projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
        path = sorted[0].path
      }
      setMemoriesPath(path)
      void loadMemories(path)
      // Загружаем core memory
      try {
        const cm = await window.api.coreMemory.load(path)
        setCoreMemoryText(cm.memory)
        setCoreUserText(cm.user)
      } catch { /* ignore */ }
    })()
  }, [tab, activeProjectPath, loadMemories])

  // Detect which connectors are configured (for card badges)
  useEffect(() => {
    if (tab !== 'connectors') return
    void Promise.all(CONNECTORS.map(async c => {
      if (!c.configuredKey) return null
      const val = await window.api.settings.getKey(c.configuredKey)
      return val ? c.id : null
    })).then(results => {
      setConfiguredConnectors(new Set(results.filter(Boolean) as string[]))
    })
  }, [tab])

  async function save() {
    await window.api.settings.setKey('provider', activeProvider)
    for (const p of PROVIDERS) {
      if (p.secretKey && keys[p.secretKey] !== undefined) {
        await window.api.settings.setKey(p.secretKey, keys[p.secretKey])
      }
      if (models[p.id]) {
        await window.api.settings.setKey(`model_${p.id}`, models[p.id])
      }
    }
    await window.api.settings.setKey('onec_base_url', onec.url)
    await window.api.settings.setKey('onec_username', onec.user)
    await window.api.settings.setKey('onec_password', onec.pass)
    for (let i = 0; i < httpEndpoints.length; i++) {
      const e = httpEndpoints[i]
      await window.api.settings.setKey(`http_endpoint_${i + 1}_name`,  e.name)
      await window.api.settings.setKey(`http_endpoint_${i + 1}_base`,  e.base)
      await window.api.settings.setKey(`http_endpoint_${i + 1}_auth`,  e.auth)
      await window.api.settings.setKey(`http_endpoint_${i + 1}_paths`, e.paths)
    }
    // V3 — российские коннекторы и server skills
    await window.api.settings.setKey('gsheets_service_account_json', gsheetsJson)
    await window.api.settings.setKey('telegram_bot_token', telegramBotToken)
    await window.api.settings.setKey('telegram_chat_whitelist', telegramWhitelist)
    await window.api.settings.setKey('ssh_default_host', sshHost)
    await window.api.settings.setKey('ssh_key_path', sshKeyPath)
    await window.api.settings.setKey('bitrix24_webhook_url', bitrixWebhook)
    await window.api.settings.setKey('yandex_direct_token', yDirectToken)
    await window.api.settings.setKey('yandex_direct_login', yDirectLogin)
    await window.api.settings.setKey('skills_server_base', skillsServerBase)
    await window.api.settings.setKey('claude_code_oauth_token', claudeOauthToken)
    await window.api.settings.setKey('yandex_disk_token', yDiskToken)
    await window.api.settings.setKey('github_token', githubToken)
    await window.api.settings.setKey('cost_cap_usd_per_session', costCap)
    await window.api.settings.setKey('enabled_models', JSON.stringify([...enabledModels]))
    await window.api.settings.setKey('custom_openai_baseurl', customOpenaiBaseUrl)
    await window.api.settings.setKey('custom_openai_models', customOpenaiModels)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  function renderConnectorForm(id: string): React.ReactNode {
    switch (id) {
      case 'claude-oauth': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Long-lived OAuth token</label>
            <input
              className="gg-input"
              type="password"
              value={claudeOauthToken}
              onChange={e => setClaudeOauthToken(e.target.value)}
              placeholder="sk-ant-oat01-... (из `claude setup-token` в PowerShell)"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-hint">
            Claude Code v2.1+ в headless режиме (через нашу программу) НЕ использует Max OAuth напрямую — требует
            long-lived token. Получи: <code>claude setup-token</code> в PowerShell → подтверди в браузере →
            копируй token сюда. Verstak будет передавать его как env var <code>CLAUDE_CODE_OAUTH_TOKEN</code>
            при запуске claude. Решает «401 Invalid credentials» при выборе провайдера Claude Code.
            Хранится зашифрованным через safeStorage. Действителен 1 год.
          </div>
        </>
      )
      case 'onec': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">1С OData base URL</label>
            <input
              className="gg-input"
              value={onec.url}
              onChange={e => setOneC(s => ({ ...s, url: e.target.value }))}
              placeholder="https://1c.example.com/base/odata/standard.odata"
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Логин</label>
            <input
              className="gg-input"
              value={onec.user}
              onChange={e => setOneC(s => ({ ...s, user: e.target.value }))}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Пароль</label>
            <input
              className="gg-input"
              type="password"
              value={onec.pass}
              onChange={e => setOneC(s => ({ ...s, pass: e.target.value }))}
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-hint">
            Кред хранится зашифрованным в Electron safeStorage. AI может звать
            tool <code>connector_query</code> с id=<code>onec</code>; пароль
            никогда не попадает в промпт.
          </div>
        </>
      )
      case 'http': return (
        <>
          {httpEndpoints.map((ep, i) => (
            <div key={i} className="gg-http-endpoint">
              <div className="gg-http-endpoint-head">#{i + 1}</div>
              <div className="gg-settings-row">
                <label className="gg-settings-label">Имя</label>
                <input className="gg-input" value={ep.name} placeholder='напр. "github" или "internal-api"'
                  onChange={e => setHttpEndpoints(arr => arr.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                  spellCheck={false} />
              </div>
              <div className="gg-settings-row">
                <label className="gg-settings-label">Base URL</label>
                <input className="gg-input" value={ep.base} placeholder="https://api.github.com"
                  onChange={e => setHttpEndpoints(arr => arr.map((x, j) => j === i ? { ...x, base: e.target.value } : x))}
                  spellCheck={false} />
              </div>
              <div className="gg-settings-row">
                <label className="gg-settings-label">Authorization</label>
                <input className="gg-input" type="password" value={ep.auth} placeholder='напр. "Bearer ghp_…"'
                  onChange={e => setHttpEndpoints(arr => arr.map((x, j) => j === i ? { ...x, auth: e.target.value } : x))}
                  autoComplete="new-password" />
              </div>
              <div className="gg-settings-row">
                <label className="gg-settings-label">Allow-paths</label>
                <input className="gg-input" value={ep.paths} placeholder="/repos,/user (пусто = всё под base)"
                  onChange={e => setHttpEndpoints(arr => arr.map((x, j) => j === i ? { ...x, paths: e.target.value } : x))}
                  spellCheck={false} />
              </div>
            </div>
          ))}
          <div className="gg-settings-hint">
            AI вызывает <code>connector_query</code> с <code>id="http"</code>,
            <code>endpoint=&lt;имя&gt;</code> и path/method/query/body/headers.
            Auth-заголовок подставляется из настроек, AI его не видит.
            Allow-paths ограничивает к каким путям эндпоинта можно обращаться.
          </div>
        </>
      )
      case 'gsheets': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Service Account JSON</label>
            <textarea
              className="gg-input"
              value={gsheetsJson}
              onChange={e => setGsheetsJson(e.target.value)}
              placeholder='{"type": "service_account", "client_email": "...", "private_key": "-----BEGIN PRIVATE KEY-----\\n...", ...}'
              rows={5}
              style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-hint">
            JSON service account (как в <code>/opt/los/creds.json</code>). Шифруется через safeStorage.
            AI вызывает <code>connector_query</code> с <code>id="gsheets"</code> и <code>op="read_as_records"</code> /
            <code>"update_row"</code> / etc. См. electron/connectors/gsheets.ts.
          </div>
        </>
      )
      case 'telegram': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Bot token</label>
            <input
              className="gg-input"
              type="password"
              value={telegramBotToken}
              onChange={e => setTelegramBotToken(e.target.value)}
              placeholder="1234567890:AAH... (от @BotFather)"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Chat whitelist (JSON)</label>
            <input
              className="gg-input"
              value={telegramWhitelist}
              onChange={e => setTelegramWhitelist(e.target.value)}
              placeholder='["-1003242936373", "@private_chat"]'
              style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-hint">
            JSON-массив chat_id куда боту разрешено отправлять. Пустая строка = всем (только dev).
            Rate limit 20 send/min на chat_id вшит в коннектор. Read истории — через SSH к Telethon скрипту.
          </div>
        </>
      )
      case 'ssh': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Default host</label>
            <input
              className="gg-input"
              value={sshHost}
              onChange={e => setSshHost(e.target.value)}
              placeholder="user@server.example.com или alias из ~/.ssh/config"
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Path к private key</label>
            <input
              className="gg-input"
              value={sshKeyPath}
              onChange={e => setSshKeyPath(e.target.value)}
              placeholder="~/.ssh/id_ed25519 (или полный путь к приватному ключу)"
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-hint">
            Whitelist: только default host разрешён для запросов. Команды денилист:
            rm -rf системных корней, mkfs, dd на /dev, passwd, sudo su, systemctl stop, и т.п.
            Через connector_query с <code>id="ssh"</code> и <code>op="run_remote"</code>.
          </div>
        </>
      )
      case 'bitrix': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Incoming webhook URL</label>
            <input
              className="gg-input"
              type="password"
              value={bitrixWebhook}
              onChange={e => setBitrixWebhook(e.target.value)}
              placeholder="https://your-portal.bitrix24.ru/rest/USER_ID/TOKEN/"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-hint">
            Создать в Битрикс24: Разработчикам → Другое → Входящий вебхук. Полный URL с токеном.
            Denied methods: *.delete (crm.deal/lead/contact/company/user). Allowed prefixes: crm.*, tasks.*, user.*.
          </div>
        </>
      )
      case 'ydirect': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">OAuth token</label>
            <input
              className="gg-input"
              type="password"
              value={yDirectToken}
              onChange={e => setYDirectToken(e.target.value)}
              placeholder="Получить: oauth.yandex.ru, scope: direct:api"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Client-Login (опц.)</label>
            <input
              className="gg-input"
              value={yDirectLogin}
              onChange={e => setYDirectLogin(e.target.value)}
              placeholder="Login клиента — для агентских аккаунтов"
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-hint">
            Reports API асинхронный — connector polls до 30s. Если отчёт большой,
            возвращается <code>processing: true</code>, повторяй запрос.
          </div>
        </>
      )
      case 'ydisk': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">OAuth token</label>
            <input
              className="gg-input"
              type="password"
              value={yDiskToken}
              onChange={e => setYDiskToken(e.target.value)}
              placeholder="oauth.yandex.ru со scope cloud_api:disk.write"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-hint">
            Используется агентом для шеринга артефактов с клиентами:
            upload_file → get_public_url → отправка ссылки в TG.
            Загрузка идёт в <code>/Verstak/{`{дата}`}/</code> чтобы не засорять корень Диска.
          </div>
        </>
      )
      case 'skills-server': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Skills server base URL</label>
            <input
              className="gg-input"
              value={skillsServerBase}
              onChange={e => setSkillsServerBase(e.target.value)}
              placeholder="https://aioperatingsystem.ru (или пусто для built-in only)"
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-hint">
            Сервер должен предоставлять <code>GET /api/skills</code> возвращающий
            <code>{`{skills: [{id, raw, sourceRef}]}`}</code>. Если недоступен — используются built-in
            (bos-sales / bos-mkt / client-cycle) + локальные из ~/.verstak/skills/.
          </div>
        </>
      )
      case 'github': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Personal Access Token</label>
            <input
              className="gg-input"
              type="password"
              value={githubToken}
              onChange={e => setGithubToken(e.target.value)}
              placeholder="ghp_... (Settings → Developer settings → Personal access tokens)"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-hint">
            Создать: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens.
            Нужны scopes: <code>repo</code>, <code>read:org</code>. AI вызывает <code>connector_query</code> с{' '}
            <code>id="github"</code> и <code>op="list_repos"</code> / <code>"list_issues"</code> / etc.
            Хранится зашифрованным через safeStorage.
          </div>
        </>
      )
      default: return null
    }
  }

  return (
    <div className="gg-modal-backdrop" onClick={onClose}>
      <div className="gg-modal gg-modal-large" onClick={e => e.stopPropagation()}>
        <div className="gg-modal-header">
          <div className="gg-modal-title">Настройки</div>
          <button className="gg-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="gg-settings-shell">
          <aside className="gg-settings-nav" role="tablist" aria-label="Разделы настроек">
            {TAB_GROUPS.map(g => (
              <div key={g.title} className="gg-settings-nav-group">
                <div className="gg-settings-nav-title">{g.title}</div>
                {g.tabs.map(t => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.id}
                    className={`gg-settings-nav-item ${tab === t.id ? 'is-active' : ''}`}
                    onClick={() => setTab(t.id)}
                  >
                    <span className="gg-settings-nav-icon" aria-hidden>{t.icon}</span>
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </aside>

          <div className="gg-settings-content">

        {tab === 'providers' && (
        <ProvidersPage
          providers={PROVIDERS}
          keys={keys}
          setKeys={setKeys}
          activeProvider={activeProvider}
          setActiveProvider={setActiveProvider}
          customOpenaiBaseUrl={customOpenaiBaseUrl}
          setCustomOpenaiBaseUrl={setCustomOpenaiBaseUrl}
          customOpenaiModels={customOpenaiModels}
          setCustomOpenaiModels={setCustomOpenaiModels}
        />
        )}

        {tab === 'models' && (
        <ModelsPage
          providers={PROVIDERS}
          enabledModels={enabledModels}
          setEnabledModels={setEnabledModels}
          models={models}
          setModels={setModels}
          activeProvider={activeProvider}
          setActiveProvider={setActiveProvider}
          keys={keys}
        />
        )}

        {tab === 'connectors' && (
        <div className="gg-settings-extra">
          {/* Cost cap — not a connector, stays at top */}
          <div className="gg-connector-cost-cap">
            <div className="gg-settings-section-title">💰 Hard cost cap (auto-stop)</div>
            <div className="gg-settings-row">
              <label className="gg-settings-label">Лимит $/сессия</label>
              <input
                className="gg-input"
                type="text"
                value={costCap}
                onChange={e => setCostCap(e.target.value.replace(/[^\d.]/g, ''))}
                placeholder="Например: 5 (max $5 за сессию). Пусто = guard выключен."
                style={{ maxWidth: 200 }}
              />
            </div>
            <div className="gg-settings-hint">
              Если AI-сессия (API-провайдер) превысит этот лимит — auto-stop с
              сообщением «лимит израсходован». CLI-провайдеры (подписки) идут
              мимо лимита — они $0. Лимит на ОДНУ сессию, не суммарно за день.
              Стандартный chat = $0.05-0.50. Длинный agent loop с большим
              проектом = $2-10. Безопасный default: 5.
            </div>
          </div>

          {/* Card grid — Codex-style marketplace */}
          <div className="gg-connector-grid">
            {CONNECTORS.map(c => {
              const configured = configuredConnectors.has(c.id)
              return (
                <button
                  key={c.id}
                  className={`gg-connector-card ${configured ? 'is-connected' : ''} ${openConnector === c.id ? 'is-open' : ''}`}
                  onClick={() => setOpenConnector(openConnector === c.id ? null : c.id)}
                >
                  <div className="gg-connector-card-icon"><c.icon size={32} /></div>
                  <div className="gg-connector-card-body">
                    <div className="gg-connector-card-name">{c.name}</div>
                    <div className="gg-connector-card-desc">{c.description}</div>
                  </div>
                  <div className="gg-connector-card-status">
                    {configured ? <span className="gg-badge-connected">&#10003;</span> : <span className="gg-badge-add">+</span>}
                  </div>
                </button>
              )
            })}
          </div>

          {/* Expanded settings panel below the grid */}
          {openConnector && (
            <div className="gg-connector-detail">
              <div className="gg-connector-detail-header">
                {(() => { const def = CONNECTORS.find(c => c.id === openConnector); return def ? <><def.icon size={20} /> {def.name}</> : null })()}
                <button className="gg-connector-detail-close" onClick={() => setOpenConnector(null)}>×</button>
              </div>
              <div className="gg-connector-detail-body">
                {renderConnectorForm(openConnector)}
              </div>
            </div>
          )}
        </div>
        )}

        {tab === 'autonomous' && (
        <div className="gg-settings-extra">
          <div className="gg-settings-section-title">🌙 Ночной режим — autonomous improvement loop</div>
          <div className="gg-settings-hint" style={{ marginBottom: 14 }}>
            Фоновый цикл который без участия пользователя читает журнал и project_map активного проекта, отправляет AI задачу «предложи 3 улучшения с обоснованием из истории», парсит ответ и пишет предложения в Journal как заметки. Утром открываешь Journal → видишь N предложений за ночь. <strong>Не делает write_file / run_command автоматически</strong> — только генерирует идеи.
          </div>

          <div className="gg-settings-row">
            <label className="gg-settings-label">Статус</label>
            <div style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>
              {autonomous.enabled
                ? <span style={{ color: 'var(--success, #4ade80)' }}>● Активен · каждые {autonomous.intervalMin} мин</span>
                : <span style={{ color: 'var(--text-tertiary)' }}>○ Остановлен</span>}
            </div>
          </div>

          <div className="gg-settings-row">
            <label className="gg-settings-label">Интервал (мин)</label>
            <input
              className="gg-input"
              type="number"
              min={5}
              max={240}
              value={autonomous.intervalMin}
              onChange={e => setAutonomousState(s => ({ ...s, intervalMin: parseInt(e.target.value, 10) || 30 }))}
              style={{ maxWidth: 100 }}
            />
          </div>

          <div className="gg-settings-row">
            <label className="gg-settings-label">Управление</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {!autonomous.enabled ? (
                <button
                  className="gg-btn gg-btn-primary"
                  onClick={async () => {
                    const st = await window.api.autonomous.start(autonomous.intervalMin)
                    setAutonomousState(st)
                  }}
                >▶ Запустить</button>
              ) : (
                <button
                  className="gg-btn gg-btn-danger"
                  onClick={async () => {
                    const st = await window.api.autonomous.stop()
                    setAutonomousState(st)
                  }}
                >■ Остановить</button>
              )}
              <button
                className="gg-btn gg-btn-ghost"
                onClick={async () => {
                  const st = await window.api.autonomous.runOnce()
                  setAutonomousState(st)
                }}
              >Запустить цикл прямо сейчас</button>
            </div>
          </div>

          {autonomous.lastRunAt && (
            <div className="gg-settings-row">
              <label className="gg-settings-label">Последний запуск</label>
              <div style={{ flex: 1, fontSize: 'var(--text-sm)' }}>
                {new Date(autonomous.lastRunAt).toLocaleString()}
                {' · '}
                {autonomous.lastRunError
                  ? <span style={{ color: 'var(--error)' }}>ошибка: {autonomous.lastRunError}</span>
                  : <span>предложений: {autonomous.lastRunSuggestions}</span>}
              </div>
            </div>
          )}

          {autonomous.nextRunAt && autonomous.enabled && (
            <div className="gg-settings-row">
              <label className="gg-settings-label">Следующий</label>
              <div style={{ flex: 1, fontSize: 'var(--text-sm)' }}>
                {new Date(autonomous.nextRunAt).toLocaleString()}
              </div>
            </div>
          )}

          <div className="gg-settings-hint" style={{ marginTop: 14 }}>
            <strong>Требования:</strong> провайдер должен быть API-типа с ключом (Gemini / Claude / Grok / ChatGPT API).
            CLI-провайдеры (Claude Code, Codex и т.д.) не годятся — нет неинтерактивного канала.
            Активный проект должен быть открыт.
          </div>
        </div>
        )}

        {tab === 'profiles' && (<ProfilesTab />)}

        {tab === 'memory' && (
        <div className="gg-settings-extra">
          <div className="gg-settings-section-title">🧠 Память агента</div>
          {memoriesPath && (
            <div className="gg-settings-hint" style={{ marginBottom: 12 }}>
              Проект: <code>{memoriesPath}</code>
            </div>
          )}

          {/* ── Core Memory ── */}
          <div className="gg-core-memory-section">
            <div className="gg-core-memory-header">
              Core Memory
              <span className="gg-settings-hint" style={{ marginLeft: 8, display: 'inline', fontStyle: 'normal' }}>
                (всегда в контексте агента)
              </span>
            </div>

            <label className="gg-core-memory-label">О проекте (MEMORY.md)</label>
            <div className="gg-core-memory-field">
              <textarea
                className="gg-input gg-core-memory-textarea"
                value={coreMemoryText}
                onChange={e => setCoreMemoryText(e.target.value)}
                maxLength={2000}
                rows={6}
                placeholder="Агент заполнит автоматически или напиши сам: конвенции, архитектура, важные решения..."
                spellCheck={false}
              />
              <span className={`gg-char-count ${coreMemoryText.length > 1900 ? 'is-warn' : ''}`}>
                {coreMemoryText.length}/2000
              </span>
            </div>

            <label className="gg-core-memory-label">О пользователе (USER.md)</label>
            <div className="gg-core-memory-field">
              <textarea
                className="gg-input gg-core-memory-textarea"
                value={coreUserText}
                onChange={e => setCoreUserText(e.target.value)}
                maxLength={1500}
                rows={4}
                placeholder="Предпочтения, стиль общения, правила взаимодействия..."
                spellCheck={false}
              />
              <span className={`gg-char-count ${coreUserText.length > 1400 ? 'is-warn' : ''}`}>
                {coreUserText.length}/1500
              </span>
            </div>

            <div className="gg-core-memory-actions">
              <button
                type="button"
                className="gg-btn gg-btn-primary"
                disabled={!memoriesPath}
                onClick={async () => {
                  if (!memoriesPath) return
                  await window.api.coreMemory.save(memoriesPath, 'memory', coreMemoryText)
                  await window.api.coreMemory.save(memoriesPath, 'user', coreUserText)
                  setCoreMemorySaved(true)
                  setTimeout(() => setCoreMemorySaved(false), 1500)
                }}
              >
                {coreMemorySaved ? '✓ Сохранено' : 'Сохранить Core Memory'}
              </button>
            </div>
          </div>

          <div className="gg-settings-section-title" style={{ marginTop: 20 }}>Архивная память</div>
          {memories.length === 0 ? (
            <div className="gg-text-tertiary" style={{ padding: '18px 0', fontSize: 'var(--text-sm)' }}>
              Нет сохранённых воспоминаний для этого проекта
            </div>
          ) : (
            <>
              <div className="gg-memory-list">
                {memories.map(m => (
                  <div key={m.id} className="gg-memory-row">
                    <div className="gg-memory-row-main">
                      <span className="gg-memory-type-badge">{m.type}</span>
                      <span className="gg-memory-content">{m.content}</span>
                    </div>
                    {m.tags.length > 0 && (
                      <div className="gg-memory-tags">
                        {m.tags.map(t => <span key={t} className="gg-memory-tag">{t}</span>)}
                      </div>
                    )}
                    <button
                      type="button"
                      className="gg-btn gg-btn-ghost gg-memory-delete"
                      title="Удалить"
                      onClick={async () => {
                        await window.api.memory.delete(m.id)
                        if (memoriesPath) void loadMemories(memoriesPath)
                      }}
                    >🗑</button>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 16 }}>
                <button
                  type="button"
                  className="gg-btn gg-btn-danger"
                  onClick={async () => {
                    if (!memoriesPath) return
                    for (const m of memories) {
                      await window.api.memory.delete(m.id)
                    }
                    setMemories([])
                  }}
                >Очистить всё</button>
              </div>
            </>
          )}
        </div>
        )}

        {tab === 'appearance' && (
        <div className="gg-settings-extra">
          <div className="gg-settings-section-title">Тема оформления</div>
          <div className="gg-theme-toggle" role="group" style={{ marginBottom: 12 }}>
            <button
              type="button"
              className={`gg-theme-btn ${theme === 'dark' ? 'is-active' : ''}`}
              onClick={() => void setTheme('dark')}
            >
              <span aria-hidden>🌙</span> Тёмная
            </button>
            <button
              type="button"
              className={`gg-theme-btn ${theme === 'light' ? 'is-active' : ''}`}
              onClick={() => void setTheme('light')}
            >
              <span aria-hidden>☀</span> Светлая
            </button>
          </div>
          <div className="gg-settings-hint">
            Тема применяется мгновенно. Ширина боковой панели запоминается автоматически — потяни за её правый край.
          </div>
        </div>
        )}

          </div>{/* /gg-settings-content */}
        </div>{/* /gg-settings-shell */}

        <div className="gg-modal-footer">
          <button className="gg-btn gg-btn-ghost" onClick={onClose}>Закрыть</button>
          <button className="gg-btn gg-btn-primary" onClick={save}>
            {saved ? '✓ Сохранено' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// ProvidersPage — OpenCode Desktop-style: «Подключённые» (с бейджем + Отключить)
// + «Доступные» (карточки с кнопкой Подключить, раскрывается inline-форма с
// ключом / hint'ом). Источник провайдеров — массив PROVIDERS (тот же что в
// Models). «Подключение» = задание API-ключа; для CLI-провайдеров «подключение»
// = установка CLI вне приложения, мы только подтверждаем галкой.
// ════════════════════════════════════════════════════════════════════════════

interface ProvidersPageProps {
  providers: ProviderConfig[]
  keys: Record<string, string>
  setKeys: React.Dispatch<React.SetStateAction<Record<string, string>>>
  activeProvider: ProviderId
  setActiveProvider: (id: ProviderId) => void
  // Custom OpenAI-compatible настройки. Уникальный провайдер 'custom-openai'
  // имеет ещё 2 поля: baseUrl и список моделей через запятую.
  customOpenaiBaseUrl: string
  setCustomOpenaiBaseUrl: (v: string) => void
  customOpenaiModels: string
  setCustomOpenaiModels: (v: string) => void
}

function statusBadge(
  status: ConnectionStatus,
  transport: 'API' | 'CLI',
  providerId?: ProviderId,
  secretKey?: string | null,
  cliState?: { installed: boolean; loggedIn: boolean }
): { label: string; tone: 'ready' | 'cli' | 'missing'; title?: string } {
  if (transport === 'CLI') {
    if (!cliState) return { label: 'Среда', tone: 'cli', title: 'Загружаю статус…' }
    if (!cliState.installed) return { label: 'Не установлен', tone: 'missing', title: 'Бинарь CLI не найден в PATH' }
    if (cliState.loggedIn)   return { label: 'Залогинен', tone: 'ready', title: 'OAuth/API key найден локально' }
    return { label: 'Не залогинен', tone: 'missing', title: 'CLI установлен но credentials не найдены — нажми «Перелогиниться»' }
  }
  if (providerId === 'custom-openai') return { label: 'Custom URL', tone: 'ready' }
  if (!secretKey) return { label: 'Локально', tone: 'cli' } // Ollama-подобные
  if (status === 'ready')  return { label: 'API ключ', tone: 'ready' }
  return { label: 'Нет ключа', tone: 'missing' }
}

type CliId = 'claude-cli' | 'gemini-cli' | 'grok-cli' | 'codex-cli'
type CliStatusMap = Record<CliId, { installed: boolean; loggedIn: boolean; credPath?: string }>

function ProvidersPage(props: ProvidersPageProps) {
  const { providers, keys, setKeys, activeProvider, setActiveProvider,
          customOpenaiBaseUrl, setCustomOpenaiBaseUrl,
          customOpenaiModels, setCustomOpenaiModels } = props
  const [expanded, setExpanded] = useState<ProviderId | null>(null)
  // toast — короткое сообщение о результате logout/relogin. null = ничего.
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState<ProviderId | null>(null)
  // CLI статус: загружается при открытии страницы И после logout/relogin.
  // null = ещё не загружено (показываем "Среда" по дефолту).
  const [cliStatus, setCliStatus] = useState<CliStatusMap | null>(null)
  // Обнаруженные CLI-инструменты на компьютере пользователя.
  const [detectedClis, setDetectedClis] = useState<DetectedCli[] | null>(null)

  async function loadCliStatus() {
    try {
      const s = await window.api.cliAuth.statusAll()
      setCliStatus(s)
    } catch { /* не критично — оставим null, бейдж покажет fallback */ }
  }
  useEffect(() => {
    void loadCliStatus()
    window.api.cli.detect().then(setDetectedClis).catch(() => {})
  }, [])

  // «Подключён» = доступен для отправки запросов:
  //  - CLI: всегда (бинарь либо есть либо нет — реальный коннект сделает provider при send)
  //  - Локальный (без secretKey, НЕ CLI): Ollama и подобное — всегда доступен на localhost
  //  - custom-openai: главное чтобы baseUrl был задан, ключ опционален
  //  - Обычные API: должен быть введён secretKey
  function isConnected(p: ProviderConfig): boolean {
    if (p.transport === 'CLI') return true
    if (p.id === 'custom-openai') return customOpenaiBaseUrl.trim().length > 0
    if (!p.secretKey) return true
    return Boolean(keys[p.secretKey])
  }
  const connected = providers.filter(p => isConnected(p))
  const available = providers.filter(p => p.transport === 'API' && !isConnected(p))

  function showToast(kind: 'ok' | 'err', text: string) {
    setToast({ kind, text })
    setTimeout(() => setToast(null), 5000)
  }

  async function disconnect(p: ProviderConfig) {
    if (p.transport === 'CLI') {
      // CLI: реальный logout через child_process + удаление credentials.
      setBusy(p.id)
      try {
        const res = await window.api.cliAuth.logout(p.id)
        if (res.ok) {
          const fileCount = res.removedFiles.length
          showToast('ok',
            res.method === 'logout-cmd' ? `${p.name}: отключено через \`${p.id.split('-')[0]} logout\`` :
            res.method === 'both' ? `${p.name}: logout + удалено ${fileCount} файл(ов) credentials` :
            `${p.name}: удалено ${fileCount} файл(ов) credentials`
          )
        } else {
          showToast('err', res.message ?? `${p.name}: не удалось отключить`)
        }
      } catch (err) {
        showToast('err', `${p.name}: ошибка — ${(err as Error).message}`)
      } finally {
        setBusy(null)
        void loadCliStatus() // обновить бейдж после logout
      }
      return
    }
    // API: просто чистим ключ в state (save → SafeStorage)
    if (p.secretKey) {
      setKeys(k => {
        const next = { ...k }
        delete next[p.secretKey!]
        return next
      })
      showToast('ok', `${p.name}: ключ очищен. Не забудь нажать «Сохранить» внизу.`)
    }
    if (activeProvider === p.id) {
      const fallback = providers.find(x => x.id !== p.id && (x.transport === 'CLI' || (x.secretKey && keys[x.secretKey])))
      if (fallback) setActiveProvider(fallback.id)
    }
  }

  async function relogin(p: ProviderConfig) {
    if (p.transport !== 'CLI') return
    setBusy(p.id)
    try {
      const res = await window.api.cliAuth.relogin(p.id)
      if (res.ok) {
        showToast('ok', `${p.name}: открыл терминал для входа. Пройди OAuth в новом окне → вернись сюда.`)
      } else {
        showToast('err', res.message ?? `${p.name}: не удалось открыть терминал`)
      }
    } catch (err) {
      showToast('err', `${p.name}: ошибка — ${(err as Error).message}`)
    } finally {
      setBusy(null)
      // После relogin'а проверим статус — но не сразу, OAuth требует времени.
      // Шлём через 8 сек когда пользователь успел пройти браузер-flow.
      setTimeout(() => void loadCliStatus(), 8000)
    }
  }

  // Онбординг-баннер для нового пользователя без API ключей.
  // Если нет НИ ОДНОГО заданного API ключа среди API-провайдеров — показываем
  // явный hint что делать. CLI-провайдеры в учёт не идут: они через подписку
  // и могут быть «среда»/«залогинен», но без API-ключей агент в облачные
  // модели стрелять не сможет.
  const hasAnyApiKey = providers.some(p =>
    p.transport === 'API' && p.secretKey != null && Boolean(keys[p.secretKey])
  )
  // Custom-openai считаем «настроенным» если baseUrl задан, даже без ключа.
  const hasCustomConfigured = customOpenaiBaseUrl.trim().length > 0
  const showOnboardingHint = !hasAnyApiKey && !hasCustomConfigured

  return (
    <div className="gg-settings-extra gg-providers-page">
      <h2 className="gg-settings-page-title">Провайдеры</h2>

      {showOnboardingHint && (
        <div className="gg-prov-onboarding" role="alert">
          <div className="gg-prov-onboarding-icon" aria-hidden>👋</div>
          <div className="gg-prov-onboarding-body">
            <div className="gg-prov-onboarding-title">Добавьте хотя бы один API ключ чтобы начать</div>
            <div className="gg-prov-onboarding-text">
              Рекомендуем — <strong>Gemini API</strong> (есть бесплатный tier на
              {' '}<a href="https://aistudio.google.com" target="_blank" rel="noreferrer">aistudio.google.com</a>)
              или <strong>Claude API</strong> ({' '}<a href="https://console.anthropic.com" target="_blank" rel="noreferrer">console.anthropic.com</a>).
              Найди карточку ниже → «+ Подключить» → вставь ключ → «Сохранить».
              CLI-провайдеры (Claude Code, Gemini CLI и т.п.) — на твоей подписке, отдельная история.
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`gg-prov-toast is-${toast.kind}`} role="status">
          {toast.text}
        </div>
      )}

      <div className="gg-settings-section-title" style={{ marginTop: 8 }}>Подключённые провайдеры</div>
      <div className="gg-prov-list">
        {connected.length === 0 && (
          <div className="gg-text-tertiary" style={{ padding: 14, fontSize: 'var(--text-sm)' }}>
            Пока нет подключённых. Внизу — доступные.
          </div>
        )}
        {connected.map(p => {
          const status = connectionStatus(p.id, p.secretKey, keys)
          const cliState = (p.transport === 'CLI' && cliStatus)
            ? cliStatus[p.id as CliId]
            : undefined
          const badge = statusBadge(status, p.transport, p.id, p.secretKey, cliState)
          return (
            <div key={p.id} className="gg-prov-card">
              <div className="gg-prov-card-main">
                <div className="gg-prov-card-name">
                  {p.name}
                  <span className={`gg-prov-badge is-${badge.tone}`} title={badge.title}>{badge.label}</span>
                </div>
                <div className="gg-prov-card-desc">{p.description}</div>
              </div>
              <div className="gg-prov-card-actions">
                {p.transport === 'API' && (
                  <button
                    type="button"
                    className="gg-btn gg-btn-ghost"
                    onClick={() => setExpanded(expanded === p.id ? null : p.id)}
                  >{expanded === p.id ? 'Скрыть' : 'Изменить ключ'}</button>
                )}
                {p.transport === 'CLI' && (
                  <button
                    type="button"
                    className="gg-btn gg-btn-ghost"
                    onClick={() => void relogin(p)}
                    disabled={busy === p.id}
                    title="Открыть терминал и пройти OAuth по новой"
                  >{busy === p.id ? '…' : 'Перелогиниться'}</button>
                )}
                <button
                  type="button"
                  className="gg-btn gg-btn-ghost"
                  onClick={() => void disconnect(p)}
                  disabled={busy === p.id}
                  title={p.transport === 'CLI' ? 'Выйти из подписки: бежим `<cli> logout` + удаляем credentials-файлы' : 'Очистить API ключ из настроек'}
                >{busy === p.id ? '…' : 'Отключить'}</button>
              </div>
              {expanded === p.id && (
                <ProviderExpandForm
                  p={p}
                  keys={keys}
                  setKeys={setKeys}
                  customOpenaiBaseUrl={customOpenaiBaseUrl}
                  setCustomOpenaiBaseUrl={setCustomOpenaiBaseUrl}
                  customOpenaiModels={customOpenaiModels}
                  setCustomOpenaiModels={setCustomOpenaiModels}
                />
              )}
            </div>
          )
        })}
      </div>

      <div className="gg-settings-section-title" style={{ marginTop: 22 }}>Доступные провайдеры</div>
      <div className="gg-prov-list">
        {available.length === 0 && (
          <div className="gg-text-tertiary" style={{ padding: 14, fontSize: 'var(--text-sm)' }}>
            Все API-провайдеры подключены.
          </div>
        )}
        {available.map(p => (
          <div key={p.id} className="gg-prov-card">
            <div className="gg-prov-card-main">
              <div className="gg-prov-card-name">{p.name}<span className="gg-prov-badge is-recommended">Рекомендуемый</span></div>
              <div className="gg-prov-card-desc">{p.description}</div>
            </div>
            <div className="gg-prov-card-actions">
              <button
                type="button"
                className="gg-btn gg-btn-primary"
                onClick={() => setExpanded(p.id)}
              >+ Подключить</button>
            </div>
            {expanded === p.id && (
              <ProviderExpandForm
                p={p}
                keys={keys}
                setKeys={setKeys}
                customOpenaiBaseUrl={customOpenaiBaseUrl}
                setCustomOpenaiBaseUrl={setCustomOpenaiBaseUrl}
                customOpenaiModels={customOpenaiModels}
                setCustomOpenaiModels={setCustomOpenaiModels}
                hint="Нажми «Сохранить» внизу — провайдер появится в подключённых."
              />
            )}
          </div>
        ))}
      </div>

      <div className="gg-settings-hint" style={{ marginTop: 18 }}>
        CLI-провайдеры (Gemini CLI / Claude Code / Grok Build / Codex) подключаются установкой соответствующего CLI вне приложения и логином через подписку. После этого они появляются как «Среда».
      </div>

      {detectedClis !== null && detectedClis.length > 0 && (
        <div className="gg-prov-detected">
          <div className="gg-settings-section-title" style={{ marginTop: 22 }}>Обнаруженные CLI</div>
          <div className="gg-prov-detected-list">
            {detectedClis.map(c => (
              <div key={c.id} className="gg-prov-detected-item">
                <span className={`gg-prov-detected-dot${c.status === 'found' ? ' is-yellow' : ''}`} />
                <span className="gg-prov-detected-name">{c.name}</span>
                <span className="gg-prov-detected-version">{c.version}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Универсальный expand-блок для карточки провайдера: API ключ + (для custom-openai)
 * Base URL и список моделей. Выделен в отдельный компонент чтобы не дублировать
 * между «Подключёнными» и «Доступными» секциями.
 */
interface ProviderExpandFormProps {
  p: ProviderConfig
  keys: Record<string, string>
  setKeys: React.Dispatch<React.SetStateAction<Record<string, string>>>
  customOpenaiBaseUrl: string
  setCustomOpenaiBaseUrl: (v: string) => void
  customOpenaiModels: string
  setCustomOpenaiModels: (v: string) => void
  /** Опциональный hint снизу (например, «Нажми Сохранить» для доступных). */
  hint?: string
}

function ProviderExpandForm(props: ProviderExpandFormProps) {
  const { p, keys, setKeys, customOpenaiBaseUrl, setCustomOpenaiBaseUrl,
          customOpenaiModels, setCustomOpenaiModels, hint } = props
  const isCustom = p.id === 'custom-openai'
  const isYandex = p.id === 'yandex-gpt'
  const isGigaChat = p.id === 'gigachat'

  return (
    <div className="gg-prov-card-expand">
      {isYandex && (
        <>
          <div className="gg-label">Folder ID</div>
          <input
            className="gg-input"
            value={keys['yandex_folder_id'] ?? ''}
            onChange={e => setKeys(k => ({ ...k, yandex_folder_id: e.target.value }))}
            placeholder="b1g…"
            spellCheck={false}
            autoFocus
          />
          <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 4, marginBottom: 10 }}>
            Yandex Cloud Console → выбери каталог → ID в адресной строке.
            Хранится зашифрованно через safeStorage.
          </div>
        </>
      )}

      {isGigaChat && (
        <>
          <div className="gg-label">Client Secret</div>
          <input
            className="gg-input"
            type="password"
            value={keys['gigachat_client_secret'] ?? ''}
            onChange={e => setKeys(k => ({ ...k, gigachat_client_secret: e.target.value }))}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            autoFocus
          />
          <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 4, marginBottom: 10 }}>
            ⚠ GigaChat использует сертификат Сбера (Russian Trusted Root CA), которого
            нет в стандартном trust store Node.js. Соединение зашифровано TLS, но
            CA не проверяется. В следующей версии добавим bundle Russian Trusted CA.
          </div>
        </>
      )}

      {isCustom && (
        <>
          <div className="gg-label">Base URL</div>
          <input
            className="gg-input"
            value={customOpenaiBaseUrl}
            onChange={e => setCustomOpenaiBaseUrl(e.target.value)}
            placeholder="https://my-endpoint.local/v1 или http://localhost:8000/v1"
            spellCheck={false}
            autoFocus
          />
          <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 4, marginBottom: 10 }}>
            Любой OpenAI-compatible endpoint: vLLM, LM Studio, Text Generation WebUI, корпоративный шлюз.
          </div>

          <div className="gg-label">Модели (через запятую)</div>
          <input
            className="gg-input"
            value={customOpenaiModels}
            onChange={e => setCustomOpenaiModels(e.target.value)}
            placeholder="qwen2.5-72b-instruct, llama-3.3-70b, mistral-large"
            spellCheck={false}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}
          />
          <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 4, marginBottom: 10 }}>
            Список ID моделей которые твой endpoint умеет (то что идёт в параметре <code>model</code> запроса).
          </div>
        </>
      )}

      {p.secretKey && (
        <>
          <div className="gg-label">{isCustom ? 'API ключ (если endpoint требует)' : 'API ключ'}</div>
          <input
            className="gg-input"
            type="password"
            value={keys[p.secretKey] ?? ''}
            onChange={e => setKeys(k => ({ ...k, [p.secretKey!]: e.target.value }))}
            placeholder={p.keyHint}
            autoFocus={!isCustom}
          />
          {p.keyLink && (
            <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 6 }}>
              Получить ключ: <a href={p.keyLink.url} target="_blank" rel="noreferrer">{p.keyLink.label}</a>. Хранится зашифрованно через safeStorage.
            </div>
          )}
        </>
      )}

      {!p.secretKey && !isCustom && (
        <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)' }}>
          Ключ не нужен — это локальный/embedded провайдер. Нажми «Сохранить» внизу чтобы активировать.
        </div>
      )}

      {hint && (
        <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 8 }}>
          {hint}
        </div>
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// ModelsPage — OpenCode Desktop-style: поиск + группировка по провайдеру +
// toggle per-модель. Toggle сохраняется в enabled_models — это управляет тем,
// какие модели появляются в чат-picker'е. Все включены по умолчанию.
// ════════════════════════════════════════════════════════════════════════════

interface ModelsPageProps {
  providers: ProviderConfig[]
  enabledModels: Set<string>
  setEnabledModels: React.Dispatch<React.SetStateAction<Set<string>>>
  models: Record<string, string>
  setModels: React.Dispatch<React.SetStateAction<Record<string, string>>>
  activeProvider: ProviderId
  setActiveProvider: (id: ProviderId) => void
  keys: Record<string, string>
}

function ModelsPage(props: ModelsPageProps) {
  const { providers, enabledModels, setEnabledModels, models, setModels, activeProvider, setActiveProvider, keys } = props
  const [search, setSearch] = useState('')

  // Каталог нужен только для метаданных (теги, цена); группировка по providerId.
  const catalog = useMemo(() => buildCatalog(providers), [providers])
  const grouped = useMemo(() => {
    const map = new Map<ProviderId, typeof catalog>()
    const t = search.trim().toLowerCase()
    for (const e of catalog) {
      if (t && !`${e.model} ${e.providerName}`.toLowerCase().includes(t)) continue
      const list = map.get(e.providerId) ?? []
      list.push(e)
      map.set(e.providerId, list)
    }
    return map
  }, [catalog, search])

  function toggle(key: string) {
    setEnabledModels(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function setDefault(providerId: ProviderId, model: string) {
    setActiveProvider(providerId)
    setModels(m => ({ ...m, [providerId]: model }))
  }

  return (
    <div className="gg-settings-extra gg-models-page">
      <h2 className="gg-settings-page-title">Модели</h2>

      <div className="gg-models-search-wrap">
        <input
          className="gg-input gg-models-search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="🔎 Поиск моделей"
          spellCheck={false}
        />
      </div>

      {providers.map(p => {
        const list = grouped.get(p.id)
        if (!list || list.length === 0) return null
        const status = connectionStatus(p.id, p.secretKey, keys)
        const isProviderReady = status === 'ready' || status === 'unknown' // unknown = CLI
        return (
          <div key={p.id} className="gg-models-group">
            <div className="gg-models-group-head">
              <span className="gg-models-group-name">{p.name}</span>
              {!isProviderReady && (
                <span className="gg-models-group-warn">нет ключа — подключи на вкладке «Провайдеры»</span>
              )}
            </div>
            <div className="gg-models-group-list">
              {list.map(e => {
                const enabled = enabledModels.has(e.key)
                const isDefault = activeProvider === p.id && (models[p.id] ?? p.defaultModel) === e.model
                return (
                  <div key={e.key} className={`gg-models-row ${enabled ? 'is-on' : ''}`}>
                    <button
                      type="button"
                      className="gg-models-row-main"
                      onClick={() => setDefault(p.id, e.model)}
                      title="Сделать активной моделью для этого провайдера"
                    >
                      <span className="gg-models-row-name">{e.model}</span>
                      {isDefault && <span className="gg-models-row-default">по умолчанию</span>}
                      <span className="gg-models-row-tags">
                        {e.tags.map(t => (
                          <span key={t} className={`gg-mpal-tag is-${t.toLowerCase().replace(/\$/g, 'd')}`}>{t}</span>
                        ))}
                      </span>
                    </button>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      className={`gg-toggle ${enabled ? 'is-on' : ''}`}
                      onClick={() => toggle(e.key)}
                      title={enabled ? 'Отключить из picker’а' : 'Включить в picker'}
                    >
                      <span className="gg-toggle-knob" />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {grouped.size === 0 && (
        <div className="gg-text-tertiary" style={{ padding: 18, textAlign: 'center', fontSize: 'var(--text-sm)' }}>
          Ничего не найдено
        </div>
      )}

      <div className="gg-settings-hint" style={{ marginTop: 16 }}>
        Toggle справа управляет тем, какие модели появляются в picker’е чата.
        Клик по строке делает модель дефолтом провайдера и переключает активного провайдера.
        Поиск работает по имени модели и провайдера.
      </div>
    </div>
  )
}
