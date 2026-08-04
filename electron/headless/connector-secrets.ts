import { createConnectorRegistry } from '../connectors/registry'
import type { ConnectorInfo } from '../connectors/types'
import { STAGE1_CONNECTOR_DENY } from './stage1'

// Ключи коннекторов тенанта для облачного Verstak (задача W5).
//
// Ядро умело хранить секреты тенанта (secure-storage.ts + tenants.ts), но снаружи их
// нечем было ЗАДАТЬ — из-за этого «собери отчёт по моему Директу» облачному пользователю
// был недостижим. Здесь — вся логика ручек /connectors, отдельно от HTTP-слоя, чтобы её
// можно было проверять без сокета.
//
// Дисциплина всего файла: наружу уходят ТОЛЬКО ИМЕНА ключей, никогда значения. Это тот
// же принцип, что у withHonestStatus в connectors/registry.ts, и он держится здесь
// структурно: ни одна возвращаемая форма не содержит поля со значением секрета.

/** Публичная форма коннектора для кабинета. Значений секретов в ней нет по построению. */
export interface ConnectorSecretsView {
  id: string
  label: string
  kind: string
  status: ConnectorInfo['status']
  /** Ключи, от которых зависит статус (requires + requiresAnyOf). */
  requiredKeys: string[]
  /**
   * Имена НЕобязательных ключей коннектора (`optional`): адаптер их читает, на статус они
   * не влияют. Без этого списка кабинет физически не может предложить задать ещё не
   * заданный необязательный ключ — он знает только requiredKeys и configuredKeys, а
   * `yandex_direct_login` / `telegram_chat_whitelist` не входят ни в те, ни в другие,
   * пока не заданы. Имена, не значения: как и все поля этой формы.
   */
  optionalKeys: string[]
  /** Из requiredKeys те, из-за которых статус НЕ ready. Пусто ⇔ status === 'ready'. */
  missingKeys: string[]
  /** Имена ключей коннектора, которые заданы у этого тенанта (значения не выдаются). */
  configuredKeys: string[]
}

/** Хранилище секретов тенанта. Ровно три операции — больше ручкам не нужно. */
export interface TenantSecretStore {
  getSecret: (key: string) => string | null
  setSecret: (key: string, value: string) => void
  deleteSecret: (key: string) => void
}

export type ConnectorSecretsFailure =
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'bad-body'; message: string }
  | { ok: false; reason: 'unknown-key'; message: string }

export type ConnectorSecretsResult =
  | { ok: true; view: ConnectorSecretsView }
  | ConnectorSecretsFailure

/** Ключ заполнен, только если в нём есть непробельный текст (правило registry.filled). */
function filled(store: TenantSecretStore, key: string): boolean {
  return (store.getSecret(key) ?? '').trim().length > 0
}

/** Все ключи, которые коннектор объявил своими: обязательные, «любой из», необязательные. */
export function connectorKeySurface(info: ConnectorInfo): string[] {
  return [...new Set([...(info.requires ?? []), ...(info.requiresAnyOf ?? []), ...(info.optional ?? [])])]
}

function toView(info: ConnectorInfo, store: TenantSecretStore): ConnectorSecretsView {
  const requires = info.requires ?? []
  const anyOf = info.requiresAnyOf ?? []
  // missingKeys повторяет решение withHonestStatus, а не «всё незаполненное»: если группа
  // requiresAnyOf удовлетворена, остальные её ключи НЕ недостающие — иначе ready-коннектор
  // приходил бы в кабинет со списком «не хватает», и кабинет требовал бы лишнего.
  const missing = [
    ...requires.filter(k => !filled(store, k)),
    ...(anyOf.length > 0 && !anyOf.some(k => filled(store, k)) ? anyOf : [])
  ]
  return {
    id: info.id,
    label: info.label,
    kind: info.kind,
    status: info.status,
    requiredKeys: [...new Set([...requires, ...anyOf])],
    optionalKeys: [...new Set(info.optional ?? [])],
    missingKeys: missing,
    configuredKeys: connectorKeySurface(info).filter(k => filled(store, k))
  }
}

