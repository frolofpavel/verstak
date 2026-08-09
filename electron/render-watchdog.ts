/**
 * Watchdog смерти рендера. До него render-process-gone только логировался, а окно
 * оставалось трупом навсегда: у установленных 2.4.5–2.4.7 (потерянные locales,
 * access violation рендера) пользователь видел вечное серое окно, и каждый клик по
 * ярлыку показывал тот же труп через single-instance.
 *
 * Логика решения чистая и отвязана от Electron, чтобы краснеть в юнит-пинах:
 * смерть рендера → перезагрузка окна, но не бесконечно — N попыток в скользящем
 * окне, дальше честная ошибка человеку вместо молчаливого цикла крашей.
 * Watchdog НЕ прячет дефект: событие window.render_process_gone логируется ДО
 * решения (см. main.ts), перезагрузка оставляет свой след в логах.
 */

export type WatchdogDecision = 'reload' | 'give-up' | 'ignore'

export interface RenderWatchdog {
  decide(reason: string, now?: number): WatchdogDecision
}

// clean-exit — штатное завершение процесса рендера (навигация, закрытие окна),
// не смерть; на него не реагируем и попытки не тратим.
const NON_FATAL_REASONS = new Set(['clean-exit'])

export const RENDER_WATCHDOG_MAX_ATTEMPTS = 3
export const RENDER_WATCHDOG_WINDOW_MS = 60_000

export function createRenderWatchdog(opts?: {
  maxAttempts?: number
  windowMs?: number
}): RenderWatchdog {
  const maxAttempts = opts?.maxAttempts ?? RENDER_WATCHDOG_MAX_ATTEMPTS
  const windowMs = opts?.windowMs ?? RENDER_WATCHDOG_WINDOW_MS
  let attempts: number[] = []
  return {
    decide(reason: string, now: number = Date.now()): WatchdogDecision {
      if (NON_FATAL_REASONS.has(reason)) return 'ignore'
      attempts = attempts.filter(t => now - t < windowMs)
      if (attempts.length >= maxAttempts) return 'give-up'
      attempts.push(now)
      return 'reload'
    },
  }
}
