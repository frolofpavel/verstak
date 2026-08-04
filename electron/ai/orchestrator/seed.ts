/**
 * Задача 10 — оркестратор по умолчанию. Модель по ходу решает, что задача —
 * отдельная, и вызывает spawn_task_session. Здесь — ЧИСТЫЙ синтез seed-сообщения:
 * самодостаточного первого сообщения ДОЧЕРНЕЙ сессии (handoff #12 из разбора), чтобы
 * она делала задачу без родительского контекста. IO (создание сессии, событие в
 * renderer) — в хендлере; здесь только сборка текста, пинуется.
 */
export interface TaskSeedInput {
  /** Короткий заголовок задачи — для имени дочерней сессии и карточки-следа. */
  title: string
  /** Полная формулировка задачи — тело seed. */
  task: string
  /** Релевантный контекст проекта (из тёплого Brain), опционально. */
  projectContext?: string | null
}

/** Seed дочерней сессии: задача + (опц.) контекст проекта. Пустая задача → пустой seed. */
export function buildTaskSessionSeed(input: TaskSeedInput): string {
  const task = (input.task ?? '').trim()
  if (!task) return ''
  const ctx = (input.projectContext ?? '').trim()
  if (!ctx) return task
  return `${task}\n\n--- Контекст проекта ---\n${ctx}`
}
