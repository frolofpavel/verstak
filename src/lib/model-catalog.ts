/**
 * Плоский каталог всех моделей всех провайдеров — для OpenCode-style палитры
 * в Settings → Модели. Источник истины по провайдерам остаётся в
 * electron/ai/registry.ts (main) и зеркале PROVIDERS в Settings.tsx (renderer);
 * здесь мы только разворачиваем (provider × models[]) в плоский список с
 * метаданными для UI: цена, теги, hint про подписку.
 *
 * Не дублируем сами модели — каталог принимает providers извне (см. buildCatalog).
 */

import type { ProviderId } from '../hooks/useProvider'
import type { ProviderDescriptorDTO, ProviderExecutionMode, ProviderTransport } from '../types/api'
import {
  authKindFor, capabilitiesFor, executionModeFor, EXPERIMENTAL_PROVIDER_IDS,
} from '../../shared/contracts/provider'

export interface ProviderLite {
  id: ProviderId
  name: string
  transport: 'API' | 'CLI' | 'Tunnel'
  supportsTools: boolean
  models: string[]
  defaultModel: string
}

export interface ModelEntry {
  /** Уникальный ключ для React: `${providerId}::${model}`. */
  key: string
  providerId: ProviderId
  providerName: string
  model: string
  transport: 'API' | 'CLI' | 'Tunnel'
  /** Tools (file edits, run_command, connector_query) поддерживаются у провайдера. */
  supportsTools: boolean
  /** $ per 1M input tokens. null если CLI (подписка) или цена неизвестна. */
  pricePerMInput: number | null
  /** $ per 1M output tokens. null если CLI или неизвестна. */
  pricePerMOutput: number | null
  /** Короткие теги для UI: 'TOOLS' | 'CLI' | 'API' | '$$$' | '$'. */
  tags: ReadonlyArray<ModelTag>
}

export type ModelTag = 'TOOLS' | 'CHAT' | 'CLI' | 'API' | '$$$' | '$'

export type ModelPolicyTone = 'recommended' | 'fallback' | 'allowed' | 'avoid'

export interface ModelPolicyHint {
  label: string
  tone: ModelPolicyTone
  title: string
}

const MODEL_POLICY_HINTS: Record<string, ModelPolicyHint> = {
  'kimi-k2.7-code': {
    label: 'основная',
    tone: 'recommended',
    title: 'Default coding / planner / reviewer model. Stage 11: 5/5 strict pass.'
  },
  'deepseek-chat': {
    label: 'запасная',
    tone: 'fallback',
    title: 'Fallback для быстрых правок и багфиксов. Review-before-commit не ставим как основной сценарий.'
  },
  'qwen3-coder': {
    label: 'можно',
    tone: 'allowed',
    title: 'Разрешена для agent-mode, но не дефолт: в eval были сбои на bugfix/review gate.'
  },
  'verstak/coder': {
    label: 'кодинг',
    tone: 'allowed',
    title: 'Рабочий пресет для guarded coding, но прямой Kimi остаётся основным выбором.'
  },
  'verstak/balanced': {
    label: 'баланс',
    tone: 'allowed',
    title: 'Баланс-пресет Gateway. Рекомендованная цель политики: kimi-k2.7-code.'
  },
  'verstak/long': {
    label: 'длинный',
    tone: 'allowed',
    title: 'Для длинного контекста. Для обычного agent-mode предпочтительнее kimi-k2.7-code.'
  },
  'verstak/private': {
    label: 'локально',
    tone: 'allowed',
    title: 'Приватный пресет. Качество зависит от локальной/частной модели.'
  },
  'verstak/economy': {
    label: 'дёшево',
    tone: 'fallback',
    title: 'Экономичный режим. Лучше для простых задач, не как главный agent-mode.'
  },
  'verstak/fast': {
    label: 'не agent',
    tone: 'avoid',
    title: 'Stage 11: слабая дисциплина. Не использовать как дефолт для agent-mode.'
  },
  'verstak/coder/fast': {
    label: 'не agent',
    tone: 'avoid',
    title: 'Alias fast-пресета. Не использовать как дефолт для agent-mode.'
  },
  'deepseek-reasoner': {
    label: 'не agent',
    tone: 'avoid',
    title: 'Не рекомендована для agent-mode defaults по Stage 11.'
  },
  'z-ai/glm-4.6': {
    label: 'не agent',
    tone: 'avoid',
    title: 'Stage 11: низкий strict pass. Не ставить в agent-mode.'
  },
  'minimax-m1': {
    label: 'не agent',
    tone: 'avoid',
    title: 'Не прошла доступность/валидацию в Stage 11. Не ставить в agent-mode.'
  }
}

