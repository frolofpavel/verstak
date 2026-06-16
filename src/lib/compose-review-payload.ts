import type { ChatMessage, VerificationRow } from '../types/api'

/**
 * Сериализует last turn основного чата для отправки ревьюеру.
 *
 * Что включаем:
 * - Последнее user сообщение (что просили агента сделать).
 * - Последний assistant ответ (что агент написал).
 * - Краткие выжимки tool calls/results (если есть в thinking).
 * - VERIFICATION-блок (если передан) — заявленный агентом DoD: чтобы ревьюер
 *   СВЕРЯЛ утверждения агента с доказательством, а не верил на слово.
 *
 * Что НЕ включаем:
 * - Историю старше last turn (ревьюер смотрит ТОЛЬКО на последний шаг).
 * - Системные промпты / context pack (ревьюер сам знает свою задачу).
 *
 * Результат — обычный текст, который попадёт в user-message ревьюера.
 * Ревьюер получит его как «вот что произошло, проверь».
 *
 * @param verification — опциональная latest-верификация чата (Фаза 4). Если есть,
 *        вставляется блок «=== VERIFICATION (заявленный DoD) ===» для сверки.
 */
/**
 * @param diff — опциональный git-patch рабочего дерева (GitDiff.patch). КРИТИЧНО
 *        для качества findings: без реального кода ревьюер выдаёт «file:line» из
 *        нарратива агента — номера строк галлюцинируются. С diff он видит сами
 *        изменения и привязывает замечания к настоящим строкам (аудит P0 #6).
 */
export function composeReviewPayload(messages: ChatMessage[], verification?: VerificationRow | null, diff?: string | null): string {
  // Берём с конца: последний assistant, перед ним последний user.
  let lastAssistant: ChatMessage | null = null
  let lastUser: ChatMessage | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && !lastAssistant && m.content) {
      lastAssistant = m
    } else if (m.role === 'user' && !lastUser && lastAssistant) {
      // Находим user, который шёл ПЕРЕД lastAssistant
      lastUser = m
      break
    }
  }

  const lines: string[] = []
  lines.push('# Ревью последнего шага агента')
  lines.push('')

  if (lastUser) {
    lines.push('## Запрос пользователя')
    lines.push(truncate(lastUser.content, 4000))
    if (lastUser.attachments?.length) {
      lines.push('')
      lines.push(`_Вложений: ${lastUser.attachments.length} (${lastUser.attachments.map(a => a.name).join(', ')})_`)
    }
    lines.push('')
  }

  if (lastAssistant) {
    lines.push('## Ответ агента')
    lines.push(truncate(lastAssistant.content, 8000))
    if (lastAssistant.thinking) {
      lines.push('')
      lines.push('## Размышление агента (внутреннее)')
      lines.push(truncate(lastAssistant.thinking, 3000))
    }
    lines.push('')
  }

  // Реальные изменения кода (git diff рабочего дерева). Даёт ревьюеру код с
  // номерами строк — иначе file:line в findings берутся из прозы агента и
  // галлюцинируются (аудит P0 #6). Обрезаем щедро: diff важнее размышлений.
  if (diff && diff.trim()) {
    lines.push('## Изменения в коде (git diff рабочего дерева)')
    lines.push('```diff')
    lines.push(truncate(diff, 14000))
    lines.push('```')
    lines.push('Привязывай file:line в замечаниях к этим строкам, а не к пересказу агента.')
    lines.push('')
  }

  // VERIFICATION-блок (Фаза 4): заявленный агентом DoD. Ревьюер должен сверять
  // утверждения агента («я всё проверил») с этим доказательством, а не верить
  // на слово. Статусы здесь поставлены хендлером по реальному exitCode перепрогона.
  if (verification) {
    lines.push('=== VERIFICATION (заявленный DoD) ===')
    lines.push(`Итог: ${OVERALL_RU[verification.overall] ?? verification.overall} · проверок зелёных ${verification.checksPassed}/${verification.checksTotal} · изменено файлов ${verification.changedFilesCount}`)
    if (verification.taskSummary) {
      lines.push(`Что заявлено сделано: ${truncate(verification.taskSummary, 1500)}`)
    }
    lines.push('Статусы проверок поставлены перепрогоном команд по реальному exitCode (не словам агента).')
    lines.push('Сверь: соответствует ли заявленный итог реальной работе из ответа выше? Не пропущены ли проверки (overall=partial/not_run при заявленном «готово»)?')
    lines.push('')
  }

  lines.push('## Задача')
  lines.push('Прочитай запрос и ответ. Найди проблемы в работе агента и выдай отчёт в формате, описанном в системном промпте.')

  return lines.join('\n')
}

/** Человекочитаемый итог верификации для VERIFICATION-блока. */
const OVERALL_RU: Record<string, string> = {
  passed: 'проверки пройдены',
  failed: 'есть проваленные проверки',
  partial: 'проверено частично',
  not_run: 'проверки не запускались'
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n\n[...обрезано, всего ${text.length} символов]`
}
