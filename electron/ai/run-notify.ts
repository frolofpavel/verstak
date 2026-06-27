/**
 * Push-наблюдаемость прогона в Telegram. РФ SMB-владелец запустил агента на ПК и
 * ушёл → телефон сообщает done / failed / нужен-ревью. ТОЛЬКО исходящее (ноль
 * входящей attack surface), opt-in по telegram_notify_chat_id, НИКОГДА не кидает —
 * наблюдаемость не должна ронять прогон. Переиспользует telegram-коннектор
 * (whitelist + rate-limit + secret-scan уже внутри него).
 */
import { createTelegramConnector } from '../connectors/telegram'
import type { AgentRunStatus } from '../storage/agent-runs'

export interface RunNotifyEvent {
  status: AgentRunStatus
  /** Уведомляем только про main-прогоны; review/delegate/background — спам. */
  owner?: string
  projectName: string | null
  costCents?: number
  toolCount?: number
  filesCount?: number
  durationMs?: number
  error?: string | null
}

/** Какие терминальные статусы достойны пуша. stopped = юзер сам остановил → молчим. */
export function shouldNotifyStatus(status: AgentRunStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'waiting_review'
}

/** Чистый форматтер сообщения (тестируемый). */
export function formatRunNotification(ev: RunNotifyEvent): string {
  const proj = ev.projectName ? ` · ${ev.projectName}` : ''
  if (ev.status === 'failed') {
    const err = ev.error ? `: ${ev.error.slice(0, 200)}` : ''
    return `❌ Verstak — прогон упал${proj}${err}`
  }
  if (ev.status === 'waiting_review') {
    return `👀 Verstak — прогон ждёт ревью${proj}`
  }
  const bits: string[] = []
  if (ev.toolCount) bits.push(`${ev.toolCount} инстр.`)
  if (ev.filesCount) bits.push(`${ev.filesCount} файлов`)
  if (typeof ev.costCents === 'number' && ev.costCents > 0) bits.push(`$${(ev.costCents / 100).toFixed(2)}`)
  if (ev.durationMs && ev.durationMs > 1000) bits.push(`${Math.round(ev.durationMs / 1000)}с`)
  const summary = bits.length ? ` — ${bits.join(' · ')}` : ''
  return `✅ Verstak — прогон завершён${proj}${summary}`
}

/**
 * Отправить уведомление о завершении прогона (opt-in, только исходящее, не кидает).
 * No-op если: не main-прогон / не уведомляемый статус / не настроен notify-чат / нет токена.
 */
export async function notifyRunEvent(
  ev: RunNotifyEvent,
  deps: { getSecret: (key: string) => string | null; signal?: AbortSignal }
): Promise<void> {
  try {
    if (ev.owner && ev.owner !== 'main') return
    if (!shouldNotifyStatus(ev.status)) return
    const chatId = deps.getSecret('telegram_notify_chat_id')
    if (!chatId) return // не настроено → no-op (фича выключена)
    if (!deps.getSecret('telegram_bot_token')) return
    const text = formatRunNotification(ev)
    const connector = createTelegramConnector()
    await connector.query(
      { op: 'send_message', chat_id: chatId, text },
      { getSecret: deps.getSecret, signal: deps.signal ?? new AbortController().signal }
    )
  } catch { /* наблюдаемость не должна ронять прогон */ }
}
