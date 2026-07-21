import type { ChatEvent } from '../types/api'

/**
 * 2.1.3-CD: человеческая подпись события route-changed для Activity/Timeline.
 *
 * Раньше main при ротации аккаунта слал отдельную эфемерную info-пилюлю — она
 * терялась при reload и дублировала структурное событие. Теперь main шлёт ТОЛЬКО
 * структурное route-changed (с resetAt и label'ами аккаунтов), а подпись строит
 * renderer — один источник правды, никаких рассинхронов текста и данных.
 *
 * Правила честности (карточка CD):
 * - ротация АККАУНТА и fallback МОДЕЛИ — разные события, разные подписи;
 * - причина по-русски (quota ≠ rate-limit — разные коды, разные подписи);
 * - срок восстановления — только когда реально известен; неизвестный срок НЕ
 *   превращается в выдуманное время или «безлимит»;
 * - аккаунты зовутся label'ами — внутренние id наружу не показываем.
 */

type RouteChanged = Extract<ChatEvent, { type: 'route-changed' }>

const REASON_LABELS: Record<string, string> = {
  quota: 'квота исчерпана',
  'rate-limit': 'лимит частоты',
  auth: 'ошибка авторизации',
  'provider-unavailable': 'провайдер недоступен',
  // EF S6: pre-flight ротация (ДО сети) — аккаунт пропущен resolver'ом, а не упал запросом.
  cooling: 'аккаунт остывает после лимита',
  'login-required': 'требуется вход',
}

function shortTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function routeChangedActivity(e: RouteChanged): { label: string; detail: string } {
  const reason = REASON_LABELS[e.reason] ?? e.reason
  if (e.action === 'rotate-account') {
    // Легаси-событие (старый main без accounts) — называем провайдера, не падаем.
    if (!e.accounts) {
      return { label: `⇄ ${e.requested.providerId}: смена аккаунта`, detail: reason }
    }
    const from = e.accounts.fromLabel ?? '?'
    const to = e.accounts.toLabel ?? '?'
    const suffix = e.resetAt != null ? ` · до ${shortTime(e.resetAt)}` : ''
    return { label: `⇄ Аккаунт ${from} → ${to}`, detail: `${reason}${suffix}` }
  }
  if (e.action === 'model-fallback') {
    const model = e.actual.model ? `${e.actual.model} · ` : ''
    return {
      label: `⚡ ${e.requested.providerId} → ${e.actual.providerId}`,
      detail: `${model}${reason}`,
    }
  }
  // refresh-auth
  return { label: `↻ ${e.requested.providerId}: обновление входа`, detail: reason }
}
