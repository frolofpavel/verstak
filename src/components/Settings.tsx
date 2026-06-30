import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { useProject } from '../store/projectStore'
import type { Memory, DetectedCli, AuditEntry, PolicyMatrixDTO, PolicyDecision, AgentModeId } from '../types/api'
import type { ProviderId } from '../hooks/useProvider'
import { useTheme, THEMES } from '../hooks/useTheme'
import { useUiScale, UI_SCALE_PRESETS, MIN_UI_SCALE_PERCENT, MAX_UI_SCALE_PERCENT } from '../hooks/useUiScale'
import { useNotifySettings } from '../hooks/useNotifySettings'
import { UpdatesSettings } from './UpdatesSettings'
import type { AutonomousStatus } from '../types/api'
import { ProfilesTab } from './ProfilesTab'
import {
  buildCatalog,
  connectionStatus,
  isProviderAuthorized,
  providerAuthLink,
  type CliAuthId,
  type CliAuthStatus,
  type ConnectionStatus
} from '../lib/model-catalog'
import {
  IconClaude, Icon1C, IconGoogleSheets, IconTelegram,
  IconSSH, IconBitrix, IconYandexDirect, IconYandexDisk,
  IconSkillsServer, IconPlug, IconHTTP, IconGitHub, IconSocialPublish
} from './ConnectorIcons'
import { useT } from '../i18n'
import { classifyTool, classifyServer, type McpScope, type McpRisk } from '../lib/mcp-risk'
import { modeModelsKey, parseModeModels, serializeModeModels } from '../lib/mode-model'
import type { AgentMode } from './ModePicker'

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
  // ⭐ Рекомендуемый провайдер — наш собственный шлюз. Первым в списке.
  {
    id: 'verstak-gateway',
    name: 'Verstak Gateway',
    transport: 'API',
    description: 'Рекомендуем. Единый AI-баланс Verstak: рубли, без чужих карт и VPN. Один ключ → понятные пресеты (Эконом / Баланс / Кодинг / Длинный / Быстрый / Приватный). Как подключить: открой agi-iri.ru/gateway → зарегистрируйся → создай ключ → вставь его сюда.',
    models: ['verstak/economy', 'verstak/balanced', 'verstak/coder', 'verstak/long', 'verstak/fast', 'verstak/private'],
    defaultModel: 'verstak/balanced',
    secretKey: 'verstak_gateway_api_key',
    keyHint: 'vsk_live_...',
    keyLink: { url: 'https://agi-iri.ru/gateway/', label: 'agi-iri.ru/gateway' },
    supportsTools: true
  },
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
  // (Verstak Gateway вынесен в начало списка — рекомендуемый.)
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
    description: 'Китайские модели V4 за копейки. v4-flash / v4-pro (reasoning). Лучший fallback для бюджета.',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-v4-flash',
    secretKey: 'deepseek_api_key',
    keyHint: 'sk-...',
    keyLink: { url: 'https://platform.deepseek.com/api_keys', label: 'platform.deepseek.com' },
    supportsTools: true
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    transport: 'API',
    description: 'Китайский Kimi K2.6 — SoTA по агентам и коду. Дёшево, длинный контекст, OpenAI-совместим.',
    models: ['kimi-k2.6', 'kimi-k2.5', 'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'],
    defaultModel: 'kimi-k2.6',
    secretKey: 'moonshot_api_key',
    keyHint: 'sk-...',
    keyLink: { url: 'https://platform.moonshot.ai/console/api-keys', label: 'platform.moonshot.ai' },
    supportsTools: true
  },
  {
    id: 'qwen',
    name: 'Qwen (Alibaba)',
    transport: 'API',
    description: 'Alibaba Qwen3 через DashScope. qwen3-coder-plus — кодер, qwen3-max — флагман. OpenAI-совместим.',
    models: ['qwen3-max', 'qwen3-coder-plus', 'qwen3-coder-flash', 'qwen-max', 'qwen-plus', 'qwen-flash'],
    defaultModel: 'qwen3-coder-plus',
    secretKey: 'qwen_api_key',
    keyHint: 'sk-...',
    keyLink: { url: 'https://bailian.console.aliyun.com/', label: 'bailian.console.aliyun.com' },
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

type Tab = 'appearance' | 'notifications' | 'updates' | 'profiles' | 'providers' | 'models' | 'connectors' | 'autonomous' | 'memory' | 'mcp' | 'audit' | 'policy'

// TAB_GROUPS is built inside the Settings component to support i18n translations.

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

/** По умолчанию включена только модель активного провайдера (как при первом входе). */
function defaultEnabledModels(providerId: ProviderId, modelVals: Record<string, string>): Set<string> {
  const p = PROVIDERS.find(x => x.id === providerId)
  if (!p || p.models.length === 0) return new Set()
  const model = modelVals[providerId] ?? p.defaultModel
  return new Set([modelKey(providerId, model)])
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
  { id: 'social-publish', name: 'Social Publish', description: 'Постинг в Telegram, VK, webhooks', icon: IconSocialPublish, configuredKey: 'social_publish_telegram_channels' },
  { id: 'dadata', name: 'DaData', description: 'Контрагенты по ИНН, адреса, банки', icon: IconHTTP, configuredKey: 'dadata_api_key' },
  { id: 'ymetrika', name: 'Яндекс.Метрика', description: 'Веб-аналитика: трафик, источники, цели', icon: IconYandexDirect, configuredKey: 'yandex_metrika_token' },
  { id: 'avito', name: 'Avito', description: 'Объявления, статистика, баланс', icon: IconHTTP, configuredKey: 'avito_client_id' },
  { id: 'ywebmaster', name: 'Яндекс.Вебмастер', description: 'SEO: ИКС, проблемы, запросы', icon: IconYandexDirect, configuredKey: 'yandex_webmaster_token' },
  { id: 'ywordstat', name: 'Яндекс.Wordstat', description: 'Частотность ключевых слов', icon: IconYandexDirect, configuredKey: 'yandex_wordstat_token' },
  { id: 'ozon', name: 'Ozon Seller', description: 'Товары, остатки, аналитика, финансы', icon: IconHTTP, configuredKey: 'ozon_client_id' },
  { id: 'wildberries', name: 'Wildberries', description: 'Продажи, заказы, остатки', icon: IconHTTP, configuredKey: 'wildberries_token' },
  { id: 'yookassa', name: 'ЮКасса', description: 'Платежи и возвраты (чтение)', icon: IconHTTP, configuredKey: 'yookassa_shop_id' },
  { id: 'vk', name: 'VK', description: 'Сообщества, стена, пользователи', icon: IconHTTP, configuredKey: 'vk_access_token' },
  { id: 'amocrm', name: 'amoCRM', description: 'Сделки, контакты, воронки', icon: IconHTTP, configuredKey: 'amocrm_subdomain' },
  { id: 'moysklad', name: 'МойСклад', description: 'Товары, заказы, остатки', icon: IconHTTP, configuredKey: 'moysklad_token' },
  { id: 'yandex_tracker', name: 'Яндекс.Трекер', description: 'Задачи, очереди', icon: IconYandexDirect, configuredKey: 'yandex_tracker_token' },
  { id: 'sendpulse', name: 'SendPulse', description: 'Email/SMS-рассылки', icon: IconHTTP, configuredKey: 'sendpulse_client_id' },
  { id: 'unisender', name: 'UniSender', description: 'Email/SMS-рассылки', icon: IconHTTP, configuredKey: 'unisender_api_key' },
  { id: 'ga4', name: 'Google Analytics 4', description: 'Веб-аналитика', icon: IconHTTP, configuredKey: 'ga4_access_token' },
  { id: 'notion', name: 'Notion', description: 'Базы, страницы, поиск', icon: IconHTTP, configuredKey: 'notion_token' },
  { id: 'kontur_focus', name: 'Контур.Фокус', description: 'Контрагенты, риск-аналитика', icon: IconHTTP, configuredKey: 'kontur_focus_api_key' },
  { id: 'mpstats', name: 'MPSTATS', description: 'Аналитика маркетплейсов', icon: IconHTTP, configuredKey: 'mpstats_token' },
  { id: 'ozon_performance', name: 'Ozon Performance', description: 'Реклама Ozon', icon: IconHTTP, configuredKey: 'ozon_perf_client_id' },
  { id: 'jira', name: 'Jira', description: 'Задачи, проекты, JQL', icon: IconHTTP, configuredKey: 'jira_base_url' },
  { id: 'trello', name: 'Trello', description: 'Доски, списки, карточки', icon: IconHTTP, configuredKey: 'trello_api_key' },
]

// ─── MCP Tab ─────────────────────────────────────────────────────────────────

import type { McpServerEntry, McpTool, PopularMcpServer } from '../types/api'

// ── MCP Hardening — review-before-trust helpers ──────────────────────────────

/** Бейдж scope: иконка + русская подпись + класс цвета. */
const SCOPE_META: Record<McpScope, { icon: string; label: string }> = {
  read:    { icon: '🟢', label: 'чтение' },
  write:   { icon: '🟡', label: 'запись' },
  network: { icon: '🌐', label: 'сеть' },
  command: { icon: '🔴', label: 'команда' },
  unknown: { icon: '⚪', label: 'неизвестно' }
}

/** Человекочитаемая сводка по scope-ам сервера, напр. «3 чтение · 2 запись · 1 команда». */
function scopeSummary(scopes: Record<McpScope, number>): string {
  const order: McpScope[] = ['read', 'write', 'network', 'command', 'unknown']
  return order
    .filter(s => scopes[s] > 0)
    .map(s => `${scopes[s]} ${SCOPE_META[s].label}`)
    .join(' · ')
}

/** Манифест сервера, собранный после connect + классификации. */
interface McpManifest {
  tools: Array<McpTool & { scope: McpScope }>
  risk: McpRisk
  scopes: Record<McpScope, number>
  toolCount: number
  /** Имена env-переменных из конфига сервера + флаг «пусто». */
  env: Array<{ key: string; empty: boolean }>
}

/** Парсит env-JSON сервера в список требований. */
function parseEnvRequirements(envJson: string): Array<{ key: string; empty: boolean }> {
  try {
    const obj = JSON.parse(envJson || '{}') as Record<string, unknown>
    return Object.keys(obj).map(key => ({
      key,
      empty: !String(obj[key] ?? '').trim()
    }))
  } catch {
    return []
  }
}

// === Policy Center ===
// Read-only экран «что разрешено агенту»: матрица decide(tool, mode) по 5 режимам
// + опасные команды. Логика НЕ дублируется — данные приходят из policy:matrix.

const POLICY_CATEGORY_LABELS: Record<string, string> = {
  read: 'Чтение',
  edit: 'Правка файлов',
  command: 'Команды',
  connector: 'Коннекторы'
}

const POLICY_DECISION_META: Record<PolicyDecision, { label: string; cls: string }> = {
  'auto-accept': { label: 'авто',   cls: 'auto' },
  'confirm':     { label: 'спросит', cls: 'confirm' },
  'block':       { label: 'блок',   cls: 'block' }
}

function PolicyTab() {
  const [matrix, setMatrix] = useState<PolicyMatrixDTO | null>(null)
  const [currentMode, setCurrentMode] = useState<AgentModeId | null>(null)
  const [dodMode, setDodMode] = useState<string>('warn')
  const [allowlist, setAllowlist] = useState<string>('')
  const [planGate, setPlanGate] = useState(false)
  const [autoEdits, setAutoEdits] = useState(false)
  const [autoCommands, setAutoCommands] = useState(false)
  const [hooksOn, setHooksOn] = useState(false)
  const [outputStyle, setOutputStyle] = useState('default')

  useEffect(() => {
    void (async () => {
      const m = await window.api.policy.matrix()
      setMatrix(m)
      const mode = await window.api.settings.getKey('agent_mode')
      setCurrentMode((mode as AgentModeId) || 'ask')
      const dm = await window.api.settings.getKey('dod_mode')
      setDodMode(dm || 'warn')
      const al = await window.api.settings.getKey('bash_allowlist')
      setAllowlist(al || '')
      const pg = await window.api.settings.getKey('plan_approval_gate')
      setPlanGate(pg === 'true')
      setAutoEdits((await window.api.settings.getKey('auto_approve_edits')) === 'true')
      setAutoCommands((await window.api.settings.getKey('auto_approve_commands')) === 'true')
      setHooksOn((await window.api.settings.getKey('hooks_enabled')) === 'true')
      setOutputStyle((await window.api.settings.getKey('output_style')) || 'default')
    })()
  }, [])

  const changeAutoEdits = async (v: boolean) => { setAutoEdits(v); await window.api.settings.setKey('auto_approve_edits', v ? 'true' : 'false') }
  const changeAutoCommands = async (v: boolean) => { setAutoCommands(v); await window.api.settings.setKey('auto_approve_commands', v ? 'true' : 'false') }
  const changeHooks = async (v: boolean) => { setHooksOn(v); await window.api.settings.setKey('hooks_enabled', v ? 'true' : 'false') }
  const changeOutputStyle = async (v: string) => { setOutputStyle(v); await window.api.settings.setKey('output_style', v) }

  const changeDod = async (v: string) => {
    setDodMode(v)
    await window.api.settings.setKey('dod_mode', v)
  }

  const changePlanGate = async (v: boolean) => {
    setPlanGate(v)
    await window.api.settings.setKey('plan_approval_gate', v ? 'true' : 'false')
  }

  const changeAllowlist = async (v: string) => {
    setAllowlist(v)
    await window.api.settings.setKey('bash_allowlist', v)
  }

  if (!matrix) {
    return <div className="gg-settings-extra"><div className="gg-settings-hint">Загрузка политики…</div></div>
  }

  return (
    <div className="gg-settings-extra gg-policy">
      <div className="gg-settings-section-title">🛡 Что разрешено агенту</div>
      <div className="gg-settings-hint" style={{ marginBottom: 14 }}>
        Единое окно контроля: как разрешается каждое действие агента в зависимости от активного режима.
        Чтение всегда разрешено. Правки файлов и команды гейтятся режимом. Текущий режим подсвечен.
      </div>

      <div className="gg-policy-matrix-wrap">
        <table className="gg-policy-matrix">
          <thead>
            <tr>
              <th className="gg-policy-cat-head">Действие</th>
              {matrix.modes.map(m => (
                <th
                  key={m.id}
                  className={m.id === currentMode ? 'gg-policy-mode-current' : undefined}
                  title={m.description}
                >
                  <span className="gg-policy-mode-icon">{m.icon}</span>
                  <span className="gg-policy-mode-label">{m.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map(row => (
              <tr key={row.tool}>
                <td className="gg-policy-cat">
                  <span className="gg-policy-cat-name">{POLICY_CATEGORY_LABELS[row.category] || row.category}</span>
                  <code className="gg-policy-tool">{row.tool}</code>
                </td>
                {matrix.modes.map(m => {
                  const dec = row.decisions[m.id]
                  const meta = POLICY_DECISION_META[dec]
                  return (
                    <td
                      key={m.id}
                      className={m.id === currentMode ? 'gg-policy-mode-current' : undefined}
                    >
                      <span className={`gg-policy-chip ${meta.cls}`}>{meta.label}</span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="gg-policy-legend">
        <span className="gg-policy-chip auto">авто</span> — выполняется сразу, без диалога
        <span className="gg-policy-chip confirm">спросит</span> — покажет diff / команду и ждёт подтверждения
        <span className="gg-policy-chip block">блок</span> — действие запрещено активным режимом
      </div>

      <div className="gg-settings-section-title" style={{ marginTop: 22 }}>⛔ Опасные команды</div>
      <div className="gg-settings-hint" style={{ marginBottom: 10 }}>
        Эти команды блокируются <strong>всегда</strong> — даже с подтверждением и в режиме «Без подтверждений».
        Денилист — последний предохранитель.
      </div>
      <ul className="gg-policy-danger">
        {matrix.commandDanger.map((d, i) => (
          <li key={i}>{d}</li>
        ))}
      </ul>

      <div className="gg-settings-section-title" style={{ marginTop: 22 }}>✅ Доверенные команды (allowlist)</div>
      <div className="gg-settings-hint" style={{ marginBottom: 10 }}>
        По одной на строку. Команды, начинающиеся с этих префиксов, выполняются <strong>без подтверждения</strong> в режиме «Спрашивать» (рутина: <code>git status</code>, <code>npm test</code>). Денилист срабатывает первым; команды с цепочками/подстановками (<code>&amp;&amp;</code>, <code>|</code>, <code>$(…)</code>) и флагами-эскалаторами (<code>git -c</code>, <code>--pager</code>, <code>npm run</code>) НЕ авто-аппрувятся. <strong>Добавляй только команды, которым доверяешь полностью</strong> — обёртки вроде git/npm могут исполнять код через флаги.
      </div>
      <textarea
        className="gg-input"
        value={allowlist}
        onChange={e => void changeAllowlist(e.target.value)}
        placeholder={'git status\nnpm test\nls'}
        spellCheck={false}
        rows={4}
        style={{ maxWidth: 420, fontFamily: 'var(--font-mono)', fontSize: '12px' }}
      />

      <div className="gg-settings-section-title" style={{ marginTop: 22 }}>✅ Доказательство выполнения (DoD)</div>
      <div className="gg-settings-hint" style={{ marginBottom: 10 }}>
        Гейт коммита dev-задачи при не-зелёных проверках. <strong>Предупреждать</strong> — блок с возможностью обойти (причина пишется в журнал аудита). <strong>Обязательно</strong> — обход запрещён, коммит только при зелёных проверках. <strong>Выкл</strong> — без гейта.
      </div>
      <select className="gg-input" value={dodMode} onChange={e => void changeDod(e.target.value)} style={{ maxWidth: 320 }}>
        <option value="warn">Предупреждать (по умолчанию)</option>
        <option value="block">Обязательно (Mandatory DoD)</option>
        <option value="off">Выкл</option>
      </select>

      <div className="gg-settings-section-title" style={{ marginTop: 22 }}>📋 Одобрение плана перед выполнением</div>
      <div className="gg-settings-hint" style={{ marginBottom: 10 }}>
        В режиме планирования агент предлагает план и <strong>блокируется до твоего решения</strong>: Одобрить (→ выполнение), Доработать (с замечаниями) или Отклонить. Высокий контроль — человек одобряет план ДО старта. По умолчанию выкл (агент просто составляет план, режим переключаешь сам).
      </div>
      <label className="gg-theme-square">
        <input type="checkbox" checked={planGate} onChange={e => void changePlanGate(e.target.checked)} />
        <span>Блокировать-и-ждать одобрения плана (Approve / Revise / Reject)</span>
      </label>

      <div className="gg-settings-section-title" style={{ marginTop: 22 }}>⚙ Авто-одобрение по категориям</div>
      <div className="gg-settings-hint" style={{ marginBottom: 10 }}>
        Гранулярный контроль поверх режима: доверяй отдельной категории, не переходя в полный «Авто/Без подтверждений». Подтверждение пропускается только для включённой категории; <strong>режим планирования всё равно блокирует</strong>.
      </div>
      <label className="gg-theme-square">
        <input type="checkbox" checked={autoEdits} onChange={e => void changeAutoEdits(e.target.checked)} />
        <span>Авто-принимать правки файлов (write/apply_patch) — без модалки diff</span>
      </label>
      <label className="gg-theme-square">
        <input type="checkbox" checked={autoCommands} onChange={e => void changeAutoCommands(e.target.checked)} />
        <span>Авто-принимать команды (run_command / коннекторы / execute_code) — осторожно</span>
      </label>

      <div className="gg-settings-section-title" style={{ marginTop: 22 }}>🎭 Стиль ответа агента</div>
      <div className="gg-settings-hint" style={{ marginBottom: 10 }}>
        Как агент <strong>форматирует и подаёт</strong> ответ — отдельно от режима правок. «Обычный» — без надстройки. Свои стили: <code>.md</code> в <code>~/.verstak/output-styles/</code> (frontmatter name/description, тело — инструкция), указывай id <code>user:имя</code>.
      </div>
      <select className="gg-input" value={outputStyle} onChange={e => void changeOutputStyle(e.target.value)} style={{ maxWidth: 320 }}>
        <option value="default">Обычный (по умолчанию)</option>
        <option value="concise">Кратко</option>
        <option value="explanatory">С пояснениями</option>
        <option value="formal">Деловой</option>
        <option value="bullet">Только списки</option>
      </select>

      <div className="gg-settings-section-title" style={{ marginTop: 22 }}>📐 Правила доступа (permissions)</div>
      <div className="gg-settings-hint" style={{ marginBottom: 10 }}>
        Декларативные правила <strong>allow / deny / ask</strong> по паттернам поверх режима — тонкая автономность без переключения всего режима. Файл <code>.verstak/permissions.json</code> (в проекте) или <code>~/.verstak/permissions.json</code> (глобально). Применяются <strong>всегда</strong>, как только файл есть. Приоритет: <strong>deny &gt; ask &gt; allow</strong>; <code>deny</code> блокирует даже в «Без подтверждений», правила <strong>не ослабляют</strong> режим планирования.
        <pre style={{ background: 'var(--bg-elev)', padding: 8, borderRadius: 6, fontSize: 11, marginTop: 8, overflowX: 'auto' }}>{`{
  "allow": ["Bash(npm:*)", "Read(src/**)"],
  "ask":   ["Bash(git push:*)"],
  "deny":  ["Bash(rm:*)", "Read(*.env)"]
}`}</pre>
      </div>

      <div className="gg-settings-section-title" style={{ marginTop: 22 }}>🪝 Хуки жизненного цикла (hooks)</div>
      <div className="gg-settings-hint" style={{ marginBottom: 10 }}>
        Свои скрипты на события агента (<code>PreToolUse</code> / <code>PostToolUse</code> / <code>SessionStart</code> / <code>Stop</code> / <code>UserPromptSubmit</code>) — детерминированный контроль <strong>вне модели</strong>: блокировать вызов (<code>PreToolUse</code> exit 2), линтить после правки, инжектить контекст. Конфиг <code>.verstak/hooks.json</code> (проект) или <code>~/.verstak/hooks.json</code> (глобально). <strong>⚠ Хуки исполняют произвольные shell-команды из конфига проекта</strong> — включай только если доверяешь проекту. По умолчанию выключено.
        <pre style={{ background: 'var(--bg-elev)', padding: 8, borderRadius: 6, fontSize: 11, marginTop: 8, overflowX: 'auto' }}>{`{
  "PreToolUse": [{ "matcher": "run_command", "command": "node guard.js" }],
  "PostToolUse": [{ "matcher": "write_file", "command": "npm run lint" }]
}`}</pre>
      </div>
      <label className="gg-theme-square">
        <input type="checkbox" checked={hooksOn} onChange={e => void changeHooks(e.target.checked)} />
        <span>Включить пользовательские хуки (исполнение скриптов на события — доверенные проекты)</span>
      </label>

      <div className="gg-policy-note" style={{ marginTop: 18 }}>
        Риск по конкретным MCP-инструментам (per-server) — на вкладке <strong>MCP</strong>. Здесь он не дублируется.
      </div>
    </div>
  )
}

// ось 3 A: привязка модели к режиму агента (авто-своп при 1-5). Self-contained.
const MODE_BIND_ROWS: { mode: AgentMode; label: string }[] = [
  { mode: 'plan', label: '📋 Планирование' },
  { mode: 'accept-edits', label: '✏ Правки' },
  { mode: 'auto', label: '⚡ Авто' },
]

function ModeModelBinding({ providers }: { providers: ProviderConfig[] }) {
  const [providerId, setProviderId] = useState<string>(providers[0]?.id ?? '')
  const [map, setMap] = useState<Record<string, string>>({})
  const provider = providers.find(p => p.id === providerId)

  useEffect(() => {
    void (async () => setMap(parseModeModels(await window.api.settings.getKey(modeModelsKey(providerId)))))()
  }, [providerId])

  const update = async (mode: string, model: string) => {
    const next = { ...map }
    if (model) next[mode] = model; else delete next[mode]
    setMap(next)
    await window.api.settings.setKey(modeModelsKey(providerId), serializeModeModels(next))
  }

  return (
    <div className="gg-settings-section" style={{ marginTop: 24 }}>
      <div className="gg-settings-section-title">🎚 Модель по режиму (авто-своп при 1-5)</div>
      <div className="gg-settings-hint" style={{ marginBottom: 12 }}>
        Привяжи модель к режиму: при переключении (клавиши 1-5 или пикер) модель сменится сама —
        например план на сильной reasoning-модели, авто-кодинг на дешёвой. «не менять» = режим не трогает модель.
      </div>
      <div className="gg-settings-row">
        <label className="gg-settings-label">Провайдер</label>
        <select className="gg-input" value={providerId} onChange={e => setProviderId(e.target.value)}>
          {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      {MODE_BIND_ROWS.map(r => (
        <div className="gg-settings-row" key={r.mode}>
          <label className="gg-settings-label">{r.label}</label>
          <select className="gg-input" value={map[r.mode] ?? ''} onChange={e => void update(r.mode, e.target.value)}>
            <option value="">— не менять —</option>
            {(provider?.models ?? []).map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      ))}
    </div>
  )
}

function McpTab() {
  const [servers, setServers] = useState<McpServerEntry[]>([])
  const [connectedIds, setConnectedIds] = useState<Set<string>>(new Set())
  const [toolCounts, setToolCounts] = useState<Record<string, number>>({})
  const [showAdd, setShowAdd] = useState(false)
  const [popular, setPopular] = useState<PopularMcpServer[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newForm, setNewForm] = useState({ name: '', command: '', args: '', env: '' })
  // MCP Hardening — превью манифеста сервера (review-before-trust).
  const [manifests, setManifests] = useState<Record<string, McpManifest>>({})
  const [previewBusy, setPreviewBusy] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<Record<string, string>>({})
  // #2: per-tool override scope гейтинга (JSON {toolName: read|write|command|network}).
  const [scopeOverrides, setScopeOverrides] = useState('')

  useEffect(() => {
    void loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadAll() {
    try {
      const [svrs, tools, pop] = await Promise.all([
        window.api.mcp.listServers(),
        window.api.mcp.tools(),
        window.api.mcp.popular()
      ])
      setServers(svrs)
      setPopular(pop)
      const ids = new Set<string>()
      const counts: Record<string, number> = {}
      for (const t of tools as McpTool[]) {
        ids.add(t.serverId)
        counts[t.serverId] = (counts[t.serverId] ?? 0) + 1
      }
      setConnectedIds(ids)
      setToolCounts(counts)
      const ov = await window.api.settings.getKey('mcp_scope_overrides')
      setScopeOverrides(ov || '')
    } catch { /* ignore */ }
  }

  const saveScopeOverrides = async (v: string) => {
    setScopeOverrides(v)
    await window.api.settings.setKey('mcp_scope_overrides', v)
  }

  async function handleConnect(id: string) {
    setBusy(id); setError(null)
    try {
      const tools = await window.api.mcp.connect(id) as McpTool[]
      setConnectedIds(prev => new Set([...prev, id]))
      setToolCounts(prev => ({ ...prev, [id]: tools.length }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  async function handleDisconnect(id: string) {
    setBusy(id); setError(null)
    try {
      await window.api.mcp.disconnect(id)
      setConnectedIds(prev => { const s = new Set(prev); s.delete(id); return s })
      setToolCounts(prev => { const c = { ...prev }; delete c[id]; return c })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  // MCP Hardening — подключиться, перечислить инструменты, классифицировать → манифест.
  async function handlePreview(s: McpServerEntry) {
    if (manifests[s.id]) {
      // toggle — повторный клик сворачивает карточку
      setManifests(prev => { const m = { ...prev }; delete m[s.id]; return m })
      return
    }
    setPreviewBusy(s.id)
    setPreviewError(prev => { const e = { ...prev }; delete e[s.id]; return e })
    try {
      const tools = await window.api.mcp.connect(s.id) as McpTool[]
      const agg = classifyServer(tools)
      const manifest: McpManifest = {
        tools: tools.map(t => ({ ...t, scope: classifyTool(t).scope })),
        risk: agg.risk,
        scopes: agg.scopes,
        toolCount: agg.toolCount,
        env: parseEnvRequirements(s.env)
      }
      setManifests(prev => ({ ...prev, [s.id]: manifest }))
      // connect фактически подключает сервер — отражаем это в общем состоянии
      setConnectedIds(prev => new Set([...prev, s.id]))
      setToolCounts(prev => ({ ...prev, [s.id]: tools.length }))
    } catch (e) {
      setPreviewError(prev => ({ ...prev, [s.id]: e instanceof Error ? e.message : String(e) }))
    } finally {
      setPreviewBusy(null)
    }
  }

  async function handleToggle(id: string, enabled: boolean) {
    await window.api.mcp.toggleServer(id, enabled)
    setServers(prev => prev.map(s => s.id === id ? { ...s, enabled } : s))
  }

  async function handleRemove(id: string) {
    if (!confirm('Удалить MCP сервер?')) return
    await window.api.mcp.removeServer(id)
    setServers(prev => prev.filter(s => s.id !== id))
    setConnectedIds(prev => { const s = new Set(prev); s.delete(id); return s })
  }

  async function handleAdd() {
    if (!newForm.name.trim() || !newForm.command.trim()) return
    // Validate JSON args/env
    let argsStr = newForm.args.trim() || '[]'
    let envStr = newForm.env.trim() || '{}'
    // If args is a space-separated string, convert to JSON array
    if (!argsStr.startsWith('[')) {
      argsStr = JSON.stringify(argsStr.split(/\s+/).filter(Boolean))
    }
    try { JSON.parse(argsStr) } catch { argsStr = '[]' }
    try { JSON.parse(envStr) } catch { envStr = '{}' }

    const entry = await window.api.mcp.addServer({
      name: newForm.name,
      command: newForm.command,
      args: argsStr,
      env: envStr,
      enabled: true
    })
    setServers(prev => [...prev, entry])
    setNewForm({ name: '', command: '', args: '', env: '' })
    setShowAdd(false)
  }

  function fillFromPopular(p: PopularMcpServer) {
    setNewForm({
      name: p.name,
      command: p.command,
      args: JSON.stringify(p.args),
      env: p.envHint ? `{"${p.envHint}": ""}` : '{}'
    })
    setShowAdd(true)
  }

  return (
    <div className="gg-settings-extra gg-mcp-tab">
      <div className="gg-settings-section-title">⚡ MCP Серверы — Model Context Protocol</div>
      <div className="gg-settings-hint" style={{ marginBottom: 16 }}>
        Подключай внешние MCP-серверы чтобы расширить возможности агента: поиск в интернете,
        базы данных, GitHub, браузер и многое другое. Инструменты сервера автоматически
        добавляются в арсенал AI.
      </div>

      <div className="gg-settings-row">
        <label className="gg-settings-label">Override scope тулза (JSON, опц.)</label>
        <input
          className="gg-input"
          value={scopeOverrides}
          onChange={e => void saveScopeOverrides(e.target.value)}
          placeholder={'{"some_tool":"read","danger_tool":"command"}'}
          style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
          spellCheck={false}
        />
      </div>
      <div className="gg-settings-hint" style={{ marginBottom: 16, fontSize: 'var(--text-xs)' }}>
        Явный scope гейтинга для конкретного MCP-тулза (read = авто; write/command/network = подтверждение). Приоритет: это поле → стандартные MCP-хинты (readOnlyHint/destructiveHint) → угадайка по имени.
      </div>

      {error && (
        <div className="gg-settings-hint" style={{ color: 'var(--error, #dc3545)', marginBottom: 12 }}>
          ⚠ {error}
        </div>
      )}

      {/* Список серверов */}
      {servers.length === 0 ? (
        <div className="gg-text-tertiary" style={{ padding: '12px 0', fontSize: 'var(--text-sm)' }}>
          Нет настроенных MCP-серверов. Добавь ниже или выбери из популярных.
        </div>
      ) : (
        <div className="gg-mcp-server-list">
          {servers.map(s => {
            const connected = connectedIds.has(s.id)
            const count = toolCounts[s.id] ?? 0
            const manifest = manifests[s.id]
            const pError = previewError[s.id]
            return (
              <div key={s.id} className={`gg-mcp-server-card ${connected ? 'is-connected' : ''}`}>
                <div className="gg-mcp-server-row">
                  <div className="gg-mcp-server-info">
                    <div className="gg-mcp-server-name">
                      {s.name}
                      {connected && <span className="gg-badge-connected" style={{ marginLeft: 8 }}>✓ {count} tools</span>}
                    </div>
                    <div className="gg-mcp-server-cmd" title={`${s.command} ${JSON.parse(s.args || '[]').join(' ')}`}>
                      {s.command} {JSON.parse(s.args || '[]').join(' ')}
                    </div>
                  </div>
                  <div className="gg-mcp-server-actions">
                    <button
                      className="gg-btn gg-btn-ghost"
                      onClick={() => void handlePreview(s)}
                      disabled={previewBusy === s.id}
                      title="Подключиться, показать инструменты и оценить риск ДО доверия серверу"
                    >{previewBusy === s.id ? '…' : (manifest ? '✕ Свернуть' : '🔍 Проверить возможности')}</button>
                    <label className="gg-toggle" title="Включить/отключить сервер">
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        onChange={e => void handleToggle(s.id, e.target.checked)}
                      />
                      <span className="gg-toggle-slider" />
                    </label>
                    {connected ? (
                      <button
                        className="gg-btn gg-btn-ghost"
                        onClick={() => void handleDisconnect(s.id)}
                        disabled={busy === s.id}
                      >{busy === s.id ? '…' : 'Отключить'}</button>
                    ) : (
                      <button
                        className="gg-btn gg-btn-primary"
                        onClick={() => void handleConnect(s.id)}
                        disabled={busy === s.id || !s.enabled}
                      >{busy === s.id ? '…' : 'Подключить'}</button>
                    )}
                    <button
                      className="gg-btn gg-btn-ghost"
                      style={{ color: 'var(--error, #dc3545)' }}
                      onClick={() => void handleRemove(s.id)}
                      title="Удалить сервер"
                    >✕</button>
                  </div>
                </div>

                {pError && (
                  <div className="gg-mcp-manifest-error">⚠ Не удалось проверить: {pError}</div>
                )}

                {manifest && (
                  <div className="gg-mcp-manifest">
                    <div className="gg-mcp-manifest-head">
                      <span className={`gg-mcp-risk-pill is-${manifest.risk}`}>
                        {manifest.risk === 'high' ? 'Высокий риск' : manifest.risk === 'medium' ? 'Средний риск' : 'Низкий риск'}
                      </span>
                      <span className="gg-mcp-manifest-summary">
                        {manifest.toolCount} инстр. · {scopeSummary(manifest.scopes) || '—'}
                      </span>
                    </div>

                    {manifest.risk === 'high' && (
                      <div className="gg-mcp-manifest-warn">
                        ⚠️ Этот сервер может выполнять команды / писать файлы — включай только если доверяешь источнику.
                      </div>
                    )}

                    <div className="gg-mcp-manifest-env-title">Требуемые env-переменные</div>
                    {manifest.env.length === 0 ? (
                      <div className="gg-mcp-manifest-env-empty">Не требуются</div>
                    ) : (
                      <div className="gg-mcp-manifest-env">
                        {manifest.env.map(e => (
                          <span key={e.key} className={`gg-mcp-env-chip ${e.empty ? 'is-empty' : ''}`} title={e.empty ? 'Значение пустое — задай перед использованием' : 'Заполнено'}>
                            <code>{e.key}</code>{e.empty && <span className="gg-mcp-env-flag"> · пусто</span>}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="gg-mcp-manifest-tools-title">Инструменты ({manifest.toolCount})</div>
                    <div className="gg-mcp-manifest-tools">
                      {manifest.tools.map(t => (
                        <div key={t.name} className="gg-mcp-tool-row">
                          <span className={`gg-mcp-scope-badge is-${t.scope}`} title={SCOPE_META[t.scope].label}>
                            {SCOPE_META[t.scope].icon} {SCOPE_META[t.scope].label}
                          </span>
                          <div className="gg-mcp-tool-text">
                            <div className="gg-mcp-tool-name">{t.name}</div>
                            {t.description && <div className="gg-mcp-tool-desc">{t.description}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Форма добавления */}
      {showAdd ? (
        <div className="gg-mcp-add-form">
          <div className="gg-settings-section-title" style={{ marginTop: 0 }}>Новый MCP сервер</div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Название</label>
            <input className="gg-input" value={newForm.name} onChange={e => setNewForm(f => ({ ...f, name: e.target.value }))} placeholder="Brave Search" />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Команда</label>
            <input className="gg-input" value={newForm.command} onChange={e => setNewForm(f => ({ ...f, command: e.target.value }))} placeholder="npx" spellCheck={false} />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Аргументы (JSON)</label>
            <input className="gg-input" value={newForm.args} onChange={e => setNewForm(f => ({ ...f, args: e.target.value }))} placeholder='["-y", "@anthropic-ai/mcp-server-brave-search"]' spellCheck={false} style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }} />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Env (JSON)</label>
            <input className="gg-input" value={newForm.env} onChange={e => setNewForm(f => ({ ...f, env: e.target.value }))} placeholder='{"BRAVE_API_KEY": "your-key"}' spellCheck={false} style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="gg-btn gg-btn-primary" onClick={() => void handleAdd()}>Добавить</button>
            <button className="gg-btn gg-btn-ghost" onClick={() => setShowAdd(false)}>Отмена</button>
          </div>
        </div>
      ) : (
        <button className="gg-btn gg-btn-primary" style={{ marginTop: 12 }} onClick={() => setShowAdd(true)}>
          + Добавить MCP сервер
        </button>
      )}

      {/* Популярные серверы */}
      {popular.length > 0 && (
        <>
          <div className="gg-settings-section-title" style={{ marginTop: 24 }}>Популярные серверы</div>
          <div className="gg-mcp-popular-list">
            {popular.map(p => (
              <div key={p.name} className="gg-mcp-popular-item">
                <div className="gg-mcp-popular-name">{p.name}</div>
                <div className="gg-mcp-popular-desc">{p.description}</div>
                {p.envHint && <div className="gg-mcp-popular-env">Нужен env: <code>{p.envHint}</code></div>}
                <button className="gg-btn gg-btn-ghost" onClick={() => fillFromPopular(p)}>Использовать</button>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="gg-settings-hint" style={{ marginTop: 20 }}>
        MCP (Model Context Protocol) — открытый стандарт Anthropic для подключения
        AI к внешним данным и инструментам. Серверы запускаются как дочерние процессы.
        Подробнее: <code>modelcontextprotocol.io</code>
      </div>
    </div>
  )
}

export function Settings({ onClose, initialTab }: { onClose: () => void; initialTab?: Tab }) {
  const t = useT()
  const activeProjectPath = useProject(s => s.path)
  const [tab, setTab] = useState<Tab>(initialTab ?? 'providers')

  // Группы для левой sidebar — повторяет OpenCode Desktop структуру.
  const TAB_GROUPS: ReadonlyArray<{ title: string; tabs: ReadonlyArray<{ id: Tab; label: string; icon: React.ReactNode }> }> = [
    { title: t.settings.application, tabs: [
      { id: 'appearance', label: t.settings.appearance, icon: '🎨' },
      { id: 'notifications', label: t.settings.notifications, icon: '🔔' },
      { id: 'updates', label: t.settings.updates, icon: '⬆️' },
      { id: 'profiles',   label: t.settings.profiles,   icon: '👤' }
    ] },
    { title: t.settings.server, tabs: [
      { id: 'providers',  label: t.settings.providers,  icon: '🔌' },
      { id: 'models',     label: t.settings.models,     icon: '✨' },
      { id: 'connectors', label: t.settings.connectors, icon: <IconPlug size={16} /> },
      { id: 'mcp',        label: 'MCP',                 icon: '⚡' },
      { id: 'policy',     label: 'Что разрешено',       icon: '🛡' },
      { id: 'autonomous', label: t.settings.nightMode,  icon: '🌙' },
      { id: 'memory',     label: t.settings.memory,     icon: '🧠' },
      { id: 'audit',      label: 'Audit Log',            icon: '📋' }
    ] }
  ]
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
  const [telegramNotifyChatId, setTelegramNotifyChatId] = useState('')
  const [sshHost, setSshHost] = useState('')
  const [sshKeyPath, setSshKeyPath] = useState('')
  const [bitrixWebhook, setBitrixWebhook] = useState('')
  const [yDirectToken, setYDirectToken] = useState('')
  const [dadataApiKey, setDadataApiKey] = useState('')
  const [dadataSecret, setDadataSecret] = useState('')
  const [yMetrikaToken, setYMetrikaToken] = useState('')
  const [avitoClientId, setAvitoClientId] = useState('')
  const [avitoClientSecret, setAvitoClientSecret] = useState('')
  const [yWebmasterToken, setYWebmasterToken] = useState('')
  const [yWordstatToken, setYWordstatToken] = useState('')
  const [ozonClientId, setOzonClientId] = useState('')
  const [ozonApiKey, setOzonApiKey] = useState('')
  const [wbToken, setWbToken] = useState('')
  const [yookassaShopId, setYookassaShopId] = useState('')
  const [yookassaSecretKey, setYookassaSecretKey] = useState('')
  const [vkToken, setVkToken] = useState('')
  const [amocrmSubdomain, setAmocrmSubdomain] = useState('')
  const [amocrmToken, setAmocrmToken] = useState('')
  const [moyskladToken, setMoyskladToken] = useState('')
  const [yTrackerToken, setYTrackerToken] = useState('')
  const [yTrackerOrgId, setYTrackerOrgId] = useState('')
  const [sendpulseClientId, setSendpulseClientId] = useState('')
  const [sendpulseClientSecret, setSendpulseClientSecret] = useState('')
  const [unisenderApiKey, setUnisenderApiKey] = useState('')
  const [ga4Token, setGa4Token] = useState('')
  const [ga4PropertyId, setGa4PropertyId] = useState('')
  const [notionToken, setNotionToken] = useState('')
  const [konturFocusKey, setKonturFocusKey] = useState('')
  const [mpstatsToken, setMpstatsToken] = useState('')
  const [ozonPerfClientId, setOzonPerfClientId] = useState('')
  const [ozonPerfClientSecret, setOzonPerfClientSecret] = useState('')
  const [jiraBaseUrl, setJiraBaseUrl] = useState('')
  const [jiraEmail, setJiraEmail] = useState('')
  const [jiraApiToken, setJiraApiToken] = useState('')
  const [trelloApiKey, setTrelloApiKey] = useState('')
  const [trelloToken, setTrelloToken] = useState('')
  const [yDirectLogin, setYDirectLogin] = useState('')
  const [skillsServerBase, setSkillsServerBase] = useState('')
  const [claudeOauthToken, setClaudeOauthToken] = useState('')
  const [yDiskToken, setYDiskToken] = useState('')
  const [githubToken, setGithubToken] = useState('')
  const [socialTgChannels, setSocialTgChannels] = useState('')
  const [socialVkToken, setSocialVkToken] = useState('')
  const [socialVkGroupId, setSocialVkGroupId] = useState('')
  const [socialWebhooks, setSocialWebhooks] = useState('')
  const [costCap, setCostCap] = useState('')
  const [configuredConnectors, setConfiguredConnectors] = useState<Set<string>>(new Set())
  type ConnectorHealth = 'unknown' | 'checking' | 'ok' | 'error'
  const [connectorHealth, setConnectorHealth] = useState<Record<string, ConnectorHealth>>({})
  const [connectorHealthMsg, setConnectorHealthMsg] = useState<Record<string, string>>({})
  const [connectorApplying, setConnectorApplying] = useState<string | null>(null)
  const [openConnector, setOpenConnector] = useState<string | null>(null)
  // Форма коннектора раскрывается сразу под карточкой — скроллим к ней при открытии.
  const connectorDetailRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (openConnector) connectorDetailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [openConnector])
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
  const [currentLang, setCurrentLang] = useState('en')
  const { theme, setTheme } = useTheme()
  const { uiScalePercent, setUiScalePercent } = useUiScale()
  const {
    notifyPrefs,
    setNotifySound,
    setNotifyToast,
    setNotifyUnfocusedOnly,
    testNotification
  } = useNotifySettings()
  // Audit log
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])
  const [auditPath, setAuditPath] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const provider = await window.api.settings.getKey('provider')
      const valid = PROVIDERS.some(p => p.id === provider) ? (provider as ProviderId) : 'gemini-api'
      setActiveProvider(valid)
      const keyVals: Record<string, string> = {}
      const modelVals: Record<string, string> = {}
      // Грузим ключи/модели всех провайдеров ПАРАЛЛЕЛЬНО (было последовательно —
      // 18 провайдеров × 2 await = ~36 IPC цепочкой, заметный лаг открытия).
      await Promise.all(PROVIDERS.map(async p => {
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
      }))
      // Аудит: вторичные ключи RU-провайдеров (folder_id / client_secret / tls)
      // живут вне p.secretKey — грузим явно, иначе input пуст после перезагрузки
      // и YandexGPT/GigaChat невозможно настроить (теряется 2-й секрет).
      const [yFolder, gSecret, gTls] = await Promise.all([
        window.api.settings.getKey('yandex_folder_id'),
        window.api.settings.getKey('gigachat_client_secret'),
        window.api.settings.getKey('gigachat_tls_verify')
      ])
      if (yFolder) keyVals['yandex_folder_id'] = yFolder
      if (gSecret) keyVals['gigachat_client_secret'] = gSecret
      if (gTls) keyVals['gigachat_tls_verify'] = gTls
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
      // Плоские ключи коннекторов/прочего — ОДНОЙ параллельной пачкой. Раньше
      // здесь было ~50 последовательных await getKey (каждый ждёт предыдущего) —
      // главный источник лага открытия Settings после роста до 31 коннектора.
      const FLAT_KEYS = [
        'gsheets_service_account_json', 'telegram_bot_token', 'telegram_chat_whitelist', 'telegram_notify_chat_id',
        'ssh_default_host', 'ssh_key_path', 'bitrix24_webhook_url', 'yandex_direct_token',
        'dadata_api_key', 'dadata_secret', 'yandex_metrika_token', 'avito_client_id',
        'avito_client_secret', 'yandex_webmaster_token', 'yandex_wordstat_token',
        'ozon_client_id', 'ozon_api_key', 'wildberries_token', 'yookassa_shop_id',
        'yookassa_secret_key', 'vk_access_token', 'amocrm_subdomain', 'amocrm_access_token',
        'moysklad_token', 'yandex_tracker_token', 'yandex_tracker_org_id', 'sendpulse_client_id',
        'sendpulse_client_secret', 'unisender_api_key', 'ga4_access_token', 'ga4_property_id',
        'notion_token', 'kontur_focus_api_key', 'mpstats_token', 'ozon_perf_client_id',
        'ozon_perf_client_secret', 'jira_base_url', 'jira_email', 'jira_api_token',
        'trello_api_key', 'trello_token', 'yandex_direct_login', 'skills_server_base',
        'claude_code_oauth_token', 'yandex_disk_token', 'github_token',
        'social_publish_telegram_channels', 'social_publish_vk_token', 'social_publish_vk_group_id',
        'social_publish_webhooks', 'cost_cap_usd_per_session', 'custom_openai_baseurl',
        'custom_openai_models', 'app_language'
      ]
      const F: Record<string, string> = Object.fromEntries(
        await Promise.all(FLAT_KEYS.map(async k => [k, (await window.api.settings.getKey(k)) ?? ''] as const))
      )
      setGsheetsJson(F['gsheets_service_account_json'])
      setTelegramBotToken(F['telegram_bot_token'])
      setTelegramWhitelist(F['telegram_chat_whitelist'])
      setTelegramNotifyChatId(F['telegram_notify_chat_id'])
      setSshHost(F['ssh_default_host'])
      setSshKeyPath(F['ssh_key_path'])
      setBitrixWebhook(F['bitrix24_webhook_url'])
      setYDirectToken(F['yandex_direct_token'])
      setDadataApiKey(F['dadata_api_key'])
      setDadataSecret(F['dadata_secret'])
      setYMetrikaToken(F['yandex_metrika_token'])
      setAvitoClientId(F['avito_client_id'])
      setAvitoClientSecret(F['avito_client_secret'])
      setYWebmasterToken(F['yandex_webmaster_token'])
      setYWordstatToken(F['yandex_wordstat_token'])
      setOzonClientId(F['ozon_client_id'])
      setOzonApiKey(F['ozon_api_key'])
      setWbToken(F['wildberries_token'])
      setYookassaShopId(F['yookassa_shop_id'])
      setYookassaSecretKey(F['yookassa_secret_key'])
      setVkToken(F['vk_access_token'])
      setAmocrmSubdomain(F['amocrm_subdomain'])
      setAmocrmToken(F['amocrm_access_token'])
      setMoyskladToken(F['moysklad_token'])
      setYTrackerToken(F['yandex_tracker_token'])
      setYTrackerOrgId(F['yandex_tracker_org_id'])
      setSendpulseClientId(F['sendpulse_client_id'])
      setSendpulseClientSecret(F['sendpulse_client_secret'])
      setUnisenderApiKey(F['unisender_api_key'])
      setGa4Token(F['ga4_access_token'])
      setGa4PropertyId(F['ga4_property_id'])
      setNotionToken(F['notion_token'])
      setKonturFocusKey(F['kontur_focus_api_key'])
      setMpstatsToken(F['mpstats_token'])
      setOzonPerfClientId(F['ozon_perf_client_id'])
      setOzonPerfClientSecret(F['ozon_perf_client_secret'])
      setJiraBaseUrl(F['jira_base_url'])
      setJiraEmail(F['jira_email'])
      setJiraApiToken(F['jira_api_token'])
      setTrelloApiKey(F['trello_api_key'])
      setTrelloToken(F['trello_token'])
      setYDirectLogin(F['yandex_direct_login'])
      setSkillsServerBase(F['skills_server_base'])
      setClaudeOauthToken(F['claude_code_oauth_token'])
      setYDiskToken(F['yandex_disk_token'])
      setGithubToken(F['github_token'])
      setSocialTgChannels(F['social_publish_telegram_channels'])
      setSocialVkToken(F['social_publish_vk_token'])
      setSocialVkGroupId(F['social_publish_vk_group_id'])
      setSocialWebhooks(F['social_publish_webhooks'])
      setCostCap(F['cost_cap_usd_per_session'])
      setCustomOpenaiBaseUrl(F['custom_openai_baseurl'])
      setCustomOpenaiModels(F['custom_openai_models'])
      setCurrentLang(F['app_language'] || 'en')
      // Какие модели «включены» в picker'е. Нет ключа = только активный провайдер.
      const em = await window.api.settings.getKey('enabled_models')
      if (em) {
        try {
          const arr = JSON.parse(em) as string[]
          setEnabledModels(Array.isArray(arr) ? new Set(arr) : defaultEnabledModels(valid, modelVals))
        } catch {
          setEnabledModels(defaultEnabledModels(valid, modelVals))
        }
      } else {
        setEnabledModels(defaultEnabledModels(valid, modelVals))
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

  // Загружаем audit log при открытии вкладки
  useEffect(() => {
    if (tab !== 'audit') return
    void (async () => {
      let path = activeProjectPath
      if (!path) {
        const projects = await window.api.projects.list()
        if (projects.length === 0) return
        const sorted = [...projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
        path = sorted[0].path
      }
      setAuditPath(path)
      try {
        const entries = await window.api.audit.query(path, { limit: 100 })
        setAuditEntries(entries)
      } catch { /* ignore */ }
    })()
  }, [tab, activeProjectPath])

  async function isConnectorConfiguredId(c: ConnectorDef): Promise<boolean> {
    if (c.id === 'http') {
      for (let i = 1; i <= 4; i++) {
        const base = await window.api.settings.getKey(`http_endpoint_${i}_base`)
        if (base?.trim()) return true
      }
      return false
    }
    if (c.id === 'social-publish') {
      for (const k of ['social_publish_telegram_channels', 'social_publish_vk_token', 'social_publish_webhooks']) {
        const v = await window.api.settings.getKey(k)
        if (v?.trim()) return true
      }
      return false
    }
    if (!c.configuredKey) return false
    const val = await window.api.settings.getKey(c.configuredKey)
    return !!val?.trim()
  }

  async function refreshConfiguredConnectors(): Promise<Set<string>> {
    const results = await Promise.all(CONNECTORS.map(async c =>
      (await isConnectorConfiguredId(c)) ? c.id : null
    ))
    const next = new Set(results.filter(Boolean) as string[])
    setConfiguredConnectors(next)
    return next
  }

  async function runConnectorTest(uiId: string): Promise<{ ok: boolean; message: string }> {
    setConnectorHealth(h => ({ ...h, [uiId]: 'checking' }))
    try {
      const result = await window.api.connectors.test(uiId)
      setConnectorHealth(h => ({ ...h, [uiId]: result.ok ? 'ok' : 'error' }))
      setConnectorHealthMsg(m => ({ ...m, [uiId]: result.message }))
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка проверки'
      setConnectorHealth(h => ({ ...h, [uiId]: 'error' }))
      setConnectorHealthMsg(m => ({ ...m, [uiId]: message }))
      return { ok: false, message }
    }
  }

  async function persistConnector(uiId: string): Promise<void> {
    switch (uiId) {
      case 'claude-oauth':
        await window.api.settings.setKey('claude_code_oauth_token', claudeOauthToken)
        break
      case 'onec':
        await window.api.settings.setKey('onec_base_url', onec.url)
        await window.api.settings.setKey('onec_username', onec.user)
        await window.api.settings.setKey('onec_password', onec.pass)
        break
      case 'http':
        for (let i = 0; i < httpEndpoints.length; i++) {
          const e = httpEndpoints[i]
          await window.api.settings.setKey(`http_endpoint_${i + 1}_name`, e.name)
          await window.api.settings.setKey(`http_endpoint_${i + 1}_base`, e.base)
          await window.api.settings.setKey(`http_endpoint_${i + 1}_auth`, e.auth)
          await window.api.settings.setKey(`http_endpoint_${i + 1}_paths`, e.paths)
        }
        break
      case 'gsheets':
        await window.api.settings.setKey('gsheets_service_account_json', gsheetsJson)
        break
      case 'telegram':
        await window.api.settings.setKey('telegram_bot_token', telegramBotToken)
        await window.api.settings.setKey('telegram_chat_whitelist', telegramWhitelist)
        await window.api.settings.setKey('telegram_notify_chat_id', telegramNotifyChatId)
        break
      case 'ssh':
        await window.api.settings.setKey('ssh_default_host', sshHost)
        await window.api.settings.setKey('ssh_key_path', sshKeyPath)
        break
      case 'bitrix':
        await window.api.settings.setKey('bitrix24_webhook_url', bitrixWebhook)
        break
      case 'ydirect':
        await window.api.settings.setKey('yandex_direct_token', yDirectToken)
        await window.api.settings.setKey('yandex_direct_login', yDirectLogin)
        break
      case 'ydisk':
        await window.api.settings.setKey('yandex_disk_token', yDiskToken)
        break
      case 'skills-server':
        await window.api.settings.setKey('skills_server_base', skillsServerBase)
        break
      case 'github':
        await window.api.settings.setKey('github_token', githubToken)
        break
      case 'social-publish':
        await window.api.settings.setKey('social_publish_telegram_channels', socialTgChannels)
        await window.api.settings.setKey('social_publish_vk_token', socialVkToken)
        await window.api.settings.setKey('social_publish_vk_group_id', socialVkGroupId)
        await window.api.settings.setKey('social_publish_webhooks', socialWebhooks)
        break
      case 'dadata':
        await window.api.settings.setKey('dadata_api_key', dadataApiKey)
        await window.api.settings.setKey('dadata_secret', dadataSecret)
        break
      case 'ymetrika':
        await window.api.settings.setKey('yandex_metrika_token', yMetrikaToken)
        break
      case 'avito':
        await window.api.settings.setKey('avito_client_id', avitoClientId)
        await window.api.settings.setKey('avito_client_secret', avitoClientSecret)
        break
      case 'ywebmaster':
        await window.api.settings.setKey('yandex_webmaster_token', yWebmasterToken)
        break
      case 'ywordstat':
        await window.api.settings.setKey('yandex_wordstat_token', yWordstatToken)
        break
      case 'ozon':
        await window.api.settings.setKey('ozon_client_id', ozonClientId)
        await window.api.settings.setKey('ozon_api_key', ozonApiKey)
        break
      case 'wildberries':
        await window.api.settings.setKey('wildberries_token', wbToken)
        break
      case 'yookassa':
        await window.api.settings.setKey('yookassa_shop_id', yookassaShopId)
        await window.api.settings.setKey('yookassa_secret_key', yookassaSecretKey)
        break
      case 'vk':
        await window.api.settings.setKey('vk_access_token', vkToken)
        break
      case 'amocrm':
        await window.api.settings.setKey('amocrm_subdomain', amocrmSubdomain)
        await window.api.settings.setKey('amocrm_access_token', amocrmToken)
        break
      case 'moysklad':
        await window.api.settings.setKey('moysklad_token', moyskladToken)
        break
      case 'yandex_tracker':
        await window.api.settings.setKey('yandex_tracker_token', yTrackerToken)
        await window.api.settings.setKey('yandex_tracker_org_id', yTrackerOrgId)
        break
      case 'sendpulse':
        await window.api.settings.setKey('sendpulse_client_id', sendpulseClientId)
        await window.api.settings.setKey('sendpulse_client_secret', sendpulseClientSecret)
        break
      case 'unisender':
        await window.api.settings.setKey('unisender_api_key', unisenderApiKey)
        break
      case 'ga4':
        await window.api.settings.setKey('ga4_access_token', ga4Token)
        await window.api.settings.setKey('ga4_property_id', ga4PropertyId)
        break
      case 'notion':
        await window.api.settings.setKey('notion_token', notionToken)
        break
      case 'kontur_focus':
        await window.api.settings.setKey('kontur_focus_api_key', konturFocusKey)
        break
      case 'mpstats':
        await window.api.settings.setKey('mpstats_token', mpstatsToken)
        break
      case 'ozon_performance':
        await window.api.settings.setKey('ozon_perf_client_id', ozonPerfClientId)
        await window.api.settings.setKey('ozon_perf_client_secret', ozonPerfClientSecret)
        break
      case 'jira':
        await window.api.settings.setKey('jira_base_url', jiraBaseUrl)
        await window.api.settings.setKey('jira_email', jiraEmail)
        await window.api.settings.setKey('jira_api_token', jiraApiToken)
        break
      case 'trello':
        await window.api.settings.setKey('trello_api_key', trelloApiKey)
        await window.api.settings.setKey('trello_token', trelloToken)
        break
      default:
        break
    }
  }

  async function applyConnector(uiId: string): Promise<void> {
    setConnectorApplying(uiId)
    try {
      await persistConnector(uiId)
      await refreshConfiguredConnectors()
      await runConnectorTest(uiId)
    } finally {
      setConnectorApplying(null)
    }
  }

  // Коннекторы: список настроенных + фоновая проверка токенов
  useEffect(() => {
    if (tab !== 'connectors') return
    let cancelled = false
    void (async () => {
      const configured = await refreshConfiguredConnectors()
      if (cancelled) return
      await Promise.all([...configured].map(id => runConnectorTest(id)))
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // Вторичные ключи RU-провайдеров: основной p.secretKey пишется в цикле выше,
    // а второй (folder_id / client_secret / tls) — нет. Без этого YandexGPT и
    // GigaChat невозможно настроить (теряется на перезагрузке).
    if (keys['yandex_folder_id'] !== undefined) await window.api.settings.setKey('yandex_folder_id', keys['yandex_folder_id'])
    if (keys['gigachat_client_secret'] !== undefined) await window.api.settings.setKey('gigachat_client_secret', keys['gigachat_client_secret'])
    if (keys['gigachat_tls_verify'] !== undefined) await window.api.settings.setKey('gigachat_tls_verify', keys['gigachat_tls_verify'])
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
    await window.api.settings.setKey('telegram_notify_chat_id', telegramNotifyChatId)
    await window.api.settings.setKey('ssh_default_host', sshHost)
    await window.api.settings.setKey('ssh_key_path', sshKeyPath)
    await window.api.settings.setKey('bitrix24_webhook_url', bitrixWebhook)
    await window.api.settings.setKey('yandex_direct_token', yDirectToken)
    await window.api.settings.setKey('dadata_api_key', dadataApiKey)
    await window.api.settings.setKey('dadata_secret', dadataSecret)
    await window.api.settings.setKey('yandex_metrika_token', yMetrikaToken)
    await window.api.settings.setKey('avito_client_id', avitoClientId)
    await window.api.settings.setKey('avito_client_secret', avitoClientSecret)
    await window.api.settings.setKey('yandex_webmaster_token', yWebmasterToken)
    await window.api.settings.setKey('yandex_wordstat_token', yWordstatToken)
    await window.api.settings.setKey('ozon_client_id', ozonClientId)
    await window.api.settings.setKey('ozon_api_key', ozonApiKey)
    await window.api.settings.setKey('wildberries_token', wbToken)
    await window.api.settings.setKey('yookassa_shop_id', yookassaShopId)
    await window.api.settings.setKey('yookassa_secret_key', yookassaSecretKey)
    await window.api.settings.setKey('vk_access_token', vkToken)
    await window.api.settings.setKey('amocrm_subdomain', amocrmSubdomain)
    await window.api.settings.setKey('amocrm_access_token', amocrmToken)
    await window.api.settings.setKey('moysklad_token', moyskladToken)
    await window.api.settings.setKey('yandex_tracker_token', yTrackerToken)
    await window.api.settings.setKey('yandex_tracker_org_id', yTrackerOrgId)
    await window.api.settings.setKey('sendpulse_client_id', sendpulseClientId)
    await window.api.settings.setKey('sendpulse_client_secret', sendpulseClientSecret)
    await window.api.settings.setKey('unisender_api_key', unisenderApiKey)
    await window.api.settings.setKey('ga4_access_token', ga4Token)
    await window.api.settings.setKey('ga4_property_id', ga4PropertyId)
    await window.api.settings.setKey('notion_token', notionToken)
    await window.api.settings.setKey('kontur_focus_api_key', konturFocusKey)
    await window.api.settings.setKey('mpstats_token', mpstatsToken)
    await window.api.settings.setKey('ozon_perf_client_id', ozonPerfClientId)
    await window.api.settings.setKey('ozon_perf_client_secret', ozonPerfClientSecret)
    await window.api.settings.setKey('jira_base_url', jiraBaseUrl)
    await window.api.settings.setKey('jira_email', jiraEmail)
    await window.api.settings.setKey('jira_api_token', jiraApiToken)
    await window.api.settings.setKey('trello_api_key', trelloApiKey)
    await window.api.settings.setKey('trello_token', trelloToken)
    await window.api.settings.setKey('yandex_direct_login', yDirectLogin)
    await window.api.settings.setKey('skills_server_base', skillsServerBase)
    await window.api.settings.setKey('claude_code_oauth_token', claudeOauthToken)
    await window.api.settings.setKey('yandex_disk_token', yDiskToken)
    await window.api.settings.setKey('github_token', githubToken)
    await window.api.settings.setKey('social_publish_telegram_channels', socialTgChannels)
    await window.api.settings.setKey('social_publish_vk_token', socialVkToken)
    await window.api.settings.setKey('social_publish_vk_group_id', socialVkGroupId)
    await window.api.settings.setKey('social_publish_webhooks', socialWebhooks)
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
          <div className="gg-settings-row">
            <label className="gg-settings-label">Уведомления о прогоне → chat_id</label>
            <input
              className="gg-input"
              value={telegramNotifyChatId}
              onChange={e => setTelegramNotifyChatId(e.target.value)}
              placeholder='123456789 (твой chat_id; пусто = выкл)'
              style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-hint">
            JSON-массив chat_id куда боту разрешено отправлять. Пустая строка = всем (только dev).
            Rate limit 20 send/min на chat_id вшит в коннектор. Read истории — через SSH к Telethon скрипту.
            <br/>Поле «Уведомления о прогоне» (opt-in): запустил агента и ушёл — бот сам пришлёт в этот chat_id, когда прогон завершился / упал / ждёт ревью. Только исходящее. Chat_id должен быть в whitelist.
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
              placeholder="Login проекта в Директе — для агентских аккаунтов"
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-hint">
            Reports API асинхронный — connector polls до 30s. Если отчёт большой,
            возвращается <code>processing: true</code>, повторяй запрос.
          </div>
        </>
      )
      case 'dadata': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">API key</label>
            <input
              className="gg-input"
              type="password"
              value={dadataApiKey}
              onChange={e => setDadataApiKey(e.target.value)}
              placeholder="Token из dadata.ru/profile/#info"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Secret (опц.)</label>
            <input
              className="gg-input"
              type="password"
              value={dadataSecret}
              onChange={e => setDadataSecret(e.target.value)}
              placeholder="Нужен только для clean_address (стандартизация)"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-hint">
            Операции: find_party (контрагент по ИНН/ОГРН), suggest_party, suggest_address,
            suggest_bank, clean_address. Подсказки работают по одному API key; clean_address
            требует Secret.
          </div>
        </>
      )
      case 'ymetrika': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">OAuth token</label>
            <input
              className="gg-input"
              type="password"
              value={yMetrikaToken}
              onChange={e => setYMetrikaToken(e.target.value)}
              placeholder="oauth.yandex.ru, scope metrika:read"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-hint">
            Операции: list_counters, get_traffic (визиты/посетители/отказы по дням),
            get_sources (источники), list_goals. Период — date1/date2 (YYYY-MM-DD или 7daysAgo/today).
          </div>
        </>
      )
      case 'avito': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Client ID</label>
            <input
              className="gg-input"
              value={avitoClientId}
              onChange={e => setAvitoClientId(e.target.value)}
              placeholder="client_id приложения developers.avito.ru"
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Client Secret</label>
            <input
              className="gg-input"
              type="password"
              value={avitoClientSecret}
              onChange={e => setAvitoClientSecret(e.target.value)}
              placeholder="client_secret"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-hint">
            OAuth2 client_credentials — токен получается автоматически и кэшируется.
            Операции: list_items, get_stats (показы/контакты), get_balance.
          </div>
        </>
      )
      case 'ywebmaster': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">OAuth token</label>
            <input
              className="gg-input"
              type="password"
              value={yWebmasterToken}
              onChange={e => setYWebmasterToken(e.target.value)}
              placeholder="oauth.yandex.ru, scope webmaster:hostinfo"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-hint">
            Операции: list_hosts, get_summary (ИКС + проблемы), get_queries (топ запросов
            с показами/кликами). host_id берётся из list_hosts.
          </div>
        </>
      )
      case 'ywordstat': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">OAuth token</label>
            <input
              className="gg-input"
              type="password"
              value={yWordstatToken}
              onChange={e => setYWordstatToken(e.target.value)}
              placeholder="OAuth-токен приложения Wordstat API"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-hint">
            Новый Wordstat API (api.wordstat.yandex.net): OAuth-приложение на oauth.yandex.ru
            и заявка на доступ по ClientID. Операции: get_top_requests, get_wordstat (phrases, geo_id),
            get_dynamics, get_regions, get_regions_tree.
          </div>
        </>
      )
      case 'moysklad': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Token</label>
            <input className="gg-input" type="password" value={moyskladToken} onChange={e => setMoyskladToken(e.target.value)} placeholder="Bearer-токен МойСклад (Настройки → API)" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Операции: list_products, list_orders, get_stock.</div>
        </>
      )
      case 'yandex_tracker': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">OAuth token</label>
            <input className="gg-input" type="password" value={yTrackerToken} onChange={e => setYTrackerToken(e.target.value)} placeholder="oauth.yandex.ru, доступ к Трекеру" autoComplete="new-password" />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">X-Org-ID</label>
            <input className="gg-input" value={yTrackerOrgId} onChange={e => setYTrackerOrgId(e.target.value)} placeholder="ID организации Трекера" spellCheck={false} />
          </div>
          <div className="gg-settings-hint">Операции: list_queues, list_issues (queue), get_issue.</div>
        </>
      )
      case 'sendpulse': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Client ID</label>
            <input className="gg-input" value={sendpulseClientId} onChange={e => setSendpulseClientId(e.target.value)} placeholder="ID из SendPulse → API" spellCheck={false} />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Client Secret</label>
            <input className="gg-input" type="password" value={sendpulseClientSecret} onChange={e => setSendpulseClientSecret(e.target.value)} placeholder="Secret" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">OAuth2 client_credentials (токен кэшируется). Операции: list_mailing_lists, list_campaigns, get_balance.</div>
        </>
      )
      case 'unisender': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">API key</label>
            <input className="gg-input" type="password" value={unisenderApiKey} onChange={e => setUnisenderApiKey(e.target.value)} placeholder="Личный кабинет → Настройки → API" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Операции: get_lists, get_campaigns, get_campaign_stats.</div>
        </>
      )
      case 'ga4': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Access token</label>
            <input className="gg-input" type="password" value={ga4Token} onChange={e => setGa4Token(e.target.value)} placeholder="OAuth Bearer, scope analytics.readonly" autoComplete="new-password" />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Property ID</label>
            <input className="gg-input" value={ga4PropertyId} onChange={e => setGa4PropertyId(e.target.value)} placeholder="Числовой ID ресурса GA4" spellCheck={false} />
          </div>
          <div className="gg-settings-hint">Операции: run_report (metrics/dimensions/период), get_realtime.</div>
        </>
      )
      case 'notion': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Integration token</label>
            <input className="gg-input" type="password" value={notionToken} onChange={e => setNotionToken(e.target.value)} placeholder="notion.so/my-integrations (Internal)" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Подключи интеграцию к нужным страницам. Операции: search, query_database, get_page.</div>
        </>
      )
      case 'kontur_focus': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">API key</label>
            <input className="gg-input" type="password" value={konturFocusKey} onChange={e => setKonturFocusKey(e.target.value)} placeholder="Ключ Focus API 3.0" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Операции: req (реквизиты по ИНН/ОГРН), analytics (риск-маркеры).</div>
        </>
      )
      case 'mpstats': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Token</label>
            <input className="gg-input" type="password" value={mpstatsToken} onChange={e => setMpstatsToken(e.target.value)} placeholder="X-Mpstats-TOKEN" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">⚠️ Бета — проверь на своём аккаунте. Операции: аналитика категорий/товаров WB.</div>
        </>
      )
      case 'ozon_performance': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Client ID</label>
            <input className="gg-input" value={ozonPerfClientId} onChange={e => setOzonPerfClientId(e.target.value)} placeholder="client_id Performance API" spellCheck={false} />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Client Secret</label>
            <input className="gg-input" type="password" value={ozonPerfClientSecret} onChange={e => setOzonPerfClientSecret(e.target.value)} placeholder="client_secret" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">⚠️ Бета — проверь на аккаунте. Операции: list_campaigns, list_objects.</div>
        </>
      )
      case 'jira': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Base URL</label>
            <input className="gg-input" value={jiraBaseUrl} onChange={e => setJiraBaseUrl(e.target.value)} placeholder="https://company.atlassian.net" spellCheck={false} />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Email</label>
            <input className="gg-input" value={jiraEmail} onChange={e => setJiraEmail(e.target.value)} placeholder="email Atlassian" spellCheck={false} />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">API token</label>
            <input className="gg-input" type="password" value={jiraApiToken} onChange={e => setJiraApiToken(e.target.value)} placeholder="id.atlassian.com → API tokens" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Операции: search_issues (JQL), get_issue, list_projects.</div>
        </>
      )
      case 'trello': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">API key</label>
            <input className="gg-input" value={trelloApiKey} onChange={e => setTrelloApiKey(e.target.value)} placeholder="trello.com/app-key" spellCheck={false} />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Token</label>
            <input className="gg-input" type="password" value={trelloToken} onChange={e => setTrelloToken(e.target.value)} placeholder="токен авторизации Trello" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Операции: list_boards, list_lists (board_id), list_cards (list_id).</div>
        </>
      )
      case 'ozon': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Client-Id</label>
            <input className="gg-input" value={ozonClientId} onChange={e => setOzonClientId(e.target.value)} placeholder="Client-Id продавца" spellCheck={false} />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Api-Key</label>
            <input className="gg-input" type="password" value={ozonApiKey} onChange={e => setOzonApiKey(e.target.value)} placeholder="Api-Key (Seller → Настройки → API-ключи)" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Операции: list_products, get_stocks, get_analytics (date_from/date_to), get_transactions.</div>
        </>
      )
      case 'wildberries': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Token (Статистика)</label>
            <input className="gg-input" type="password" value={wbToken} onChange={e => setWbToken(e.target.value)} placeholder="ЛК WB → Доступ к API → категория «Статистика»" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Операции: get_sales, get_orders, get_stocks (date_from, по умолчанию 7 дней назад).</div>
        </>
      )
      case 'yookassa': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">shopId</label>
            <input className="gg-input" value={yookassaShopId} onChange={e => setYookassaShopId(e.target.value)} placeholder="Идентификатор магазина" spellCheck={false} />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Секретный ключ</label>
            <input className="gg-input" type="password" value={yookassaSecretKey} onChange={e => setYookassaSecretKey(e.target.value)} placeholder="live_… / test_…" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Только чтение: list_payments, get_payment, list_refunds. Создание платежей намеренно недоступно.</div>
        </>
      )
      case 'vk': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Access token</label>
            <input className="gg-input" type="password" value={vkToken} onChange={e => setVkToken(e.target.value)} placeholder="oauth/сервисный токен VK" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Операции: group_info, wall_get (owner_id для группы отрицательный), users_get.</div>
        </>
      )
      case 'amocrm': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Поддомен</label>
            <input className="gg-input" value={amocrmSubdomain} onChange={e => setAmocrmSubdomain(e.target.value)} placeholder="mycompany (без .amocrm.ru)" spellCheck={false} />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Access token</label>
            <input className="gg-input" type="password" value={amocrmToken} onChange={e => setAmocrmToken(e.target.value)} placeholder="long-lived токен интеграции" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Операции: list_leads, list_contacts, list_pipelines, get_lead.</div>
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
            Используется агентом для публичных ссылок на артефакты проекта:
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
              placeholder="https://your-skills-server.example.com (или пусто для built-in only)"
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-hint">
            Сервер должен предоставлять <code>GET /api/skills</code> возвращающий
            <code>{`{skills: [{id, raw, sourceRef}]}`}</code>. Если недоступен — используются built-in
            (code-review / git-summary / explain-code) + локальные из ~/.verstak/skills/.
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
      case 'social-publish': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Telegram-каналы (JSON)</label>
            <input
              className="gg-input"
              value={socialTgChannels}
              onChange={e => setSocialTgChannels(e.target.value)}
              placeholder='["-1001234567890", "@my_channel"]'
              style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-hint" style={{ marginBottom: 10 }}>
            Переиспользует Bot token из коннектора Telegram (telegram_bot_token). Список chat_id куда постить.
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">VK token</label>
            <input
              className="gg-input"
              type="password"
              value={socialVkToken}
              onChange={e => setSocialVkToken(e.target.value)}
              placeholder="User token со scope wall (vk.com/dev, oauth.vk.com)"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">VK group ID</label>
            <input
              className="gg-input"
              value={socialVkGroupId}
              onChange={e => setSocialVkGroupId(e.target.value)}
              placeholder="Числовой ID группы (без минуса), напр. 123456789"
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Webhooks (JSON)</label>
            <input
              className="gg-input"
              value={socialWebhooks}
              onChange={e => setSocialWebhooks(e.target.value)}
              placeholder='["https://hooks.example.com/abc", "https://n8n.example.com/webhook/xyz"]'
              style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-hint">
            AI вызывает <code>connector_query</code> с <code>id="social-publish"</code> и
            <code>op="publish_text"</code>, <code>text="..."</code>.
            Опционально <code>platforms: ["telegram", "vk", "webhook"]</code> — если не передан, постит во всё настроенное.
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
          <div className="gg-modal-title">{t.settings.title}</div>
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
        <>
        <ModelsPage
          providers={PROVIDERS}
          enabledModels={enabledModels}
          setEnabledModels={setEnabledModels}
          models={models}
          setModels={setModels}
          activeProvider={activeProvider}
          setActiveProvider={setActiveProvider}
          keys={keys}
          customOpenaiBaseUrl={customOpenaiBaseUrl}
          onGoToProviders={() => setTab('providers')}
        />
        <ModeModelBinding providers={PROVIDERS} />
        </>
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

          {(() => {
            const configuredList = CONNECTORS.filter(c => configuredConnectors.has(c.id))
            const availableList = CONNECTORS.filter(c => !configuredConnectors.has(c.id))

            const renderConnectorDetail = (id: string) => (
              <div
                className="gg-connector-detail"
                ref={openConnector === id ? connectorDetailRef : undefined}
              >
                <div className="gg-connector-detail-header">
                  {(() => {
                    const def = CONNECTORS.find(c => c.id === id)
                    return def ? <><def.icon size={20} /> {def.name}</> : null
                  })()}
                  <button className="gg-connector-detail-close" onClick={() => setOpenConnector(null)}>×</button>
                </div>
                <div className="gg-connector-detail-body">
                  {renderConnectorForm(id)}
                  <div className="gg-connector-detail-actions">
                    {connectorApplying === id && <div className="gg-connector-progress" aria-hidden />}
                    <div className="gg-connector-detail-actions-row">
                      <button
                        type="button"
                        className="gg-btn gg-btn-primary"
                        disabled={connectorApplying === id}
                        onClick={() => void applyConnector(id)}
                      >
                        {connectorApplying === id ? t.connectors.applying : t.connectors.apply}
                      </button>
                      {connectorHealthMsg[id] && connectorApplying !== id && (
                        <span className={`gg-connector-test-msg ${connectorHealth[id] === 'ok' ? 'is-ok' : connectorHealth[id] === 'error' ? 'is-error' : ''}`}>
                          {connectorHealthMsg[id]}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )

            const renderConnectorItem = (c: ConnectorDef) => {
              const configured = configuredConnectors.has(c.id)
              const health = connectorHealth[c.id] ?? 'unknown'
              const healthTitle = connectorHealthMsg[c.id]
                ?? (health === 'checking' ? t.connectors.healthChecking
                  : health === 'ok' ? t.connectors.healthOk
                  : health === 'error' ? t.connectors.healthError
                  : '')
              const isOpen = openConnector === c.id
              return (
                <div key={c.id} className={`gg-connector-item${isOpen ? ' is-expanded' : ''}`}>
                  <button
                    type="button"
                    className={`gg-connector-card ${configured ? 'is-connected' : ''} ${isOpen ? 'is-open' : ''}`}
                    onClick={() => setOpenConnector(isOpen ? null : c.id)}
                  >
                    <div className="gg-connector-card-icon"><c.icon size={32} /></div>
                    <div className="gg-connector-card-body">
                      <div className="gg-connector-card-name">{c.name}</div>
                      <div className="gg-connector-card-desc">{c.description}</div>
                    </div>
                    <div className="gg-connector-card-status">
                      {configured && (
                        <span
                          className={`gg-connector-health ${health === 'ok' ? 'is-ok' : health === 'error' ? 'is-error' : health === 'checking' ? 'is-checking' : ''}`}
                          title={healthTitle}
                          aria-label={healthTitle}
                        />
                      )}
                      {configured
                        ? <span className="gg-badge-connected">&#10003;</span>
                        : <span className="gg-badge-add">+</span>}
                    </div>
                  </button>
                  {isOpen && renderConnectorDetail(c.id)}
                </div>
              )
            }

            return (
              <>
                {configuredList.length > 0 && (
                  <>
                    <div className="gg-connector-section-title">{t.connectors.sectionConfigured}</div>
                    <div className="gg-connector-list">
                      {configuredList.map(renderConnectorItem)}
                    </div>
                    {availableList.length > 0 && <div className="gg-connector-section-divider" />}
                  </>
                )}
                {availableList.length > 0 && (
                  <>
                    <div className="gg-connector-section-title">{t.connectors.sectionAvailable}</div>
                    <div className="gg-connector-list">
                      {availableList.map(renderConnectorItem)}
                    </div>
                  </>
                )}
              </>
            )
          })()}
        </div>
        )}

        {tab === 'mcp' && (
          <McpTab />
        )}

        {tab === 'policy' && (
          <PolicyTab />
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

        {tab === 'updates' && <UpdatesSettings />}

        {tab === 'notifications' && (
        <div className="gg-settings-extra">
          <div className="gg-settings-section-title">{t.settings.notifications}</div>
          <div className="gg-settings-hint" style={{ marginBottom: 16 }}>{t.settings.notifyIntro}</div>
          <div className="gg-notify-settings">
            <label className="gg-theme-square">
              <input
                type="checkbox"
                checked={notifyPrefs.sound}
                onChange={(e) => void setNotifySound(e.target.checked)}
              />
              <span>{t.settings.notifySound}</span>
            </label>
            <label className="gg-theme-square">
              <input
                type="checkbox"
                checked={notifyPrefs.toast}
                onChange={(e) => void setNotifyToast(e.target.checked)}
              />
              <span>{t.settings.notifyToast}</span>
            </label>
            <label className="gg-theme-square">
              <input
                type="checkbox"
                checked={notifyPrefs.unfocusedOnly}
                onChange={(e) => void setNotifyUnfocusedOnly(e.target.checked)}
              />
              <span>{t.settings.notifyUnfocusedOnly}</span>
            </label>
            <button type="button" className="gg-btn gg-btn-ghost" onClick={() => void testNotification()}>
              {t.settings.notifyTest}
            </button>
            <div className="gg-settings-hint">{t.settings.notifyHint}</div>
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
          <div className="gg-theme-grid" role="group" style={{ marginBottom: 12 }}>
            {THEMES.map(meta => (
              <button
                key={meta.id}
                type="button"
                className={`gg-theme-card ${theme === meta.id ? 'is-active' : ''}`}
                onClick={() => void setTheme(meta.id)}
                aria-pressed={theme === meta.id}
                title={meta.label}
              >
                <span className="gg-theme-swatch" aria-hidden style={{ background: meta.swatch[0] }}>
                  <span style={{ background: meta.swatch[1] }} />
                  <span style={{ background: meta.swatch[2] }} />
                </span>
                <span className="gg-theme-name">{meta.label}</span>
              </button>
            ))}
          </div>
          <div className="gg-settings-section-title" style={{ marginTop: 8 }}>{t.settings.uiScale}</div>
          <div className="gg-ui-scale-block">
            <div className="gg-ui-scale-head">
              <span className="gg-ui-scale-value">{uiScalePercent}%</span>
              <button
                type="button"
                className="gg-btn gg-btn-ghost"
                onClick={() => void setUiScalePercent(100)}
              >
                {t.settings.uiScaleReset}
              </button>
            </div>
            <input
              type="range"
              className="gg-ui-scale-slider"
              min={MIN_UI_SCALE_PERCENT}
              max={MAX_UI_SCALE_PERCENT}
              step={5}
              value={uiScalePercent}
              onChange={(e) => void setUiScalePercent(Number(e.target.value))}
              aria-label={t.settings.uiScale}
            />
            <div className="gg-ui-scale-presets" role="group" aria-label={t.settings.uiScale}>
              {UI_SCALE_PRESETS.map(preset => (
                <button
                  key={preset}
                  type="button"
                  className={`gg-btn gg-btn-ghost ${uiScalePercent === preset ? 'is-active' : ''}`}
                  onClick={() => void setUiScalePercent(preset)}
                >
                  {preset}%
                </button>
              ))}
            </div>
            <div className="gg-settings-hint">{t.settings.uiScaleHint}</div>
          </div>

          <div className="gg-settings-hint" style={{ marginTop: 12 }}>
            Тема применяется мгновенно. Ширина боковой панели запоминается автоматически — потяни за её правый край.
          </div>
          <div className="gg-settings-row" style={{ marginTop: 16 }}>
            <label className="gg-settings-label">{t.settings.language}</label>
            <select
              className="gg-input"
              style={{ maxWidth: 200 }}
              value={currentLang}
              onChange={async (e) => {
                const lang = e.target.value
                setCurrentLang(lang)
                await window.api.settings.setKey('app_language', lang)
                window.location.reload()
              }}
            >
              <option value="en">English</option>
              <option value="ru">Русский</option>
            </select>
          </div>
        </div>
        )}

        {tab === 'audit' && (
        <div className="gg-settings-extra">
          <div className="gg-settings-section-title">📋 Audit Log</div>
          {auditPath && (
            <div className="gg-settings-hint" style={{ marginBottom: 12 }}>
              Проект: <code>{auditPath}</code>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button
              type="button"
              className="gg-btn gg-btn-primary"
              disabled={!auditPath}
              onClick={async () => {
                if (!auditPath) return
                try {
                  const csv = await window.api.audit.export(auditPath)
                  const blob = new Blob([csv], { type: 'text/csv' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = `audit-${Date.now()}.csv`
                  a.click()
                  URL.revokeObjectURL(url)
                } catch { /* ignore */ }
              }}
            >
              ⬇ Export CSV
            </button>
            <button
              type="button"
              className="gg-btn gg-btn-ghost"
              disabled={!auditPath}
              onClick={async () => {
                if (!auditPath) return
                if (!window.confirm('Очистить весь audit log для этого проекта?')) return
                try {
                  await window.api.audit.clear(auditPath)
                  setAuditEntries([])
                } catch { /* ignore */ }
              }}
            >
              🗑 Clear
            </button>
          </div>
          {auditEntries.length === 0 ? (
            <div className="gg-settings-hint">Нет записей. Audit log заполняется по мере работы агента.</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--gg-border)' }}>
                    <th style={{ textAlign: 'left', padding: '4px 8px' }}>Time</th>
                    <th style={{ textAlign: 'left', padding: '4px 8px' }}>Action</th>
                    <th style={{ textAlign: 'left', padding: '4px 8px' }}>Provider</th>
                    <th style={{ textAlign: 'left', padding: '4px 8px' }}>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {auditEntries.map(e => (
                    <tr key={e.id} style={{ borderBottom: '1px solid var(--gg-border-subtle, #333)' }}>
                      <td style={{ padding: '4px 8px', whiteSpace: 'nowrap', color: 'var(--gg-text-muted)' }}>
                        {new Date(e.timestamp).toLocaleTimeString()}
                      </td>
                      <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>
                        <span style={{
                          padding: '1px 6px', borderRadius: 4, fontSize: 11,
                          background: e.action === 'error' ? 'var(--gg-error-bg, #3a1a1a)' : 'var(--gg-tag-bg, #1a2a3a)',
                          color: e.action === 'error' ? 'var(--gg-error, #f87171)' : 'var(--gg-accent, #60a5fa)'
                        }}>
                          {e.action}
                        </span>
                      </td>
                      <td style={{ padding: '4px 8px', color: 'var(--gg-text-muted)', whiteSpace: 'nowrap' }}>
                        {e.providerId ?? '—'}
                      </td>
                      <td style={{ padding: '4px 8px', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {e.detail}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        )}

          </div>{/* /gg-settings-content */}
        </div>{/* /gg-settings-shell */}

        <div className="gg-modal-footer">
          <button className="gg-btn gg-btn-ghost" onClick={onClose}>{t.common.close}</button>
          <button className="gg-btn gg-btn-primary" onClick={save}>
            {saved ? t.settings.saved : t.settings.save}
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
  const t = useT()
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
  const [detectedClis, setDetectedClis] = useState<DetectedCli[]>([])

  async function loadCliStatus() {
    try {
      const s = await window.api.cliAuth.statusAll()
      setCliStatus(s)
    } catch { /* не критично — оставим null, бейдж покажет fallback */ }
  }
  useEffect(() => {
    void loadCliStatus()
    void import('../lib/prefetch-cli').then(m => m.getDetectedClisCached().then(setDetectedClis))
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
                  <span
                    className={`gg-models-caps-badge ${p.transport === 'CLI' ? 'is-cli' : 'is-api'}`}
                    title={p.transport === 'CLI' ? t.settings.capsCliHint : t.settings.capsFullHint}
                  >
                    {p.transport === 'CLI' ? t.settings.capsCli : t.settings.capsFull}
                  </span>
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
              <div className="gg-prov-card-name">
                {p.name}
                <span
                  className={`gg-models-caps-badge is-api`}
                  title={t.settings.capsFullHint}
                >
                  {t.settings.capsFull}
                </span>
                <span className="gg-prov-badge is-recommended">Рекомендуемый</span>
              </div>
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

      {detectedClis.length > 0 && (
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
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={keys['gigachat_tls_verify'] === 'true'}
              onChange={e => setKeys(k => ({ ...k, gigachat_tls_verify: e.target.checked ? 'true' : 'false' }))}
            />
            <span style={{ fontSize: 'var(--text-sm)' }}>Проверять TLS-сертификат сервера</span>
          </label>
          <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 4, marginBottom: 10 }}>
            ⚠ GigaChat использует сертификат Сбера (Russian Trusted Root CA), которого
            нет в стандартном trust store. По умолчанию соединение зашифровано TLS, но
            CA не проверяется (защита от MITM выключена). Если ты установил Russian
            Trusted Root CA в системное хранилище — включи галку выше для полной проверки.
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
// ModelsPage — карточки провайдеров: ползунок «все модели» / «Выбрать отдельные».
// enabled_models управляет picker'ом; по умолчанию — только модель входа.
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
  customOpenaiBaseUrl: string
  onGoToProviders: () => void
}

type ModelsCliStatusMap = Partial<Record<CliAuthId, CliAuthStatus>>

function ModelsPage(props: ModelsPageProps) {
  const t = useT()
  const {
    providers, enabledModels, setEnabledModels, models, setModels,
    activeProvider, setActiveProvider, keys, customOpenaiBaseUrl, onGoToProviders
  } = props
  const [search, setSearch] = useState('')
  const [detailProviders, setDetailProviders] = useState<Set<ProviderId>>(new Set())
  const [authModal, setAuthModal] = useState<ProviderConfig | null>(null)
  const [cliStatus, setCliStatus] = useState<ModelsCliStatusMap | null>(null)
  const [authBusy, setAuthBusy] = useState(false)

  useEffect(() => {
    void window.api.cliAuth.statusAll()
      .then(s => setCliStatus(s))
      .catch(() => { /* ignore */ })
  }, [])

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

  function isAuthorized(p: ProviderConfig): boolean {
    return isProviderAuthorized(p, keys, cliStatus, { customOpenaiBaseUrl })
  }

  function requireAuth(p: ProviderConfig, action: () => void) {
    if (!isAuthorized(p)) {
      setAuthModal(p)
      return
    }
    action()
  }

  function countEnabled(p: ProviderConfig): number {
    return p.models.filter(m => enabledModels.has(modelKey(p.id, m))).length
  }

  function enableAll(p: ProviderConfig) {
    setEnabledModels(prev => {
      const next = new Set(prev)
      for (const m of p.models) next.add(modelKey(p.id, m))
      return next
    })
  }

  function disableAll(p: ProviderConfig) {
    setEnabledModels(prev => {
      const next = new Set(prev)
      for (const m of p.models) next.delete(modelKey(p.id, m))
      const activeModel = models[p.id] ?? p.defaultModel
      if (p.id === activeProvider) next.add(modelKey(p.id, activeModel))
      return next
    })
  }

  function toggleModel(p: ProviderConfig, key: string, enable: boolean) {
    if (enable) {
      requireAuth(p, () => {
        setEnabledModels(prev => new Set(prev).add(key))
      })
      return
    }
    setEnabledModels(prev => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }

  function toggleAllModels(p: ProviderConfig) {
    if (countEnabled(p) > 0) {
      disableAll(p)
      return
    }
    requireAuth(p, () => enableAll(p))
  }

  function toggleDetail(id: ProviderId) {
    setDetailProviders(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function setDefault(providerId: ProviderId, model: string) {
    setActiveProvider(providerId)
    setModels(m => ({ ...m, [providerId]: model }))
    setEnabledModels(prev => new Set(prev).add(modelKey(providerId, model)))
  }

  async function openAuthSite(p: ProviderConfig) {
    const link = providerAuthLink(p)
    if (link) await window.api.app.openExternal(link.url)
  }

  async function startCliLogin(p: ProviderConfig) {
    if (p.transport !== 'CLI') return
    setAuthBusy(true)
    try {
      const res = await window.api.cliAuth.relogin(p.id)
      if (!res.ok) return
      window.setTimeout(() => {
        void window.api.cliAuth.statusAll().then(s => setCliStatus(s))
      }, 8000)
    } finally {
      setAuthBusy(false)
    }
  }

  const visibleProviders = providers.filter(p => {
    if (p.models.length === 0) return false
    if (!search.trim()) return true
    return grouped.has(p.id)
  })

  return (
    <div className="gg-settings-extra gg-models-page">
      <h2 className="gg-settings-page-title">Модели</h2>
      <p className="gg-models-intro">
        Выбери, какие модели показывать в чате. По умолчанию включена только та, к которой ты подключился при входе.
      </p>

      <div className="gg-models-search-wrap">
        <input
          className="gg-input gg-models-search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="🔎 Поиск по провайдеру или модели"
          spellCheck={false}
        />
      </div>

      <div className="gg-models-cards">
        {visibleProviders.map(p => {
          const list = grouped.get(p.id) ?? []
          const authorized = isAuthorized(p)
          const enabledCount = countEnabled(p)
          const isDetail = detailProviders.has(p.id)
          const isActiveProvider = activeProvider === p.id

          return (
            <div
              key={p.id}
              className={`gg-models-card ${isActiveProvider ? 'is-current' : ''}`}
            >
              <div className="gg-models-card-head">
                <div className="gg-models-card-title">
                  <span className="gg-models-card-name">{p.name}</span>
                  <span
                    className={`gg-models-caps-badge ${p.transport === 'CLI' ? 'is-cli' : 'is-api'}`}
                    title={p.transport === 'CLI' ? t.settings.capsCliHint : t.settings.capsFullHint}
                  >
                    {p.transport === 'CLI' ? t.settings.capsCli : t.settings.capsFull}
                  </span>
                  {isActiveProvider && <span className="gg-models-card-active">текущий</span>}
                </div>
                <div className="gg-models-card-meta">
                  <span className="gg-models-card-count">{enabledCount} / {p.models.length} в picker</span>
                  {!authorized && <span className="gg-models-card-lock">нужна авторизация</span>}
                </div>
              </div>

              <div className="gg-models-card-actions">
                <label className="gg-models-card-toggle">
                  <span className="gg-models-card-toggle-label">Все модели</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabledCount > 0}
                    className={`gg-toggle ${enabledCount > 0 ? 'is-on' : ''}`}
                    onClick={() => toggleAllModels(p)}
                    title={enabledCount > 0 ? 'Выключить все модели провайдера' : 'Включить все модели провайдера'}
                  >
                    <span className="gg-toggle-knob" />
                  </button>
                </label>
                <button
                  type="button"
                  className={`gg-btn gg-btn-ghost gg-models-card-btn ${isDetail ? 'is-active' : ''}`}
                  onClick={() => toggleDetail(p.id)}
                >
                  {isDetail ? 'Свернуть список' : 'Выбрать отдельные'}
                </button>
              </div>

              {isDetail && (
                <div className="gg-models-card-list">
                  {list.length === 0 && (
                    <div className="gg-text-tertiary" style={{ padding: '10px 4px', fontSize: 'var(--text-sm)' }}>
                      Ничего не найдено
                    </div>
                  )}
                  {list.map(e => {
                    const enabled = enabledModels.has(e.key)
                    const isCurrentModel = isActiveProvider && (models[p.id] ?? p.defaultModel) === e.model
                    return (
                      <div key={e.key} className={`gg-models-row ${isCurrentModel ? 'is-current' : ''}`}>
                        <button
                          type="button"
                          className="gg-models-row-main"
                          onClick={() => setDefault(p.id, e.model)}
                          title="Сделать текущей моделью в чате"
                        >
                          <span className="gg-models-row-name">{e.model}</span>
                          {isCurrentModel && <span className="gg-models-row-current">Текущий</span>}
                          <span className="gg-models-row-tags">
                            {e.tags.map(tag => (
                              <span key={tag} className={`gg-mpal-tag is-${tag.toLowerCase().replace(/\$/g, 'd')}`}>{tag}</span>
                            ))}
                          </span>
                        </button>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={enabled}
                          className={`gg-toggle ${enabled ? 'is-on' : ''}`}
                          onClick={() => toggleModel(p, e.key, !enabled)}
                          title={enabled ? 'Скрыть из picker' : 'Показать в picker'}
                        >
                          <span className="gg-toggle-knob" />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {visibleProviders.length === 0 && (
        <div className="gg-text-tertiary" style={{ padding: 18, textAlign: 'center', fontSize: 'var(--text-sm)' }}>
          Ничего не найдено
        </div>
      )}

      {authModal && (
        <div className="gg-modal-backdrop" role="dialog" aria-modal="true" onClick={() => setAuthModal(null)}>
          <div className="gg-models-auth-modal" onClick={e => e.stopPropagation()}>
            <h3>Нужна авторизация</h3>
            <p>
              Чтобы включить модели <strong>{authModal.name}</strong>, сначала подключи провайдер.
              {authModal.transport === 'API'
                ? ' Получи API-ключ на сайте провайдера и вставь его во вкладке «Провайдеры».'
                : ' Войди в подписку на сайте, затем пройди OAuth в терминале Verstak.'}
            </p>
            <div className="gg-models-auth-actions">
              {providerAuthLink(authModal) && (
                <button
                  type="button"
                  className="gg-btn gg-btn-primary"
                  onClick={() => void openAuthSite(authModal)}
                >
                  Открыть {providerAuthLink(authModal)!.label}
                </button>
              )}
              {authModal.transport === 'CLI' && (
                <button
                  type="button"
                  className="gg-btn gg-btn-ghost"
                  disabled={authBusy}
                  onClick={() => void startCliLogin(authModal)}
                >
                  {authBusy ? 'Открываю терминал…' : 'Войти через терминал'}
                </button>
              )}
              {authModal.transport === 'API' && (
                <button
                  type="button"
                  className="gg-btn gg-btn-ghost"
                  onClick={() => { setAuthModal(null); onGoToProviders() }}
                >
                  Перейти к ключу
                </button>
              )}
              <button type="button" className="gg-btn gg-btn-ghost" onClick={() => setAuthModal(null)}>
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
