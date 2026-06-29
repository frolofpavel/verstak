// Per-mode model binding (ось 3, кластер A) — модель привязана к режиму агента.
// При переключении 1-5 модель авто-свопится: plan → reasoning-модель, act/auto →
// дешёвый кодер. Хранится per-provider: mode_models_<provider> = JSON {mode: model}.
// Чистая логика (без React/IPC) — тестируемо.

import type { AgentMode } from '../components/ModePicker'

/** Ключ настройки карты «режим → модель» для провайдера. */
export function modeModelsKey(providerId: string): string {
  return `mode_models_${providerId}`
}

/** Безопасный парс JSON-карты {mode: model}. Битый/не-объект → {}. */
export function parseModeModels(raw: string | null | undefined): Record<string, string> {
  if (!raw || !raw.trim()) return {}
  try {
    const obj = JSON.parse(raw)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(obj)) if (typeof v === 'string' && v.trim()) out[k] = v
      return out
    }
  } catch { /* битый JSON → нет привязок */ }
  return {}
}

/** Модель для режима или null (нет привязки → оставить текущую). */
export function resolveModeModel(map: Record<string, string>, mode: AgentMode): string | null {
  return map[mode] ?? null
}

/** Сериализовать карту обратно в настройку (пустые значения отбрасываются). */
export function serializeModeModels(map: Record<string, string>): string {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(map)) if (v && v.trim()) clean[k] = v.trim()
  return Object.keys(clean).length ? JSON.stringify(clean) : ''
}
