// VSK-BROWSER-B2 блок 2: редакция консоли и сети ПЕРЕД отдачей модели.
//
// ТРЕБОВАНИЕ №4 (постановщик): и консоль, и сеть идут наружу через редакцию. В
// заголовках живёт авторизация (Authorization/Cookie/x-api-key), в телах —
// персональные данные. Сырьё в контекст модели НЕ отдаём. Захват сырого делает
// renderer (webview-событие console-message; хук fetch/XHR в странице), а редакция —
// ЗДЕСЬ, в main, где живёт secret-scanner (renderer его не импортирует). Пин на
// редакцию обязателен: заголовок замаскирован, URL-токен погашен, тело не уходит.
import { redactForDisplay, redactUrlSecrets } from '../../ai/secret-scanner'
import { normalizeConsoleLevel, type ConsoleLevel } from '../../../shared/browser-console-record'

// Заголовки, несущие секрет/сессию — маскируем ЦЕЛИКОМ (не отпечаток: даже хвост
// bearer'а — утечка). Список — по имени, а не по значению: значение произвольно.
const AUTH_HEADER_RE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|apikey|api-key|x-auth-token|x-amz-security-token|x-csrf-token|www-authenticate)$/i

export interface RawNetEntry { method?: unknown; url?: unknown; status?: unknown; headers?: Record<string, unknown>; durationMs?: unknown }
export interface SafeNetEntry { method: string; url: string; status: number | null; headers: Record<string, string>; durationMs: number | null }

/** Сетевая запись, безопасная для модели: auth-заголовки замаскированы, URL-секреты
 *  погашены, ТЕЛА не включены (в них PII — требование №4). Чистая функция. */
export function redactNetworkEntry(e: RawNetEntry): SafeNetEntry {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(e.headers || {})) {
    headers[k] = AUTH_HEADER_RE.test(k) ? '[REDACTED]' : redactForDisplay(String(v))
  }
  return {
    method: String(e.method ?? 'GET').toUpperCase(),
    url: redactUrlSecrets(String(e.url ?? '')),
    status: typeof e.status === 'number' ? e.status : null,
    headers,
    durationMs: typeof e.durationMs === 'number' ? Math.round(e.durationMs) : null,
  }
}

// Форма записи и таблица уровней — НЕ здесь: `shared/browser-console-record` держит
// их для производителя и читателя разом. Своя копия таблицы в этом файле и была
// дефектом 15.08 (числа трактовались зеркально, console.error выпадал из выдачи).
export type { ConsoleLevel } from '../../../shared/browser-console-record'
export interface RawConsoleMsg { level?: unknown; text?: unknown; line?: unknown; source?: unknown }
export interface SafeConsoleMsg { level: ConsoleLevel; text: string; line?: number; source?: string }

/** Запись пришла БЕЗ ключа `text` — форма неизвестна. Отличимо от пустого сообщения. */
export const UNKNOWN_CONSOLE_SHAPE = '[текст сообщения не передан: неизвестная форма записи консоли]'

/** Сообщение консоли, безопасное для модели: текст и источник прогнаны через
 *  redactForDisplay (в console.log мог утечь ключ). Чистая функция. */
export function redactConsoleMessage(m: RawConsoleMsg): SafeConsoleMsg {
  // ОТСУТСТВИЕ ключа `text` — это не пустое сообщение, а чужая форма записи, и
  // молчать об этом нельзя: пустая строка неотличима от «страница ничего не
  // написала», а такой отказ не краснеет нигде. Ровно так дефект 15.08 и прожил —
  // с постройки блока B2 (01.08) модель получала `text: ''` у КАЖДОЙ записи
  // встроенного браузера и сообщала об этом молчанием (§3.1: запасной путь обязан
  // оставлять след).
  const text = m.text == null ? UNKNOWN_CONSOLE_SHAPE : String(m.text)
  const out: SafeConsoleMsg = { level: normalizeConsoleLevel(m.level), text: redactForDisplay(text) }
  if (typeof m.line === 'number') out.line = m.line
  if (m.source) out.source = redactForDisplay(String(m.source))
  return out
}

/** ОГРАНИЧЕННЫЙ список ошибок/предупреждений (не весь лог — требование плана §4).
 *  Берём только error+warning, последние `limit` (свежие важнее), редактируем. */
export function capConsoleErrors(raw: unknown[], limit: number): { count: number; truncated: boolean; messages: SafeConsoleMsg[] } {
  const lim = Math.max(1, limit | 0)
  const errs = (Array.isArray(raw) ? raw : [])
    .map(m => redactConsoleMessage(m as RawConsoleMsg))
    .filter(m => m.level === 'error' || m.level === 'warning')
  const messages = errs.slice(-lim)
  return { count: errs.length, truncated: errs.length > messages.length, messages }
}

/** Ограниченный список сетевых запросов, все редактированы. */
export function capNetwork(raw: unknown[], limit: number): { count: number; truncated: boolean; requests: SafeNetEntry[] } {
  const lim = Math.max(1, limit | 0)
  const all = (Array.isArray(raw) ? raw : []).map(e => redactNetworkEntry(e as RawNetEntry))
  const requests = all.slice(-lim)
  return { count: all.length, truncated: all.length > requests.length, requests }
}
