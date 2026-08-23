/**
 * Сборка отчёта о проблеме — чтобы провал у пользователя перестал быть невидимым.
 *
 * Зачем: до 22.08 экран «Обратная связь» писал «✓ Отправлено», а запись ложилась в
 * локальную базу пользователя и оставалась там навсегда. Человек считал, что сообщил о
 * проблеме; автор продукта не узнавал ничего. Кнопка тратила доверие и не давала ничего.
 *
 * ПОЧЕМУ НЕ ТЕЛЕМЕТРИЯ. README обещает: «ничего не покидает вашу машину, кроме вызовов
 * провайдеров, которые вы настроили». Обещание не нарушается: этот модуль НИЧЕГО НЕ
 * ОТПРАВЛЯЕТ. Он собирает текст, показывает его человеку целиком и отдаёт ему —
 * скопировать или сохранить. Решение отправить принимает человек, видя весь текст.
 * Здесь нет и не должно появиться ни одного сетевого вызова.
 *
 * Секреты: всё, что уходит в отчёт, обязано пройти через редакцию. Хвост рантайм-лога
 * особенно опасен — туда попадают команды и ответы сервисов.
 */

import { redactForDisplay } from './ai/secret-scanner'

export interface SupportReportInput {
  /** Что написал человек. */
  message: string
  /** Оценка 1..5, если поставил. */
  rating: number | null
  /** Версия приложения. */
  appVersion: string
  /** Платформа: 'win32' и т.п. */
  platform: string
  /** Версия ОС, если известна. */
  osRelease?: string | null
  /** Провайдер и модель — ИДЕНТИФИКАТОРЫ, не ключи. */
  providerId: string | null
  model?: string | null
  /** Момент сборки (мс). Передаётся снаружи — модуль не смотрит на часы сам. */
  now: number
  /** Хвост рантайм-лога: последние строки, как есть. */
  logTail?: string[]
}

/** Сколько строк лога максимум попадёт в отчёт. Больше — человек не прочитает и не
 *  проверит глазами то, что отдаёт, а непрочитанный отчёт равен телеметрии. */
export const MAX_LOG_LINES = 40

function formatStamp(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Собирает текст отчёта. Возвращает готовую строку — её показывают человеку целиком.
 * Ничего не отправляет и не пишет на диск.
 */
export function buildSupportReport(input: SupportReportInput): string {
  const lines: string[] = []

  lines.push('# Отчёт о проблеме — Verstak')
  lines.push('')
  lines.push(`Дата: ${formatStamp(input.now)}`)
  lines.push(`Версия: ${input.appVersion}`)
  lines.push(`Система: ${input.platform}${input.osRelease ? ` ${input.osRelease}` : ''}`)
  lines.push(`Провайдер: ${input.providerId ?? 'не выбран'}${input.model ? ` · ${input.model}` : ''}`)
  if (input.rating != null) lines.push(`Оценка: ${input.rating} из 5`)
  lines.push('')
  lines.push('## Что случилось')
  lines.push('')
  lines.push(input.message.trim() || '(человек не описал словами)')

  const tail = (input.logTail ?? []).slice(-MAX_LOG_LINES)
  if (tail.length > 0) {
    lines.push('')
    lines.push(`## Последние записи журнала (${tail.length})`)
    lines.push('')
    lines.push('```')
    for (const l of tail) lines.push(l)
    lines.push('```')
  }

  lines.push('')
  lines.push('---')
  lines.push('Отчёт собран на компьютере пользователя и никуда не отправлен автоматически.')

  // ЕДИНСТВЕННЫЙ выход наружу — только через редакцию, и ОДНИМ куском на весь текст.
  // Не выносить чистку выше по отдельным полям: тогда любое новое поле поедет мимо неё
  // молча. redactForDisplay = scanText + токены внутри URL (?token=…), которые одни
  // паттерны ключей не ловят.
  return redactForDisplay(lines.join('\n'))
}