export function modelPolicyHint(model: string | null | undefined): ModelPolicyHint | null {
  if (!model) return null
  return MODEL_POLICY_HINTS[model] ?? null
}

// Дублирует PRICES из src/lib/pricing.ts чтобы не тянуть весь pricing-модуль
// (он завязан на ProviderId через CLI_FREE — не нужно тут). Цены $ / 1M.
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6':           { input: 3.0,  output: 15.0 },
  'claude-opus-4-5':             { input: 15.0, output: 75.0 },
  'claude-sonnet-4-5':           { input: 3.0,  output: 15.0 },
  'claude-haiku-4-5':            { input: 1.0,  output: 5.0 },
  'claude-opus-4-5-20251101':    { input: 15.0, output: 75.0 },
  'claude-sonnet-4-5-20251101':  { input: 3.0,  output: 15.0 },
  'claude-haiku-4-5-20251101':   { input: 1.0,  output: 5.0 },
  'gemini-3-pro':                { input: 2.50, output: 15.0 },
  'gemini-3.5-flash':            { input: 0.30, output: 2.50 },
  'gemini-3-flash':              { input: 0.30, output: 2.50 },
  'gemini-2.5-pro':              { input: 1.25, output: 10.0 },
  'gemini-2.5-flash':            { input: 0.30, output: 2.50 },
  'gpt-5':                       { input: 1.25, output: 10.0 },
  'gpt-5-mini':                  { input: 0.25, output: 2.0 },
  'gpt-4o':                      { input: 2.5,  output: 10.0 },
  'gpt-4o-mini':                 { input: 0.15, output: 0.60 },
  'o1':                          { input: 15.0, output: 60.0 },
  'o1-mini':                     { input: 3.0,  output: 12.0 },
  'grok-4.5':                    { input: 2.00, output: 6.00 },
  // DeepSeek V4 (api-docs.deepseek.com/quick_start/pricing, $ / 1M, cache-miss)
  'deepseek-v4-flash':           { input: 0.14, output: 0.28 },
  'deepseek-v4-pro':             { input: 0.435, output: 0.87 },
  'deepseek-chat':               { input: 0.14, output: 0.28 },
  'deepseek-reasoner':           { input: 0.14, output: 0.28 },
  // Moonshot Kimi (platform.kimi.ai pricing, $ / 1M)
  'kimi-k2.7-code':              { input: 0.95, output: 4.00 },
  'kimi-k2.6':                   { input: 0.95, output: 4.00 },
  'kimi-k2.5':                   { input: 0.60, output: 3.00 },
  // Qwen / DashScope intl (alibabacloud.com/help/en/model-studio/model-pricing, $ / 1M)
  'qwen3-max':                   { input: 0.78, output: 3.90 },
  // Mistral (mistral.ai/pricing, USD)
  'mistral-large-latest':        { input: 2.00, output: 6.00 },
  'mistral-small-latest':        { input: 0.20, output: 0.60 },
  'codestral-latest':            { input: 0.30, output: 0.90 },
  'ministral-8b-latest':         { input: 0.10, output: 0.10 },
  // Groq (groq.com/pricing)
  'llama-3.3-70b-versatile':     { input: 0.59, output: 0.79 },
  'llama-3.1-8b-instant':        { input: 0.05, output: 0.08 },
  'mixtral-8x7b-32768':          { input: 0.24, output: 0.24 },
  'gemma2-9b-it':                { input: 0.20, output: 0.20 }
  // OpenRouter и Ollama не добавляем: OpenRouter использует prefix-нотацию
  // (anthropic/claude-...) — цена считается на стороне OpenRouter с маржой;
  // Ollama локальный, цена $0 (через PRICES не считается).
}

