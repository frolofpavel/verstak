// Честное ожидание готовности браузерного API — устранение СТАРТОВОЙ ГОНКИ.
//
// ФАКТ (живая проверка a0f7a22, Павел): browser_navigate иногда отдавал «вкладка
// Browser не открыта» на ПЕРВОМ вызове после запуска, а следующий тот же вызов
// проходил, хотя между попытками ничего не менялось. Причина установлена по коду,
// не по догадке: `PersistentBrowser` монтируется в renderer АСИНХРОННО (lazy-chunk),
// а `browser.ts` при отсутствии `window.verstakBrowser` отдавал ошибку НЕМЕДЛЕННО,
// без ожидания. Если прогон агента дошёл до браузерного инструмента раньше, чем
// закончилось монтирование, API ещё нет — отсюда «иногда работает». Обе попытки
// Павла шли на одном коде (a0f7a22), разница только во времени → это гонка старта,
// не старая сборка.
//
// ЛЕЧЕНИЕ — НЕ слепая пауза, а ожидание готовности: повторяем вызов, пока страница
// сообщает «API ещё нет», до разумного предела; как только появился — выполняем;
// ошибку отдаём, только если не появился за лимит. Сниппет возвращает
// { __vskNotReady:true }, когда `window.verstakBrowser` отсутствует — в странице
// действие при этом НЕ выполняется, поэтому повтор безопасен и для мутаций (клик,
// ввод, навигация не задваиваются).

export const BROWSER_READY_TIMEOUT_MS = 3000

/** Маркер «браузер ещё не смонтирован» из инжектируемого сниппета. */
export function isBrowserNotReady(r: unknown): boolean {
  return !!r && typeof r === 'object' && (r as { __vskNotReady?: unknown }).__vskNotReady === true
}

export interface AwaitApiDeps {
  /** Выполнить код в renderer (обычно ctx.sender.exec). */
  exec: (code: string) => Promise<unknown>
  timeoutMs?: number
  /** Инъекции для тестов (детерминизм, без реальных таймеров). */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * Выполнить сниппет, дождавшись готовности `window.verstakBrowser`. Пока сниппет
 * сообщает `__vskNotReady` (API нет) — повторяем с шагом 50мс до `timeoutMs`.
 * Возвращает последний результат сниппета (готовый — сразу; иначе __vskNotReady
 * после предела, который вызывающий превращает в честную ошибку).
 */
export async function execAwaitingBrowserApi(snippet: string, deps: AwaitApiDeps): Promise<unknown> {
  const timeoutMs = deps.timeoutMs ?? BROWSER_READY_TIMEOUT_MS
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const now = deps.now ?? (() => Date.now())
  let result = await deps.exec(snippet)
  const deadline = now() + timeoutMs
  while (isBrowserNotReady(result) && now() < deadline) {
    await sleep(50)
    result = await deps.exec(snippet)
  }
  return result
}
