// Действия баннера возобновления прерванного прогона (1.9.7 #1).
//
// Раньше баннер для НЕ-autoResumable прогонов (всегда для CLI, а также деструктив/
// unsafe-режим) показывал ТОЛЬКО «Показать что было» — прятал повтор запроса, хотя
// lastUserRequest сохранён и re-send безопасен. Различаем две вещи:
//  - resume-with-context: реплей истории/tool-стейта через resumeFromRunId. Гейтится
//    autoResumable (для CLI/деструктива off — нельзя авто-доигрывать невидимый деструктив).
//  - resend-fresh: свежий прогон lastUserRequest БЕЗ реплея. User-initiated (кнопка =
//    явное решение пользователя, как перепечатать запрос) → безопасен даже для CLI.
//    Крашнутые правки можно предварительно откатить кнопкой Control Envelope (#1 1.9.6).

export type ResumeAction = 'resume-with-context' | 'resend-fresh' | 'show-what-was-done'

export function resumeBannerActions(run: { autoResumable: boolean; lastUserRequest: string }): ResumeAction[] {
  const canResend = !!run.lastUserRequest && run.lastUserRequest.trim().length > 0
  if (run.autoResumable) {
    // Безопасный прогон (read-only последний tool + безопасный режим, не CLI):
    // предлагаем реплей с контекстом.
    return canResend ? ['resume-with-context', 'show-what-was-done'] : ['show-what-was-done']
  }
  // CLI / деструктив / unsafe-режим: авто-реплей запрещён, но свежий повтор запроса
  // (user-initiated) безопасен и полезен — не заставляем перепечатывать.
  return canResend ? ['resend-fresh', 'show-what-was-done'] : ['show-what-was-done']
}

/** Нужен ли resumeFromRunId (реплей контекста) для данного действия. */
export function actionReplaysContext(action: ResumeAction): boolean {
  return action === 'resume-with-context'
}