function deriveTags(p: ProviderLite, model: string): ModelTag[] {
  const tags: ModelTag[] = []
  tags.push(p.transport === 'CLI' ? 'CLI' : 'API')
  if (p.supportsTools) tags.push('TOOLS'); else tags.push('CHAT')
  if (p.transport === 'API') {
    const price = PRICES[model]
    if (price) {
      if (price.output >= 15)      tags.push('$$$')
      else if (price.output <= 1)  tags.push('$')
    }
  }
  return tags
}

export function buildCatalog(providers: ProviderLite[]): ModelEntry[] {
  const out: ModelEntry[] = []
  for (const p of providers) {
    for (const m of p.models) {
      const price = p.transport === 'API' ? PRICES[m] : null
      out.push({
        key: `${p.id}::${m}`,
        providerId: p.id,
        providerName: p.name,
        model: m,
        transport: p.transport,
        supportsTools: p.supportsTools,
        pricePerMInput: price?.input ?? null,
        pricePerMOutput: price?.output ?? null,
        tags: deriveTags(p, m)
      })
    }
  }
  return out
}

/**
 * Статус подключения для провайдера:
 *  - 'ready'   — API ключ есть (для API) ИЛИ это CLI (предполагаем что установлен)
 *  - 'missing' — API провайдер без ключа
 *  - 'unknown' — CLI: реально не пингуем установку из renderer
 *
 * Принимает Map secretKey → значение (из state Settings.tsx).
 */
export type ConnectionStatus = 'ready' | 'missing' | 'unknown'

export function connectionStatus(
  providerId: ProviderId,
  secretKey: string | null,
  keys: Record<string, string>
): ConnectionStatus {
  if (secretKey === null) return 'unknown' // CLI
  return keys[secretKey] && keys[secretKey].length > 0 ? 'ready' : 'missing'
}

export type CliAuthId = 'claude-cli' | 'gemini-cli' | 'grok-cli' | 'codex-cli'
export type CliAuthStatus = { installed: boolean; loggedIn: boolean; credPath?: string }

/** CLI-провайдеры: правки делает внешний агент в субпроцессе → контрольные
 *  гарантии Verstak (per-file undo / verification / Proof) недоступны. */
export const CLI_PROVIDER_IDS: ReadonlySet<ProviderId> = new Set<ProviderId>([
  'claude-cli', 'gemini-cli', 'grok-cli', 'codex-cli',
])

/** true если провайдер — CLI (без полного контроля Verstak). */
export function isCliProvider(id: ProviderId | string | null | undefined): boolean {
  return !!id && CLI_PROVIDER_IDS.has(id as ProviderId)
}

/** Сайт подписки / получения доступа для CLI-провайдеров. */
export const CLI_SUBSCRIPTION_LINKS: Partial<Record<ProviderId, { url: string; label: string }>> = {
  'grok-cli': { url: 'https://grok.com', label: 'grok.com' },
  'claude-cli': { url: 'https://claude.ai', label: 'claude.ai' },
  'gemini-cli': { url: 'https://one.google.com', label: 'Google One AI' },
  'codex-cli': { url: 'https://chatgpt.com', label: 'chatgpt.com' },
}

export function providerAuthLink(
  provider: ProviderLite & { secretKey?: string | null; keyLink?: { url: string; label: string } },
): { url: string; label: string } | null {
  if (provider.keyLink) return provider.keyLink
  return CLI_SUBSCRIPTION_LINKS[provider.id] ?? null
}

export function isProviderAuthorized(
  provider: ProviderLite & { id: ProviderId; secretKey?: string | null },
  keys: Record<string, string>,
  cliStatus: Partial<Record<CliAuthId, CliAuthStatus>> | null,
  opts?: { customOpenaiBaseUrl?: string; localServerIds?: Set<string> }
): boolean {
  if (provider.id === 'ollama') return opts?.localServerIds?.has('ollama') ?? false
  if (provider.id === 'custom-openai') return Boolean(opts?.customOpenaiBaseUrl?.trim())
  const status = connectionStatus(provider.id, provider.secretKey ?? null, keys)
  if (status === 'ready') return true
  if (provider.transport === 'CLI') {
    const cli = cliStatus?.[provider.id as CliAuthId]
    return Boolean(cli?.loggedIn)
  }
  return false
}

