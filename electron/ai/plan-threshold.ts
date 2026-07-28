/**
 * Порог показа карточки согласования (ТЗ VSK-TASK-FLOW-A1, §4.2).
 *
 * Правило 3 цикла: чтение не требует утверждения. План, который только читает и
 * отвечает, автоутверждается — карточка не показывается, пользователь просто
 * получает ответ. Карточка появляется, когда план объявил запись файлов,
 * изменения во внешних системах или ответственное действие.
 *
 * ЧЕГО ЭТОТ МОДУЛЬ НЕ ДЕЛАЕТ — и это главное. Порог считается по тому, что
 * модель САМА объявила в плане. Модель может ошибиться или соврать: назвать
 * пишущий шаг читающим. Поэтому автоутверждение снимает КАРТОЧКУ и только её —
 * оно НЕ выдаёт прав на запись. Фактическая попытка записи всё равно проходит
 * через `mode-policy.decide()` в общем порядке. Неверная самооценка модели даёт
 * лишний вопрос пользователю, а не тихую запись.
 *
 * Fail-safe: если объявленных данных нет вовсе (легаси-путь без structured spec),
 * считаем, что карточка НУЖНА. Неизвестное — не то же самое, что безопасное.
 */

import type { PlanStepSpecV1 } from '../../shared/contracts/outcome'

/** Что именно потребовало карточку — для человеческого объяснения и логов. */
export type PlanApprovalReason =
  | 'write-scope'
  | 'responsible-action'
  | 'high-risk'
  | 'no-declaration'

export interface PlanApprovalVerdict {
  /** true — показать карточку согласования; false — автоутвердить без карточки. */
  needsCard: boolean
  reason: PlanApprovalReason | null
  /** Ключи/номера шагов, которые дали срабатывание. Для объяснения, не для логики. */
  triggeredBy: string[]
}

/**
 * Ответственные действия (правило 2 цикла): платёж, отправка другому человеку,
 * публикация, удаление данных, изменение прав доступа.
 *
 * У русских альтернатив НЕТ ``: в JS граница слова определена по ASCII, и
 * `отправ` не совпадает с «Отправить» — проверено падающим тестом.
 *
 * Список намеренно избыточен и включает англоязычные формы: шаги пишет модель, и
 * язык формулировки заранее неизвестен. Ложное срабатывание стоит одного лишнего
 * вопроса, пропуск — необратимого действия без спроса.
 */
const RESPONSIBLE_HINTS: readonly string[] = [
  // платёж
  'оплат', 'платеж', 'платёж', 'перевод', 'payment', 'invoice', 'charge',
  // отправка другому человеку
  'отправ', 'разосл', 'рассыл', 'письм', 'уведомлени', 'send', 'email', 'notify',
  // публикация
  'опублик', 'публикац', 'выложи', 'publish', 'deploy', 'release',
  // удаление данных
  'удал', 'очист', 'снос', 'delete', 'remove', 'purge', 'truncate', 'drop table',
  // права доступа
  'права доступа', 'разрешени', 'permission', 'access control', 'grant', 'revoke',
]

/**
 * Подстрочный поиск, а не регулярка. Причина конкретная: в JS граница слова
 * определена по ASCII, поэтому шаблон с ней НЕ совпадает с «Отправить» — на этом
 * уже поймал себя падающий тест. Смешивать в одном шаблоне кириллицу без границ
 * и латиницу с границами оказалось хрупко; простое includes по нижнему регистру
 * ведёт себя предсказуемо в обоих языках.
 */
function mentionsResponsible(text: string): boolean {
  const hay = text.toLowerCase()
  return RESPONSIBLE_HINTS.some(hint => hay.includes(hint))
}

/** Шаг в том виде, в котором его отдал `create_plan`. */
export interface DeclaredStep {
  title: string
  detail?: string | null
  spec?: PlanStepSpecV1 | null
}

/**
 * Нужна ли карточка согласования для плана.
 *
 * @param steps шаги в объявленном моделью виде.
 * @param hasStructuredSpecs есть ли у плана structured spec вообще. Если нет —
 *        судить не по чему, и мы честно требуем карточку.
 */
export function planApprovalVerdict(steps: readonly DeclaredStep[]): PlanApprovalVerdict {
  if (steps.length === 0) {
    return { needsCard: true, reason: 'no-declaration', triggeredBy: [] }
  }

  const withSpec = steps.filter(s => s.spec)
  // Ни одного structured spec — легаси-путь. Объявления, по которому можно судить,
  // нет: карточку показываем.
  if (withSpec.length === 0) {
    return { needsCard: true, reason: 'no-declaration', triggeredBy: [] }
  }
  // Часть шагов без spec — тоже неполное объявление, судить нельзя.
  if (withSpec.length !== steps.length) {
    return { needsCard: true, reason: 'no-declaration', triggeredBy: [] }
  }

  const label = (s: DeclaredStep, i: number) => s.spec?.key || s.title || `шаг ${i + 1}`

  const writers = steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => (s.spec?.writeScope?.length ?? 0) > 0)
  if (writers.length > 0) {
    return { needsCard: true, reason: 'write-scope', triggeredBy: writers.map(({ s, i }) => label(s, i)) }
  }

  const responsible = steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => {
      const haystack = [
        s.title,
        s.detail ?? '',
        s.spec?.intent ?? '',
        ...(s.spec?.actions ?? []),
      ].join(' \n ')
      return mentionsResponsible(haystack)
    })
  if (responsible.length > 0) {
    return { needsCard: true, reason: 'responsible-action', triggeredBy: responsible.map(({ s, i }) => label(s, i)) }
  }

  const risky = steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.spec?.risk === 'high')
  if (risky.length > 0) {
    return { needsCard: true, reason: 'high-risk', triggeredBy: risky.map(({ s, i }) => label(s, i)) }
  }

  return { needsCard: false, reason: null, triggeredBy: [] }
}

/** Человеческое объяснение вердикта — для результата инструмента и журнала. */
export function explainVerdict(v: PlanApprovalVerdict): string {
  if (!v.needsCard) return 'План только читает и отвечает — согласование не требуется.'
  const what = v.triggeredBy.length > 0 ? ` (${v.triggeredBy.join(', ')})` : ''
  switch (v.reason) {
    case 'write-scope': return `План изменяет файлы${what} — нужно согласование.`
    case 'responsible-action': return `План содержит ответственное действие${what} — нужно согласование.`
    case 'high-risk': return `План содержит шаг высокого риска${what} — нужно согласование.`
    case 'no-declaration': return 'План не объявил, что именно делает, — нужно согласование.'
    // needsCard=true без причины невозможен по построению, но молчать нельзя:
    // такой вердикт означает баг выше, и человеку нужен внятный текст.
    case null: return 'Согласование требуется.'
  }
}
