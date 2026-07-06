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

export interface ProviderLite {
  id: ProviderId
  name: string
  transport: 'API' | 'CLI'
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
  transport: 'API' | 'CLI'
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
  'grok-4.3':                    { input: 1.25, output: 2.50 },
  'grok-build-0.1':              { input: 1.00, output: 2.00 },
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
  opts?: { customOpenaiBaseUrl?: string }
): boolean {
  if (provider.id === 'ollama') return true
  if (provider.id === 'custom-openai') return Boolean(opts?.customOpenaiBaseUrl?.trim())
  const status = connectionStatus(provider.id, provider.secretKey ?? null, keys)
  if (status === 'ready') return true
  if (provider.transport === 'CLI') {
    const cli = cliStatus?.[provider.id as CliAuthId]
    return Boolean(cli?.loggedIn)
  }
  return false
}

/**
 * Fuzzy-ish search: term должен встретиться как substring в любом из:
 * model name, provider name, tags. Регистронезависимо. Пусто = всё.
 */
