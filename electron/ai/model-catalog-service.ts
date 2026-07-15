// Срез 2.0.7-E: сервис живого каталога моделей. Кеширует ТОЛЬКО id + timestamp (карточка
// шаг 5), TTL 24 часа. Источник и срок жизни — явные. Гейт (checkModelAvailable) блокирует
// запуск child-процесса на ПОДТВЕРЖДЁННО отсутствующей модели (карточка шаг 6, acceptance).
//
// Безопасность: в кеш и наружу — только id-строки/числа/коды. Ни токенов, ни путей, ни
// сырого stdout. Персист — через переданный key/value store (settings), не знает про БД.

import type { DiscoveryResult } from './model-discovery'

export type CatalogStatus = 'available' | 'stale' | 'unavailable' | 'unknown'
export type CatalogSource = 'bundled' | 'cli-live' | 'provider-api' | 'user'

export interface LiveCatalogEntry {
  providerId: string
  source: CatalogSource
  /** id доступных моделей (обезличено). */
  ids: string[]
  defaultModel: string | null
  /**
   * Был ли аккаунт аутентифицирован при обнаружении. Неаутентифицированный `grok models`
   * отдаёт статический (возможно НЕПОЛНЫЙ) каталог → блокировать по нему нельзя (ложно
   * отсечёт модель реального аккаунта). Гейт блокирует ТОЛЬКО по authenticated=true.
   */
  authenticated: boolean
  fetchedAt: number
  expiresAt: number
}

export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000

/**
 * DTO статуса живого каталога для renderer (providers:doctor / providers:refresh-models).
 * Только обезличенные поля: id-строки, флаги, timestamps, машинный reasonCode. Ни токенов,
 * ни путей, ни сырого stdout. Реэкспортируется в src/types/api.d.ts (как ProviderDescriptorDTO).
 */
export interface ProviderCatalogStatusDTO {
  providerId: string
  status: CatalogStatus
  ids: string[]
  defaultModel: string | null
  source: CatalogSource
  /** Был ли аккаунт аутентифицирован при обнаружении (иначе каталог может быть неполон). */
  authenticated: boolean
  fetchedAt?: number
  expiresAt?: number
  /** Машинный код (UPPER_SNAKE) для empty/error/no-adapter. */
  reasonCode?: string
}

/** Минимальный store: settings key/value (значение — JSON-строка). */
export interface CatalogStore {
  get(key: string): string | null | undefined
  set(key: string, value: string): void
}

export function catalogKey(providerId: string): string {
  return `model_catalog_${providerId}`
}

/** Сохранить результат обнаружения в кеш (только id+timestamp+source). */
export function saveLiveCatalog(
  store: CatalogStore,
  providerId: string,
  result: Pick<DiscoveryResult, 'models' | 'defaultModel' | 'authenticated'>,
  now: number,
  source: CatalogSource = 'cli-live',
): LiveCatalogEntry {
  const entry: LiveCatalogEntry = {
    providerId,
    source,
    ids: [...result.models],
    defaultModel: result.defaultModel,
    authenticated: result.authenticated,
    fetchedAt: now,
    expiresAt: now + CATALOG_TTL_MS,
  }
  store.set(catalogKey(providerId), JSON.stringify(entry))
  return entry
}

/** Прочитать кеш. null — нет записи (никогда не обнаруживали). Битый JSON → null (не падаем). */
export function loadLiveCatalog(store: CatalogStore, providerId: string): LiveCatalogEntry | null {
  const raw = store.get(catalogKey(providerId))
  if (!raw) return null
  try {
    const e = JSON.parse(raw) as LiveCatalogEntry
    if (!e || !Array.isArray(e.ids) || typeof e.expiresAt !== 'number') return null
    // Старая запись без поля authenticated → консервативно false (не блокировать по ней).
    if (typeof e.authenticated !== 'boolean') e.authenticated = false
    return e
  } catch {
    return null
  }
}

/** Статус каталога относительно текущего времени. */
export function catalogStatus(entry: LiveCatalogEntry | null, now: number): CatalogStatus {
  if (!entry) return 'unknown'
  if (now > entry.expiresAt) return 'stale'
  return 'available'
}

export interface ModelGateResult {
  /** true — запуск разрешён; false — заблокирован (МODEL_UNAVAILABLE). */
  ok: boolean
  reasonCode?: 'MODEL_UNAVAILABLE'
  /** Доступные id (для one-click repair), когда заблокировано. */
  available?: string[]
  /** Рекомендуемая замена (дефолт живого каталога), если есть. */
  suggested?: string | null
}

/**
 * Гейт перед child-процессом. Блокирует ТОЛЬКО при ПОДТВЕРЖДЁННОМ отсутствии модели:
 * есть СВЕЖИЙ, АУТЕНТИФИЦИРОВАННЫЙ живой каталог, и модели в нём НЕТ. Иначе — разрешаем:
 *  - нет каталога (никогда не обнаруживали) → unknown, не гадаем, пропускаем;
 *  - каталог протух (stale) → не уверены, пропускаем (doctor обновит отдельно);
 *  - каталог НЕаутентифицирован → может быть неполным, ложно отсёк бы модель реального
 *    аккаунта — пропускаем;
 *  - 'auto'/пустая модель → CLI сам выберет, не блокируем.
 * Так «сохранённый grok-build, которого нет в живом каталоге, не уходит в backend», но
 * мы не ломаем работу, когда каталога ещё нет/он неполон (карточка шаг 7 — не менять
 * route молча без подтверждения).
 */
export function checkModelAvailable(
  entry: LiveCatalogEntry | null,
  model: string | null | undefined,
  now: number,
): ModelGateResult {
  if (!model || model === 'auto') return { ok: true }
  if (!entry) return { ok: true }                 // unknown — не гадаем
  if (!entry.authenticated) return { ok: true }   // неполный каталог — не блокируем
  if (now > entry.expiresAt) return { ok: true }  // stale — не уверены
  // Ревью F1: ПУСТОЙ каталог (grok сменил маркер списка / ANSI / пагинация → 0 моделей
  // при exit 0) не даёт права блокировать — иначе заблокировали бы ВСЁ, включая дефолт,
  // на 24ч (самоблок). Из пустого списка нельзя подтвердить отсутствие.
  if (entry.ids.length === 0) return { ok: true }
  if (entry.ids.includes(model)) return { ok: true }
  return {
    ok: false,
    reasonCode: 'MODEL_UNAVAILABLE',
    available: [...entry.ids],
    suggested: entry.defaultModel ?? entry.ids[0] ?? null,
  }
}
