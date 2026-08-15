import { semverGt } from './semver'

/**
 * Показывать ли модалку «Обновление установлено».
 *
 * Повод (враждебное ревью 2.6.4 §5): ПЕРВАЯ в жизни установка встречала человека
 * словами «Обновление установлено. Версия 2.6.4 — что нового». Гарда первого
 * запуска не было вовсе: условие `if (last && !semverGt(current, last)) return`
 * при пустом `last` не срабатывает, и модалка показывалась всем подряд.
 *
 * `first-install` — не показывать, но ЗАПОМНИТЬ версию: иначе при следующем
 * обновлении человек получит ноты и той версии, с которой начал.
 */
export type WhatsNewDecision = 'show' | 'skip' | 'first-install'

export function decideWhatsNew(input: {
  current: string
  /** Версия, для которой модалку уже показывали. Пусто — ни разу. */
  last: string | null
  /** Человек прошёл онбординг — значит установка не первая. */
  onboardingCompleted: boolean
}): WhatsNewDecision {
  const { current, last, onboardingCompleted } = input
  if (!last) return onboardingCompleted ? 'show' : 'first-install'
  return semverGt(current, last) ? 'show' : 'skip'
}