function modelSearchAliases(e: ModelEntry): string {
  const parts: string[] = []
  const model = e.model.toLowerCase()
  const provider = e.providerName.toLowerCase()
  if (model.includes('grok') || provider.includes('grok')) parts.push('xai x.ai икс грок grok билд build composer композер')
  if (model.includes('claude') || provider.includes('claude')) parts.push('anthropic антропик клауд соннет sonnet opus')
  if (model.includes('gemini') || provider.includes('gemini')) parts.push('google гугл гемини flash флеш pro')
  if (model.includes('codex') || provider.includes('codex')) parts.push('openai chatgpt кодекс код')
  if (model.includes('ollama') || provider.includes('ollama') || model.includes('llama')) parts.push('local локальная локально llama оллама')
  if (/fast|flash|mini|haiku|economy/i.test(model)) parts.push('fast быстро быстрый легкая дешево эконом')
  if (/code|coder|build|composer/i.test(model)) parts.push('code код разработка агент build composer')
  if (/reason|thinking/i.test(model)) parts.push('reasoning размышления думает сложные')
  if (e.transport === 'CLI') parts.push('cli консоль подписка внешний агент')
  if (e.transport === 'API') parts.push('api ключ апи')
  if (e.supportsTools) parts.push('tools инструменты файлы команды')
  return parts.join(' ')
}

export function modelSearchText(e: ModelEntry): string {
  return `${e.model} ${e.providerName} ${e.tags.join(' ')} ${modelSearchAliases(e)}`.toLowerCase()
}

/**
 * Fuzzy-ish search: term должен встретиться как substring в любом из:
 * model name, provider name, tags. Регистронезависимо. Пусто = всё.
 */

// ─── Срез 2.0.7-D: единый каталог провайдеров ────────────────────────────────
//
// Раньше Settings.tsx хардкодил массив PROVIDERS — ВТОРОЕ зеркало реестра с
// собственной копией models[] (источник дрейфа «UI предлагает модель, которой
// рантайм не знает»; так UI 2 месяца предлагал мёртвые модели Claude). Теперь и
// Settings, и композер строят каталог из ОДНОГО источника — providers:list DTO
// (модели/транспорт/дефолт из реестра main). Здесь остаётся ТОЛЬКО презентационная
// копия (описание, hint, ссылка-на-ключ, порядок) — она не функциональна и не может
// вызвать баг «модели нет в рантайме».

/** Презентационная мета провайдера. НЕ содержит models/defaultModel — иначе вернулся бы дрейф. */
export interface ProviderUiMeta {
  /** Порядок в списке Settings (verstak-gateway первым — рекомендованный). */
  order: number
  /** Переопределение имени ТОЛЬКО там, где UI-текст исторически отличается от DTO. */
  name?: string
  description: string
  keyHint: string
  keyLink?: { url: string; label: string }
  /** Провайдер за opt-in чекбоксом (Experimental): текст согласия. Сам факт
   *  experimental приходит из DTO, здесь — только копия предупреждения. */
  optIn?: { warning: string; label: string }
}

export type CatalogSource = 'live' | 'bundled'

/** Провайдер каталога: функционал из DTO + презентация из UI-меты. Заменяет старый
 *  хардкод ProviderConfig в Settings (та же форма + executionMode/experimental/source). */
export interface CatalogProvider {
  id: ProviderId
  name: string
  transport: ProviderTransport
  executionMode: ProviderExecutionMode
  experimental: boolean
  description: string
  models: string[]
  defaultModel: string
  secretKey: string | null
  keyHint: string
  keyLink?: { url: string; label: string }
  optIn?: { warning: string; label: string }
  supportsTools: boolean
  /** live = из providers:list; bundled = офлайн-снапшот (IPC упал). Виден пользователю. */
  source: CatalogSource
}

