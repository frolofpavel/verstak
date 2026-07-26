// 2.1.14: как показать накопленную статистику аккаунта подписки человеку.
//
// Главное правило — не превращать «нет данных» в «ноль». Аккаунт, заведённый до
// появления телеметрии, и аккаунт, которым сегодня ни разу не пользовались, — это
// разные факты, и написаны они должны быть по-разному. Доля успеха показывается
// только когда есть от чего её считать.

import type { SubscriptionAccountStatsDTO } from '../../shared/contracts/subscription'

export interface TelemetryView {
  /** Однострочная сводка для строки аккаунта. */
  line: string
  /** true — попытки идут, а ответов нет: маршрут до аккаунта не доходит до результата. */
  alarming: boolean
  /** Подробности для title (полная раскладка причин). Пусто, когда раскладывать нечего. */
  detail: string
}

const dateOf = (ms: number): string => new Date(ms).toLocaleDateString()

/** Доля успеха. null — считать не от чего (попыток не было). */
export function successRate(stats: Pick<SubscriptionAccountStatsDTO, 'attempts' | 'successes'>): number | null {
  if (stats.attempts <= 0) return null
  return Math.round((stats.successes / stats.attempts) * 100)
}

export function formatAccountTelemetry(stats: SubscriptionAccountStatsDTO | undefined): TelemetryView {
  if (!stats || stats.since == null) {
    return { line: 'статистика не велась', alarming: false, detail: '' }
  }
  if (stats.attempts === 0) {
    return { line: `с ${dateOf(stats.since)} не использовался`, alarming: false, detail: '' }
  }

  const rate = successRate(stats)
  const parts = [`${stats.attempts} попыток`, `${stats.successes} ответов`]
  if (rate != null) parts.push(`${rate}%`)
  if (stats.cooldowns > 0) parts.push(`${stats.cooldowns} лимитов`)
  if (stats.rotationsOut > 0) parts.push(`${stats.rotationsOut} уводов`)

  // Раскладка причин в подсказке: «прочее» выводим как остаток, чтобы сумма всегда
  // сходилась с общим числом охлаждений и ничего не пропадало молча.
  const named = stats.quotaHits + stats.rateLimitHits + stats.authFailures
  const other = Math.max(0, stats.cooldowns - named)
  const detailParts: string[] = [`Учёт с ${dateOf(stats.since)}`]
  if (stats.quotaHits > 0) detailParts.push(`квота: ${stats.quotaHits}`)
  if (stats.rateLimitHits > 0) detailParts.push(`рейт-лимит: ${stats.rateLimitHits}`)
  if (stats.authFailures > 0) detailParts.push(`требовался вход: ${stats.authFailures}`)
  if (other > 0) detailParts.push(`прочее: ${other}`)
  if (stats.rotationsIn > 0) detailParts.push(`переключений на него: ${stats.rotationsIn}`)
  if (stats.lastSuccessAt) detailParts.push(`последний ответ: ${new Date(stats.lastSuccessAt).toLocaleString()}`)
  if (stats.lastErrorAt) detailParts.push(`последняя ошибка: ${new Date(stats.lastErrorAt).toLocaleString()}`)

  return {
    line: parts.join(' · '),
    alarming: stats.successes === 0,
    detail: detailParts.join(' · '),
  }
}
