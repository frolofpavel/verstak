import type { Database } from 'better-sqlite3'

/**
 * Persistent context snapshot — срез 2.0.11-B (миграция 52).
 *
 * ЗАЧЕМ. Длинный чат упирается в контекстное окно. Сжатие истории существует и сейчас
 * (compact-history), но живёт В ПАМЯТИ прогона: после перезапуска приложения его нет, и
 * модель снова получает всю простыню. Здесь сжатый итог ПЕРЕЖИВАЕТ рестарт.
 *
 * ЧЕГО ЭТА ТАБЛИЦА НЕ ДЕЛАЕТ (принципиально): не трогает видимые сообщения. Строки `chats`
 * не удаляются и не переписываются — человек видит переписку целиком. Компакция влияет
 * ТОЛЬКО на то, что уходит модели. Потерять переписку сжатием невозможно by design.
 *
 * ЖУРНАЛ, А НЕ ЗАМЕНА. Новый снапшот логически заменяет активный, но старые строки остаются:
 * это аудит и путь отката (карточка B п.9). Активный = самый свежий по id.
 *
 * СТРАЖ ГОНКИ (п.5). Суммаризация идёт вне основного прогона и занимает секунды — за это
 * время в чат могут прийти новые сообщения. Поэтому снапшот несёт source_max_message_id
 * (каким был максимум на момент ЧТЕНИЯ), и перед коммитом он сверяется заново. Разошлось —
 * отказ (`conflict`), НИЧЕГО не пишем: старый контекст остаётся рабочим. Это и есть DoD
 * «при любой ошибке предыдущий context остаётся рабочим».
 */

export interface ChatContextSnapshot {
  id: number
  chatId: number
  summary: string
  /** До какого сообщения ВКЛЮЧИТЕЛЬНО summary покрывает историю. */
  throughMessageId: number
  /** Максимум id сообщений чата на момент чтения — страж гонки. */
  sourceMaxMessageId: number
  providerId: string | null
  model: string | null
  estimatedTokensBefore: number | null
  estimatedTokensAfter: number | null
  createdAt: number
}

export interface SaveSnapshotInput {
  chatId: number
  summary: string
  throughMessageId: number
  sourceMaxMessageId: number
  providerId?: string | null
  model?: string | null
  estimatedTokensBefore?: number | null
  estimatedTokensAfter?: number | null
}

export type SaveSnapshotResult =
  | { ok: true; snapshot: ChatContextSnapshot }
  /** Чат изменился между чтением и коммитом — не записали НИЧЕГО. */
  | { ok: false; reason: 'conflict'; expectedMaxMessageId: number; actualMaxMessageId: number }
  /** Границу нельзя принять (пустой чат / сообщения нет / граница впереди источника). */
  | { ok: false; reason: 'invalid-boundary'; detail: string }

const SELECT = `
  SELECT id, chat_id as chatId, summary,
         through_message_id as throughMessageId,
         source_max_message_id as sourceMaxMessageId,
         provider_id as providerId, model,
         estimated_tokens_before as estimatedTokensBefore,
         estimated_tokens_after as estimatedTokensAfter,
         created_at as createdAt
  FROM chat_context_snapshots
`

/** Максимальный id сообщения чата. 0 — сообщений нет. */
export function maxMessageId(db: Database, chatId: number): number {
  const row = db.prepare('SELECT MAX(id) as maxId FROM chats WHERE session_id = ?').get(chatId) as { maxId: number | null } | undefined
  return row?.maxId ?? 0
}

/**
 * Убрать снапшоты, которые пересказывают УДАЛЁННЫЕ сообщения (ревью B #1).
 *
 * Зовётся вместе с truncateAfter («Откатить задачу»): человек отменил ветку диалога, и
 * итог, который её пересказывал, обязан уйти вместе с ней. Иначе:
 *   · хвост (id > границы) пуст → модель получит ОДИН summary, а весь видимый диалог
 *     выпадет из запроса;
 *   · сам summary будет пересказывать отменённое — как актуальный контекст.
 * И это не лечится проверкой «граница не выше максимума»: первое же новое сообщение
 * поднимет максимум, и снапшот-зомби снова сойдёт за валидный.
 *
 * Рубим ТОЛЬКО задетые (through > afterMessageId): снапшоты целиком внутри уцелевшей
 * части остаются рабочими. Более ранний снапшот при этом снова становится активным —
 * журнал сжатий для того и ведётся.
 *
 * @returns сколько снапшотов убрано.
 */
export function invalidateSnapshotsAfter(db: Database, chatId: number, afterMessageId: number): number {
  return db.prepare(
    'DELETE FROM chat_context_snapshots WHERE chat_id = ? AND through_message_id > ?'
  ).run(chatId, afterMessageId).changes
}

/** Активный снапшот чата — самый свежий. null, если сжатия не было. */
export function activeSnapshot(db: Database, chatId: number): ChatContextSnapshot | null {
  const row = db.prepare(`${SELECT} WHERE chat_id = ? ORDER BY id DESC LIMIT 1`).get(chatId)
  return (row as ChatContextSnapshot | undefined) ?? null
}

/** Вся история снапшотов чата (новые первыми) — аудит и откат. */
export function snapshotHistory(db: Database, chatId: number): ChatContextSnapshot[] {
  return db.prepare(`${SELECT} WHERE chat_id = ? ORDER BY id DESC`).all(chatId) as ChatContextSnapshot[]
}

/**
 * Записать снапшот, если чат не изменился с момента чтения.
 *
 * Порядок важен: сверка максимума и вставка — в ОДНОЙ транзакции. Иначе между проверкой и
 * записью успело бы прийти сообщение, и снапшот молча «съел» бы его из контекста модели.
 */
export function saveSnapshot(db: Database, input: SaveSnapshotInput, now: number): SaveSnapshotResult {
  if (input.throughMessageId <= 0) {
    return { ok: false, reason: 'invalid-boundary', detail: 'граница не выбрана (пустой чат?)' }
  }
  if (input.throughMessageId > input.sourceMaxMessageId) {
    return { ok: false, reason: 'invalid-boundary', detail: 'граница впереди прочитанного источника' }
  }

  const tx = db.transaction((): SaveSnapshotResult => {
    const actual = maxMessageId(db, input.chatId)
    if (actual !== input.sourceMaxMessageId) {
      // Чат пополнился, пока считали summary. Пишем НИЧЕГО: активный снапшот цел,
      // модель продолжит работать на прежнем контексте.
      return { ok: false, reason: 'conflict', expectedMaxMessageId: input.sourceMaxMessageId, actualMaxMessageId: actual }
    }
    const info = db.prepare(
      `INSERT INTO chat_context_snapshots
         (chat_id, summary, through_message_id, source_max_message_id,
          provider_id, model, estimated_tokens_before, estimated_tokens_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.chatId, input.summary, input.throughMessageId, input.sourceMaxMessageId,
      input.providerId ?? null, input.model ?? null,
      input.estimatedTokensBefore ?? null, input.estimatedTokensAfter ?? null, now,
    )
    const snap = db.prepare(`${SELECT} WHERE id = ?`).get(info.lastInsertRowid as number) as ChatContextSnapshot
    return { ok: true, snapshot: snap }
  })

  return tx()
}