/** Презентационная мета по провайдеру. Порядок = порядок карточек в Settings. */
export const PROVIDER_UI_META: Record<string, ProviderUiMeta> = {
  'verstak-gateway': { order: 0, description: 'Единый баланс Verstak: один ключ, оплата в рублях и готовые наборы моделей', keyHint: 'vsk_live_...', keyLink: { url: 'https://agi-iri.ru/gateway/', label: 'agi-iri.ru/gateway' } },
  'gemini-api': { order: 1, description: 'Модели Google для больших контекстов, документов и быстрых повседневных задач', keyHint: 'AIzaSy…', keyLink: { url: 'https://aistudio.google.com/app/apikey', label: 'Google AI Studio API keys' } },
  'gemini-cli': { order: 2, description: 'Работает через установленный Gemini и вход в аккаунт Google без API-ключа', keyHint: '' },
  'claude': { order: 3, description: 'Сильные модели для анализа, текста, планирования и задач с большим количеством условий', keyHint: 'sk-ant-…', keyLink: { url: 'https://platform.claude.com/settings/keys', label: 'Claude API keys' } },
  'claude-cli': { order: 4, description: 'Работает через Claude Code и подписку Anthropic. Подходит для кода и файлов', keyHint: '' },
  'grok': { order: 5, description: 'Модели xAI через API. Verstak может выполнять действия и показывать этапы работы', keyHint: 'xai-…', keyLink: { url: 'https://console.x.ai/team/default/api-keys', label: 'xAI API keys' } },
  'grok-cli': { order: 6, description: 'Работает через подписку SuperGrok и установленный Grok Build', keyHint: '' },
  'openai': { order: 7, description: 'Модели OpenAI для текста, кода, анализа и аккуратной работы с инструкциями', keyHint: 'sk-…', keyLink: { url: 'https://platform.openai.com/api-keys', label: 'OpenAI Platform' } },
  'codex-cli': { order: 8, name: 'Codex CLI', description: 'Работает через Codex и аккаунт OpenAI. Подходит для кода, файлов и проверок', keyHint: '' },
  'openai-codex-oauth': {
    order: 9,
    description: 'Полный agent-loop Verstak на вашей подписке ChatGPT/Codex (модели gpt-5.6/5.5/5.4). Токен — из «codex login», отдельный ключ не нужен.',
    keyHint: '',
    optIn: {
      warning: 'Экспериментально. Использует OAuth-токен вашей подписки напрямую против API OpenAI (как Hermes/OpenClaw). OpenAI это разрешает и не банит автоматически (в отличие от Anthropic), НО официальной гарантии нет — policy-risk ненулевой. Включайте осознанно. Сначала выполните «codex login».',
      label: 'Понимаю риск — включить Codex OAuth',
    },
  },
  'openrouter': { order: 10, description: 'Один ключ для моделей разных провайдеров: Claude, GPT, Gemini, Grok и open-source', keyHint: 'sk-or-...', keyLink: { url: 'https://openrouter.ai/keys', label: 'openrouter.ai/keys' } },
  'deepseek': { order: 11, description: 'Недорогие модели для кода, рассуждений и массовых задач', keyHint: 'sk-...', keyLink: { url: 'https://platform.deepseek.com/api_keys', label: 'platform.deepseek.com' } },
  'moonshot': { order: 12, description: 'Модели Kimi для длинного контекста, кода и задач с большим объёмом данных', keyHint: 'sk-...', keyLink: { url: 'https://platform.moonshot.ai/console/api-keys', label: 'platform.moonshot.ai' } },
  'kimi-coding': { order: 13, description: 'Подписка Kimi для задач по коду вместо оплаты за каждый запрос', keyHint: 'sk-...', keyLink: { url: 'https://www.kimi.com/code', label: 'Kimi Code Console' } },
  'zai-coding': { order: 14, description: 'Подписка Z.ai для GLM-моделей, кода и длинных задач', keyHint: 'ключ Coding Plan…', keyLink: { url: 'https://z.ai/manage-apikey/apikey-list', label: 'z.ai → API Keys' } },
  'qwen': { order: 15, description: 'Модели Alibaba для кода, текста и быстрых рабочих задач', keyHint: 'sk-...', keyLink: { url: 'https://bailian.console.aliyun.com/', label: 'bailian.console.aliyun.com' } },
  'mistral': { order: 16, description: 'Европейские модели общего назначения. Codestral полезен для кода', keyHint: 'API key...', keyLink: { url: 'https://console.mistral.ai/api-keys', label: 'console.mistral.ai' } },
  'groq': { order: 17, description: 'Очень быстрые модели для коротких ответов и задач, где важна скорость', keyHint: 'gsk_...', keyLink: { url: 'https://console.groq.com/keys', label: 'console.groq.com' } },
  'ollama': { order: 18, description: 'Локальные модели на компьютере. Нужно установить Ollama и скачать модели', keyHint: '', keyLink: { url: 'https://ollama.com/download', label: 'Ollama download' } },
  'yandex-gpt': { order: 19, description: 'Модели Yandex Cloud для русского языка и корпоративных сценариев', keyHint: 'AQVN…', keyLink: { url: 'https://console.yandex.cloud/iam', label: 'Yandex Cloud Console' } },
  'gigachat': { order: 20, description: 'Модели Сбера для русского языка и российских бизнес-задач', keyHint: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', keyLink: { url: 'https://developers.sber.ru/portal/products/gigachat-api', label: 'developers.sber.ru' } },
  'custom-openai': { order: 21, name: 'Свой провайдер', description: 'Свой совместимый сервер: LM Studio, vLLM, локальная модель или корпоративный шлюз', keyHint: 'Если сервер требует ключ' },
}

const EMPTY_META: ProviderUiMeta = { order: 999, description: '', keyHint: '' }

/**
 * Слияние: функционал (models/transport/default/execMode/experimental) — из DTO
 * providers:list, презентация (name-override/описание/hint/ссылка/optIn/порядок) — из
 * UI-меты. Один источник моделей → дрейф Settings↔реестр структурно невозможен.
 */
export function mergeProviderCatalog(
  dto: ReadonlyArray<ProviderDescriptorDTO>,
  opts?: { source?: CatalogSource },
): CatalogProvider[] {
  const source = opts?.source ?? 'live'
  return dto
    .map((d): CatalogProvider => {
      const meta = PROVIDER_UI_META[d.id] ?? EMPTY_META
      return {
        id: d.id,
        name: meta.name ?? d.name,
        transport: d.transport,
        executionMode: d.executionMode,
        experimental: d.experimental,
        description: meta.description,
        models: d.models,
        defaultModel: d.defaultModel,
        secretKey: d.secretKey,
        keyHint: meta.keyHint,
        keyLink: meta.keyLink,
        optIn: meta.optIn,
        supportsTools: d.supportsTools,
        source,
      }
    })
    .sort((a, b) => (PROVIDER_UI_META[a.id]?.order ?? 999) - (PROVIDER_UI_META[b.id]?.order ?? 999))
}

/**
 * Подмешивает пользовательский список моделей в custom-openai.
 *
 * В main-реестре у этого провайдера models=[] намеренно: список задаёт пользователь
 * в Settings. Страница «Модели» при этом фильтрует пустые каталоги, поэтому без
 * проекции сохранённая custom-модель исчезает из UI, хотя рантайм уже умеет её запускать.
 */
export function withCustomOpenAiModels(
  providers: ReadonlyArray<CatalogProvider>,
  rawModels: string,
): CatalogProvider[] {
  const models = [...new Set(rawModels.split(',').map(model => model.trim()).filter(Boolean))]
  if (models.length === 0) return [...providers]

  return providers.map(provider => provider.id === 'custom-openai'
    ? {
        ...provider,
        models,
        defaultModel: models.includes(provider.defaultModel) ? provider.defaultModel : models[0],
      }
    : provider)
}

/** Доступность сохранённой модели относительно живого каталога провайдера. */
export function resolveModelAvailability(
  catalogModels: string[],
  stored: string | null | undefined,
): 'ok' | 'unavailable' | 'unset' {
  if (!stored) return 'unset'
  // Пустой каталог = провайдер с пользовательским списком (custom-openai/ollama):
  // модели задаёт сам пользователь, «недоступной» здесь быть не может.
  if (catalogModels.length === 0) return 'ok'
  return catalogModels.includes(stored) ? 'ok' : 'unavailable'
}

// ─── Bundled-снапшот: офлайн-fallback (карточка, шаг 6) ──────────────────────
// Если providers:list упал (main не ответил) — Settings не должен показать ПУСТО.
// Тогда берём этот снапшот с явной меткой source='bundled'. Это ЕДИНСТВЕННОЕ место в
// renderer, где модели скопированы намеренно (деградированный офлайн-режим); staleness
// честно помечается, а Model Doctor (2.0.7-E) её обновит. Функциональные производные
// (execMode/authKind/capabilities) считаются shared-хелперами — не копируются.
interface RawBundled {
  id: ProviderId
  name: string
  shortLabel: string
  transport: ProviderTransport
  secretKey: string | null
  models: string[]
  defaultModel: string
  supportsTools: boolean
}

const RAW_BUNDLED: RawBundled[] = [
  { id: 'verstak-gateway', name: 'Verstak Gateway', shortLabel: 'Gateway', transport: 'API', secretKey: 'verstak_gateway_api_key', models: ['kimi-k2.7-code', 'deepseek-chat', 'qwen3-coder', 'verstak/economy', 'verstak/free', 'verstak/balanced', 'verstak/coder', 'verstak/long', 'verstak/fast', 'verstak/private'], defaultModel: 'kimi-k2.7-code', supportsTools: true },
  { id: 'gemini-api', name: 'Gemini', shortLabel: 'Gemini', transport: 'API', secretKey: 'gemini_api_key', models: ['gemini-3-pro', 'gemini-3.5-flash', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'], defaultModel: 'gemini-3.5-flash', supportsTools: true },
  { id: 'gemini-cli', name: 'Gemini CLI', shortLabel: 'Gemini Ultra', transport: 'CLI', secretKey: null, models: ['auto', 'gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'], defaultModel: 'auto', supportsTools: false },
  { id: 'claude', name: 'Claude', shortLabel: 'Claude', transport: 'API', secretKey: 'anthropic_api_key', models: ['claude-sonnet-4-6', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'], defaultModel: 'claude-sonnet-4-6', supportsTools: true },
  { id: 'claude-cli', name: 'Claude Code', shortLabel: 'Claude Code', transport: 'Tunnel', secretKey: null, models: ['auto', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-haiku-4-5', 'claude-sonnet-4-5'], defaultModel: 'auto', supportsTools: false },
  { id: 'grok', name: 'Grok', shortLabel: 'Grok', transport: 'API', secretKey: 'xai_api_key', models: ['grok-4.5'], defaultModel: 'grok-4.5', supportsTools: true },
  { id: 'grok-cli', name: 'Grok Build', shortLabel: 'Grok Build', transport: 'CLI', secretKey: null, models: ['grok-4.5', 'grok-composer-2.5-fast'], defaultModel: 'grok-4.5', supportsTools: false },
  { id: 'openai', name: 'ChatGPT', shortLabel: 'ChatGPT', transport: 'API', secretKey: 'openai_api_key', models: ['gpt-5', 'gpt-5-mini', 'gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini'], defaultModel: 'gpt-5', supportsTools: true },
  { id: 'codex-cli', name: 'Codex', shortLabel: 'Codex', transport: 'CLI', secretKey: null, models: ['auto', 'gpt-5-codex', 'gpt-5', 'gpt-5-mini', 'o3', 'o3-mini', 'gpt-4o'], defaultModel: 'auto', supportsTools: false },
  { id: 'openai-codex-oauth', name: 'OpenAI Codex OAuth (Experimental)', shortLabel: 'Codex OAuth', transport: 'API', secretKey: 'codex_oauth_risk_accepted', models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'], defaultModel: 'gpt-5.6-sol', supportsTools: true },
  { id: 'openrouter', name: 'OpenRouter', shortLabel: 'OpenRouter', transport: 'API', secretKey: 'openrouter_api_key', models: ['anthropic/claude-opus-4-5', 'anthropic/claude-sonnet-4-6', 'openai/gpt-5', 'openai/gpt-5-mini', 'google/gemini-3-pro', 'google/gemini-3.5-flash', 'x-ai/grok-4.5', 'moonshotai/kimi-k2.7-code', 'deepseek/deepseek-v3', 'meta-llama/llama-3.3-70b-instruct'], defaultModel: 'anthropic/claude-sonnet-4-6', supportsTools: true },
  { id: 'deepseek', name: 'DeepSeek', shortLabel: 'DeepSeek', transport: 'API', secretKey: 'deepseek_api_key', models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'], defaultModel: 'deepseek-v4-flash', supportsTools: true },
  { id: 'moonshot', name: 'Moonshot Kimi', shortLabel: 'Kimi', transport: 'API', secretKey: 'moonshot_api_key', models: ['kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5', 'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'], defaultModel: 'kimi-k2.7-code', supportsTools: true },
  { id: 'kimi-coding', name: 'Kimi Code (подписка)', shortLabel: 'Kimi Code', transport: 'API', secretKey: 'kimi_coding_api_key', models: ['kimi-for-coding'], defaultModel: 'kimi-for-coding', supportsTools: true },
  { id: 'zai-coding', name: 'Z.ai GLM Coding (подписка)', shortLabel: 'GLM Coding', transport: 'API', secretKey: 'zai_coding_api_key', models: ['glm-5.2', 'glm-5-turbo'], defaultModel: 'glm-5.2', supportsTools: true },
  { id: 'qwen', name: 'Qwen (Alibaba)', shortLabel: 'Qwen', transport: 'API', secretKey: 'qwen_api_key', models: ['qwen3-max', 'qwen3-coder-plus', 'qwen3-coder-flash', 'qwen-max', 'qwen-plus', 'qwen-flash'], defaultModel: 'qwen3-coder-plus', supportsTools: true },
  { id: 'mistral', name: 'Mistral', shortLabel: 'Mistral', transport: 'API', secretKey: 'mistral_api_key', models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest', 'ministral-8b-latest'], defaultModel: 'mistral-large-latest', supportsTools: true },
  { id: 'groq', name: 'Groq', shortLabel: 'Groq', transport: 'API', secretKey: 'groq_api_key', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it'], defaultModel: 'llama-3.3-70b-versatile', supportsTools: true },
  { id: 'ollama', name: 'Ollama (local)', shortLabel: 'Ollama', transport: 'API', secretKey: null, models: ['llama3.3', 'qwen2.5-coder', 'deepseek-r1', 'mistral', 'gemma2'], defaultModel: 'llama3.3', supportsTools: true },
  { id: 'yandex-gpt', name: 'YandexGPT', shortLabel: 'YandexGPT', transport: 'API', secretKey: 'yandex_api_key', models: ['yandexgpt/latest', 'yandexgpt-lite/latest', 'yandexgpt-32k/latest'], defaultModel: 'yandexgpt/latest', supportsTools: true },
  { id: 'gigachat', name: 'GigaChat', shortLabel: 'GigaChat', transport: 'API', secretKey: 'gigachat_client_id', models: ['GigaChat', 'GigaChat-Plus', 'GigaChat-Pro', 'GigaChat-Max'], defaultModel: 'GigaChat', supportsTools: true },
  { id: 'custom-openai', name: 'Свой провайдер (OpenAI-compatible)', shortLabel: 'Custom', transport: 'API', secretKey: 'custom_openai_api_key', models: [], defaultModel: '', supportsTools: true },
]

/** Полный офлайн-снапшот как ProviderDescriptorDTO[] — производные поля через shared-хелперы. */
export const BUNDLED_PROVIDERS: ProviderDescriptorDTO[] = RAW_BUNDLED.map((r): ProviderDescriptorDTO => ({
  id: r.id,
  name: r.name,
  shortLabel: r.shortLabel,
  transport: r.transport,
  executionMode: executionModeFor(r.transport),
  authKind: authKindFor(r.id, r.transport, r.secretKey),
  secretKey: r.secretKey,
  models: r.models,
  defaultModel: r.defaultModel,
  supportsTools: r.supportsTools,
  experimental: EXPERIMENTAL_PROVIDER_IDS.includes(r.id),
  catalogSource: 'static',
  capabilities: capabilitiesFor(r.transport, r.supportsTools),
}))
