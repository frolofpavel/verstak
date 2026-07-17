/**
 * Полный экспорт диалога сессии в Markdown (в отличие от handoff — тот сжатый
 * forward-документ на 6 ходов). Дословный транскрипт: каждое сообщение с ролью,
 * временем и содержимым. ОБЯЗАТЕЛЬНО прогоняем через scanText (сырые user/assistant
 * тексты могут содержать токены — handoff этого не делает, для полного дампа критично).
 */
import { scanText } from './secret-scanner'
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
  const header: string[] = [`# Транскрипт${opts.title ? `: ${opts.title}` : ''}`]
  const meta = [
    opts.provider ? `провайдер: ${opts.provider}` : '',
    opts.exportedAt ? `экспорт: ${fmtTime(opts.exportedAt)}` : '',
    `сообщений: ${messages.length}`
  ].filter(Boolean)
  header.push(`> ${meta.join(' · ')}`)

  const body = messages.map(m => {
    const label = ROLE_LABEL[m.role] ?? m.role
    const time = fmtTime(m.createdAt)
    // Порядок: секреты → пути. Секреты гасятся первыми (могут содержать сегменты, похожие
    // на пути); нормализация путей затем работает по уже-очищенному тексту. Обе чистки —
    // на ВЕСЬ текст сообщения, не только на code blocks (2.0.11-C).
    let safe = scanText(m.content ?? '').redacted
    if (opts.pathContext) safe = redactPathsForExport(safe, opts.pathContext)
    return `## ${label}${time ? ` · ${time}` : ''}\n\n${safe}`
  }).join('\n\n---\n\n')

  return `${header.join('\n')}\n\n${body}\n`
}