/**
 * Коннекторы тенанта. Отключённые на Этапе 1 (ssh) не «серые», а отсутствуют физически —
 * тот же fail-closed, что в host.ts: списка, в котором их нет, достаточно, чтобы кабинет
 * даже не предлагал их настроить.
 */
export function listConnectorSecretViews(store: TenantSecretStore): ConnectorSecretsView[] {
  // Статус берём из registry.list() — единственного места, где живёт withHonestStatus.
  // Своя копия правила здесь разошлась бы с продовой при первой же правке.
  return createConnectorRegistry(store.getSecret).list()
    .filter(info => !STAGE1_CONNECTOR_DENY.has(info.id))
    .map(info => toView(info, store))
}

/** Один коннектор. null — неизвестен ИЛИ запрещён на сервере (наружу это один и тот же 404). */
function findInfo(store: TenantSecretStore, id: string): ConnectorInfo | null {
  if (STAGE1_CONNECTOR_DENY.has(id)) return null
  return createConnectorRegistry(store.getSecret).list().find(i => i.id === id) ?? null
}

/**
 * Установить ключи коннектора. Ключ, который коннектор не объявлял своим, — отказ, а не
 * тихая запись: молча принятая опечатка выглядела бы как «ключ задан», а коннектор
 * продолжал бы отвечать «не настроено».
 */
export function applyConnectorSecrets(
  store: TenantSecretStore,
  id: string,
  body: unknown
): ConnectorSecretsResult {
  const info = findInfo(store, id)
  if (!info) return { ok: false, reason: 'not-found' }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'bad-body', message: 'body must be an object of key/value pairs' }
  }
  const entries = Object.entries(body as Record<string, unknown>)
  const surface = new Set(connectorKeySurface(info))
  for (const [key, value] of entries) {
    if (!surface.has(key)) return { ok: false, reason: 'unknown-key', message: 'unknown key for connector' }
    if (typeof value !== 'string') {
      return { ok: false, reason: 'bad-body', message: `value for "${key}" must be a string` }
    }
  }
  // Проверили ВСЁ тело и только потом пишем: иначе запрос с одним плохим ключом оставлял бы
  // половину применённой — состояние, о котором клиент не узнал бы из кода ответа.
  for (const [key, value] of entries) store.setSecret(key, value as string)
  return { ok: true, view: toView(findInfo(store, id) ?? info, store) }
}

/**
 * Снять ключи коннектора. Пустой/отсутствующий список — снять все ключи этого коннектора.
 * Идемпотентно: снятие уже отсутствующего ключа — обычный успех.
 */
export function clearConnectorSecrets(
  store: TenantSecretStore,
  id: string,
  body: unknown
): ConnectorSecretsResult {
  const info = findInfo(store, id)
  if (!info) return { ok: false, reason: 'not-found' }
  let keys: string[] = connectorKeySurface(info)
  if (body !== null && typeof body === 'object' && !Array.isArray(body) && 'keys' in body) {
    const raw = (body as { keys: unknown }).keys
    if (raw !== undefined && raw !== null) {
      if (!Array.isArray(raw) || raw.some(k => typeof k !== 'string')) {
        return { ok: false, reason: 'bad-body', message: 'keys must be an array of strings' }
      }
      const surface = new Set(connectorKeySurface(info))
      for (const k of raw as string[]) {
        if (!surface.has(k)) return { ok: false, reason: 'unknown-key', message: 'unknown key for connector' }
      }
      if (raw.length > 0) keys = raw as string[]
    }
  }
  for (const key of keys) store.deleteSecret(key)
  return { ok: true, view: toView(findInfo(store, id) ?? info, store) }
}
