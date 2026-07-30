/**
 * Восстановление карточки согласования после перезапуска (§2.3 A3).
 *
 * ЧТО БЫЛО СЛОМАНО. Карточка «план ждёт решения» жила ТОЛЬКО в памяти renderer:
 * её рождало живое событие прогона. Закрыл приложение посреди согласования —
 * карточки нет, а план остался `draft` с удержанным чекпойнтом, и одобрить его
 * стало НЕЧЕМ: кнопка была единственной дорогой к продолжению. При выключенном
 * тумблере это была редкость; включение по умолчанию сделало бы дефект
 * массовым, поэтому восстановление идёт ПЕРЕД включением, а не после.
 *
 * Новых таблиц не нужно: всё уже persistent. План хранит `status`, `chatId` и
 * `agentRunId`, снимок истории живёт в `agent_run_checkpoints`. Восстановление —
 * это ЧТЕНИЕ существующего состояния при входе в чат.
 *
 * ЧЕСТНО ПРО МЁРТВЫЙ ЧЕКПОЙНТ. Чекпойнт могли вычистить (освобождение по Stop,
 * закрытию проекта, удалению плана). Тогда карточка всё равно нужна — но БЕЗ
 * кнопки продолжения: план существует, а продолжать нечем. Показать живую
 * кнопку, которая ничего не сделает, хуже, чем честно сказать «продолжение
 * недоступно, перегенерируйте план».
 */

/** План, каким его знает восстановление (подмножество полей `plans`). */
export interface RestorablePlan {
  id: number
  title: string
  status: string
  chatId: number | null
  agentRunId: string | null
  stepCount: number
}

/** Карточка, которую renderer положит в bundle СВОЕГО чата. */
export interface RestoredPlanCard {
  planId: number
  chatId: number
  title: string
  stepCount: number
  /** Есть ли чем продолжать. false → карточка без кнопок согласования. */
  resumable: boolean
}

/**
 * Отобрать планы, чьи карточки надо вернуть на экран.
 *
 * Условия ровно три, и каждое существенно:
 *  · `status === 'draft'` — решение ещё не принято (у `running`/`done` карточке
 *    места нет, работа уже пошла);
 *  · `chatId` известен — иначе некуда возвращать: карточка принадлежит чату, а
 *    не глобальной ячейке (дефект 4 §10, чинен 28.07);
 *  · `agentRunId` есть — иначе продолжать нечего в принципе, план создан не
 *    прогоном.
 *
 * @param hasCheckpoint живость чекпойнта; инъекция, чтобы логика оставалась
 *        чистой и пинилась без БД.
 */
export function restorablePlanCards(
  plans: readonly RestorablePlan[],
  hasCheckpoint: (runId: string) => boolean,
): RestoredPlanCard[] {
  const out: RestoredPlanCard[] = []
  for (const p of plans) {
    if (p.status !== 'draft') continue
    if (p.chatId == null) continue
    if (!p.agentRunId) continue
    out.push({
      planId: p.id,
      chatId: p.chatId,
      title: p.title,
      stepCount: p.stepCount,
      resumable: hasCheckpoint(p.agentRunId),
    })
  }
  return out
}

/** Карточки одного чата. Чужие сюда не попадают — это и есть защита от того,
 *  чтобы карточка второго чата затёрла первую. */
export function restorablePlanCardsForChat(
  plans: readonly RestorablePlan[],
  hasCheckpoint: (runId: string) => boolean,
  chatId: number,
): RestoredPlanCard[] {
  return restorablePlanCards(plans, hasCheckpoint).filter(c => c.chatId === chatId)
}
