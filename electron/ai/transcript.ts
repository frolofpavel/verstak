/**
 * Полный экспорт диалога сессии в Markdown (в отличие от handoff — тот сжатый
 * forward-документ на 6 ходов). Дословный транскрипт: каждое сообщение с ролью,
 * временем и содержимым. ОБЯЗАТЕЛЬНО прогоняем через scanText (сырые user/assistant
 * тексты могут содержать токены — handoff этого не делает, для полного дампа критично).
 */
import { redactForDisplay } from './secret-scanner'
import { redactPathsForExport, type PathRedactionContext } from './export-path-redaction'

export interface TranscriptMessage {
  role: string
  content: string
  createdAt?: number
}

export interface TranscriptOptions {
  title?: string | null
  provider?: string | null
  exportedAt?: number
  /** 2.0.11-C: корни для нормализации путей (приватность). Нет контекста → пути не трогаем. */
  pathContext?: PathRedactionContext
}

const ROLE_LABEL: Record<string, string> = {
  user: '🧑 Вы',
  assistant: '🤖 Ассистент',
  system: '⚙ Система'
}

function fmtTime(ts?: number): string {
  if (!ts || !Number.isFinite(ts)) return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function buildTranscriptMarkdown(messages: TranscriptMessage[], opts: TranscriptOptions = {}): string {
  // Чистка на ВЕСЬ текст (не только code blocks): redactForDisplay = секреты по паттернам
  // + Bearer/basic-auth + секрет-параметры во встроенных URL (?token=/?sig=/?sas= по ИМЕНИ —
  // scanText их не ловит, экспорт не должен быть слабее показа на экране, ре-ревью C #2).
  // Затем нормализация путей (по уже-очищенному тексту). Порядок: секреты → пути.
  const sanitize = (text: string): string => {
    const safe = redactForDisplay(text ?? '')
    return opts.pathContext ? redactPathsForExport(safe, opts.pathContext) : safe
  }

  // Заголовок авто-генерится из первого сообщения и мог нести путь/секрет — чистим ТАК ЖЕ,
  // как тело (ре-ревью C #1: раньше title шёл в шапку сырым, мимо всех чисток).
  const safeTitle = opts.title ? sanitize(opts.title) : ''
  const header: string[] = [`# Транскрипт${safeTitle ? `: ${safeTitle}` : ''}`]
  const meta = [
    opts.provider ? `провайдер: ${opts.provider}` : '',
    opts.exportedAt ? `экспорт: ${fmtTime(opts.exportedAt)}` : '',
    `сообщений: ${messages.length}`
  ].filter(Boolean)
  header.push(`> ${meta.join(' · ')}`)

  const body = messages.map(m => {
    const label = ROLE_LABEL[m.role] ?? m.role
    const time = fmtTime(m.createdAt)
    return `## ${label}${time ? ` · ${time}` : ''}\n\n${sanitize(m.content)}`
  }).join('\n\n---\n\n')

  return `${header.join('\n')}\n\n${body}\n`
}
