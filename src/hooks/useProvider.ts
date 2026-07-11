import { useEffect, useState, useCallback } from 'react'
import type { ProviderDescriptorDTO } from '../types/api'

// Renderer-side зеркало ProviderId из electron/ai/registry.ts. Держим в синхроне
// при добавлении новых провайдеров (electron/ai/extra-providers.ts).
export type ProviderId =
  | 'gemini-api' | 'gemini-cli'
  | 'claude' | 'claude-cli'
  | 'grok' | 'grok-cli'
  | 'openai' | 'codex-cli'
  | 'yandex-gpt' | 'gigachat'
  | 'openrouter' | 'deepseek' | 'moonshot' | 'kimi-coding' | 'qwen' | 'mistral' | 'groq' | 'ollama' | 'custom-openai' | 'verstak-gateway' | 'zai-coding'

export interface ProviderInfo {
  id: ProviderId
  /** Short human label shown in chat status — e.g. "Gemini", "Claude", "Grok" */
  label: string
  /** Currently selected model id for this provider */
  model: string
  /** "API" or "CLI" */
  transport: 'API' | 'CLI' | 'Tunnel'
  /** All available models user can switch to */
  models: string[]
  /** Whether this provider has function calling in our app right now */
  supportsTools: boolean
}

// --- Кеш провайдеров: грузим один раз из main process через IPC ---

interface ProviderMeta {
  label: string
  transport: 'API' | 'CLI' | 'Tunnel'
  models: string[]
  supportsTools: boolean
  defaultModel: string
  secretKey: string | null
}

/** Загруженные из main process дескрипторы. null = ещё не загружены. */
let _providerCache: Record<string, ProviderMeta> | null = null
let _loadPromise: Promise<void> | null = null

function ensureProvidersLoaded(): Promise<void> {
  if (_providerCache) return Promise.resolve()
  if (_loadPromise) return _loadPromise
  _loadPromise = window.api.providers.list().then((list: ProviderDescriptorDTO[]) => {
    const map: Record<string, ProviderMeta> = {}
    for (const p of list) {
      map[p.id] = {
        label: p.shortLabel || p.name,
        transport: p.transport,
        models: p.models,
        supportsTools: p.supportsTools,
        defaultModel: p.defaultModel,
        secretKey: p.secretKey
      }
    }
    _providerCache = map
  }).catch(() => {
    // Fallback: если IPC недоступен, оставляем null — getMeta вернёт заглушку
    _loadPromise = null
  })
  return _loadPromise
}

function getMeta(id: string): ProviderMeta {
  if (_providerCache && _providerCache[id]) return _providerCache[id]
  // Заглушка до загрузки — minimal safe defaults
  return { label: id, transport: 'API', models: [], supportsTools: false, defaultModel: '', secretKey: null }
}

function getDefaultModel(id: string): string {
  if (_providerCache && _providerCache[id]) return _providerCache[id].defaultModel
  return ''
}

function normalizeStoredModel(providerId: string, model: string | null): string {
  const meta = _providerCache?.[providerId]
  if (!meta) return model ?? ''
  if (!model) return meta.defaultModel
  if (meta.models.length === 0) return model
  return meta.models.includes(model) ? model : meta.defaultModel
}

/** Проверка валидности модели для провайдера (используется в projectStore). */
export function isModelValidForProvider(providerId: string, model: string): boolean {
  const meta = _providerCache?.[providerId]
  if (!meta) return false
  // custom-openai: пользователь задаёт модели сам — любая непустая строка валидна
  if (meta.models.length === 0) return model.length > 0
  return meta.models.includes(model)
}

const KNOWN_IDS: ProviderId[] = [
  'gemini-api', 'gemini-cli', 'claude', 'claude-cli', 'grok', 'grok-cli', 'openai', 'codex-cli',
  'yandex-gpt', 'gigachat',
  'openrouter', 'deepseek', 'moonshot', 'kimi-coding', 'qwen', 'mistral', 'groq', 'ollama', 'custom-openai', 'verstak-gateway', 'zai-coding'
]

function parseProviderId(v: string | null | undefined): ProviderId {
  if (v && (KNOWN_IDS as string[]).includes(v)) return v as ProviderId
  return 'gemini-api'
}

const POLL_INTERVAL_MS = 1500

interface UseProviderResult extends ProviderInfo {
  /** Persist a new model id for the active provider and refresh state. */
  setModel: (model: string) => Promise<void>
  /** Persist a model for a specific provider, even before React state switches to that provider. */
  setProviderModel: (providerId: ProviderId, model: string) => Promise<void>
  /** Switch to a different provider; existing model selection per provider is preserved. */
  setProviderId: (id: ProviderId) => Promise<void>
}

export function useProvider(): UseProviderResult {
  const [id, setId] = useState<ProviderId>('gemini-api')
  const [model, setModelState] = useState<string>('')

  const refresh = useCallback(async () => {
    await ensureProvidersLoaded()
    const rawId = await window.api.settings.getKey('provider')
    const pid = parseProviderId(rawId)
    setId(pid)
    const rawModel = await window.api.settings.getKey(`model_${pid}`)
    setModelState(normalizeStoredModel(pid, rawModel))
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => { if (!cancelled) await refresh() })()
    const t = window.setInterval(refresh, POLL_INTERVAL_MS)
    return () => { cancelled = true; window.clearInterval(t) }
  }, [refresh])

  const setModel = useCallback(async (next: string) => {
    await window.api.settings.setKey(`model_${id}`, next)
    setModelState(next)
  }, [id])

  const setProviderModel = useCallback(async (providerId: ProviderId, next: string) => {
    await window.api.settings.setKey(`model_${providerId}`, next)
    if (providerId === id) setModelState(next)
  }, [id])

  const setProviderId = useCallback(async (next: ProviderId) => {
    await window.api.settings.setKey('provider', next)
    setId(next)
    const stored = await window.api.settings.getKey(`model_${next}`)
    setModelState(normalizeStoredModel(next, stored))
  }, [])

  const meta = getMeta(id)
  return { id, label: meta.label, model, transport: meta.transport, models: meta.models, supportsTools: meta.supportsTools, setModel, setProviderModel, setProviderId }
}
