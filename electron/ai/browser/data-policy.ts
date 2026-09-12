// data-policy.ts — ClientDataPolicy (план §6, инвариант 14).
//
// «У клиента есть data classification и provider allowlist. DOM, screenshot и
// client context нельзя автоматически передать новому провайдеру при fallback,
// пока policy не разрешила этот provider для данного клиента/класса данных.»
//
// Здесь — чистая логика решения «может ли провайдер видеть browser context».
// Источник самих policies — settings/client card (в B0 — default 'ask', явный
// allowlist пока не настраивается; в Phase E — per-client настройки).

import type { ClientDataPolicy } from './types'

export const DEFAULT_DATA_POLICY: ClientDataPolicy = {
  clientId: null,
  providerAllow: 'ask',
  allowedProviders: [],
  deniedProviders: [],
  dataClassification: 'internal',
  redactScreenshotsByDefault: true,
}

/**
 * B0 local webview (без client card): разрешаем browser context текущему
 * провайдеру, screenshot по умолчанию redact. Не client-bound Chrome path —
 * для него остаётся DEFAULT_DATA_POLICY.ask до явного grant.
 */
export function localWebviewDataPolicy(_providerId?: string | null): ClientDataPolicy {
  return {
    clientId: null,
    providerAllow: 'allow',
    // пустой allowlist + allow = все не-denied (см. decideProviderBrowserContext)
    allowedProviders: [],
    deniedProviders: [],
    dataClassification: 'internal',
    redactScreenshotsByDefault: true,
  }
}

/** Восстановить ClientDataPolicy из persisted JSON (browser_tasks.data_policy_json). */
export function parseClientDataPolicy(raw: Record<string, unknown> | null | undefined): ClientDataPolicy | null {
  if (!raw || typeof raw !== 'object') return null
  const pa = raw.providerAllow
  if (pa !== 'allow' && pa !== 'deny' && pa !== 'ask') return null
  const dc = raw.dataClassification
  return {
    clientId: raw.clientId == null ? null : String(raw.clientId),
    providerAllow: pa,
    allowedProviders: Array.isArray(raw.allowedProviders) ? raw.allowedProviders.map(String) : [],
    deniedProviders: Array.isArray(raw.deniedProviders) ? raw.deniedProviders.map(String) : [],
    dataClassification: (dc === 'public' || dc === 'internal' || dc === 'sensitive') ? dc : 'internal',
    redactScreenshotsByDefault: raw.redactScreenshotsByDefault !== false,
  }
}

export type ProviderBrowserContextDecision =
  | { kind: 'allow' }                            // можно передать DOM/screenshot
  | { kind: 'deny'; reason: string }             // запрещено — run блокируется
  | { kind: 'ask'; reason: string }              // нужно явное решение Павла
  | { kind: 'redact-screenshot-only' }           // DOM можно, screenshot — нет

/**
 * Решает, может ли провайдер видеть browser context (observation + screenshot)
 * для данного клиента с его data policy.
 *
 * Логика:
 *   • Если провайдер в deniedProviders → deny.
 *   • Если dataClassification='sensitive' → всегда 'ask', даже для allow'а.
 *   • Если providerAllow='allow' и провайдер в allowedProviders (или список
 *     пустой = «все из allow») → allow (но если redactScreenshotsByDefault —
 *     redact-screenshot-only).
 *   • Если providerAllow='deny' → deny.
 *   • Иначе → ask.
 */
export function decideProviderBrowserContext(
  policy: ClientDataPolicy,
  providerId: string,
): ProviderBrowserContextDecision {
  if (!providerId) {
    return { kind: 'deny', reason: 'providerId пуст — нельзя передать browser context неизвестному провайдеру.' }
  }
  if (policy.deniedProviders?.includes(providerId)) {
    return { kind: 'deny', reason: `Провайдер ${providerId} в denylist клиента.` }
  }
  if (policy.dataClassification === 'sensitive') {
    return { kind: 'ask', reason: `Данные клиента классифицированы как sensitive — требуется явное решение Павла для провайдера ${providerId}.` }
  }
  if (policy.providerAllow === 'deny') {
    return { kind: 'deny', reason: `ClientDataPolicy.providerAllow='deny' — browser context не передаётся провайдерам автоматически.` }
  }
  if (policy.providerAllow === 'allow') {
    // Если allowedProviders пустой — разрешаем всем не-denied. Иначе — только
    // перечисленным.
    if (policy.allowedProviders && policy.allowedProviders.length > 0) {
      if (!policy.allowedProviders.includes(providerId)) {
        return { kind: 'deny', reason: `Провайдер ${providerId} не в allowedProviders клиента.` }
      }
    }
    // redactScreenshotsByDefault — screenshot не уходит автоматически.
    if (policy.redactScreenshotsByDefault) {
      return { kind: 'redact-screenshot-only' }
    }
    return { kind: 'allow' }
  }
  // providerAllow === 'ask' (default)
  return { kind: 'ask', reason: `ClientDataPolicy.providerAllow='ask' — требуется явное решение Павла для передачи browser context провайдеру ${providerId}.` }
}

/**
 * Помечает policy как «provider X явно разрешён для этого клиента» (после
 * решения Павла в 'ask'-сценарии). Возвращает обновлённый policy — controller
 * сохраняет его в task.dataPolicy.
 */
export function grantProviderAccess(policy: ClientDataPolicy, providerId: string): ClientDataPolicy {
  const allowed = new Set(policy.allowedProviders ?? [])
  allowed.add(providerId)
  return {
    ...policy,
    providerAllow: 'allow',
    allowedProviders: Array.from(allowed),
  }
}

/**
 * Помечает провайдера как явно запрещённого (после решения Павла или автоматически
 * при security-событии).
 */
export function revokeProviderAccess(policy: ClientDataPolicy, providerId: string): ClientDataPolicy {
  const denied = new Set(policy.deniedProviders ?? [])
  denied.add(providerId)
  const allowed = new Set(policy.allowedProviders ?? [])
  allowed.delete(providerId)
  return {
    ...policy,
    deniedProviders: Array.from(denied),
    allowedProviders: Array.from(allowed),
  }
}
