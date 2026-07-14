import { useEffect, useState, useCallback } from 'react'
import type { ProviderDescriptorDTO } from '../types/api'
import {
  DEFAULT_PROVIDER_ID,
  resolveStoredProviderId,
  type ProviderId,
  type ProviderTransport,
} from '../../shared/contracts/provider'

// 2.0.7-C: renderer БОЛЬШЕ не держит свою копию ProviderId и свой allowlist KNOWN_IDS —
// это был второй и третий источник правды, и они разъезжались с реестром main
// (так пропал openai-codex-oauth: он был в реестре, но не в KNOWN_IDS → выбор
// пользователя молча схлопывался в gemini-api). Теперь один контракт на оба процесса.
export type { ProviderId } from '../../shared/contracts/provider'

export interface ProviderInfo {
  id: ProviderId
  /** Short human label shown in chat status — e.g. "Gemini", "Claude", "Grok" */
  label: string
  /** Currently selected model id for this provider */
  model: string
  /** "API" or "CLI" */
  transport: ProviderTransport
  /** All available models user can switch to */
  models: string[]
  /** Whether this provider has function calling in our app right now */
  supportsTools: boolean
  /**
   * Сохранённый провайдер не опознан (сборка его не знает) → показан дефолт, но факт
   * подмены НЕ прячем: раньше он терялся молча. UI-баннер поверх этого — срез 2.0.7-D.
   */
  unavailableProviderId: string | null
}

// --- Кеш провайдеров: грузим один раз из main process через IPC ---

export interface ProviderMeta {
  label: string
  transport: ProviderTransport
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

/**
 * Repair-путь сохранённой модели (срез 5, §2.2): сохранённая model ID может стать
 * невалидной (провайдер убрал модель, дрейф списков, старый конфиг). Тогда вместо
 * длинного прогона с финальной ошибкой «unknown model id» откатываемся на дефолт
 * провайдера. Чистая функция — meta передаётся явно, чтобы путь был проверяем тестом.
 *
 * Контракт:
 *  - нет meta (дескрипторы ещё не загружены / IPC упал) → отдаём как есть, не гадаем;
 *  - модель пустая → дефолт провайдера;
 *  - у провайдера пустой список моделей (custom-openai/ollama — задаёт пользователь)
 *    → любая непустая модель валидна, отдаём как есть;
 *  - модель вне списка → REPAIR: дефолт провайдера.
 */
export function normalizeStoredModel(meta: ProviderMeta | undefined, model: string | null): string {
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

/**
 * Резолв сохранённого provider-id. Список известных ID — из shared-контракта, второго
 * allowlist'а в renderer больше нет (см. комментарий вверху файла).
 * Неизвестный id по-прежнему приводит к дефолту (иначе приложение не запустится), но
 * ФАКТ подмены доступен через `resolveStoredProviderId` и попадает в `useProvider`.
 */
export function parseProviderId(v: string | null | undefined): ProviderId {
  return resolveStoredProviderId(v).id
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
  const [id, setId] = useState<ProviderId>(DEFAULT_PROVIDER_ID)
  const [model, setModelState] = useState<string>('')
  const [unavailableProviderId, setUnavailable] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    await ensureProvidersLoaded()
    const rawId = await window.api.settings.getKey('provider')
    const resolved = resolveStoredProviderId(rawId)
    setId(resolved.id)
    setUnavailable(resolved.unavailable ? resolved.requested : null)
    const rawModel = await window.api.settings.getKey(`model_${resolved.id}`)
    setModelState(normalizeStoredModel(_providerCache?.[resolved.id], rawModel))
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => { if (!cancelled) await refresh() })()
    const t = window.setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
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
    setUnavailable(null)
    const stored = await window.api.settings.getKey(`model_${next}`)
    setModelState(normalizeStoredModel(_providerCache?.[next], stored))
  }, [])

  const meta = getMeta(id)
  return { id, label: meta.label, model, transport: meta.transport, models: meta.models, supportsTools: meta.supportsTools, unavailableProviderId, setModel, setProviderModel, setProviderId }
}
