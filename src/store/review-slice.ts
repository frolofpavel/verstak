import type { StateCreator } from 'zustand'
import type { ProjectState } from './projectStore'
import { parseReviewFindings, type ReviewFinding } from '../lib/review-findings'

/**
 * In-flight or completed Review для main-чата. Хранится в store пока активен
 * проект — при переключении проекта/чата подгружается из БД заново через
 * refreshReviewsFor(mainChatId).
 */
export interface ReviewState {
  /** chat_sessions.id review sub-чата. */
  reviewChatId: number
  /** К какому main-чату относится. */
  parentChatId: number
  /** Провайдер, который выдавал ревью. */
  providerId: string
  model: string | null
  /** Текст ревью, накапливаемый по text events. */
  content: string
  status: 'streaming' | 'done' | 'error'
  errorMessage?: string
  createdAt: number
  /** Парсится из первой строки «ЗАМЕЧАНИЙ: N». -1 пока стримится. */
  noteCount: number
  /** V2: структурированные findings, распарсенные из ```json блока content на
   *  finalizeReview. Пусто для старого текстового ревью без json-блока. */
  findings: ReviewFinding[]
  /** V2: id принятых пользователем findings (для «исправить выбранные»). */
  accepted: string[]
}

/**
 * Slice Explicit Review: состояние ревью + методы жизненного цикла. Вынесен из
 * projectStore (§5 распил). StateCreator над ПОЛНЫМ ProjectState — get() читает
 * path/activeChatId/registerSendOwner (MainSlice) и failReview (self), а
 * cleanupReviewsFor через set() частичным мержем чистит sendOwners (поле Main).
 * import type ProjectState — обратное ребро type-only, без рантайм-цикла.
 */
export interface ReviewSlice {
  /** Review state, keyed by reviewChatId. Pre-loaded on chat switch via
   *  refreshReviewsFor() and updated live during streaming. */
  reviews: Record<number, ReviewState>
  /** Текущий раскрытый review panel (или null если все свёрнуты). Хранится
   *  в store чтобы pills и панель могли быть в разных компонентах. */
  openedReviewId: number | null
  /** Подгрузить review sub-chats для указанного main-чата из БД. */
  refreshReviewsFor: (parentChatId: number) => Promise<void>
  /** Начать новое ревью текущего main-чата. Возвращает reviewChatId. */
  startReview: (opts: {
    providerId: string
    model: string | null
    payload: string  // готовый сериализованный last turn
  }) => Promise<number | null>
  /** Обновить накопленный текст ревью (text event). */
  appendReviewContent: (reviewChatId: number, text: string) => void
  /** Финализировать ревью: парсит noteCount + findings, status='done'. */
  finalizeReview: (reviewChatId: number) => void
  /** V2: переключить «принято» для одного finding по id. */
  toggleFinding: (reviewChatId: number, findingId: string) => void
  /** Помечает ревью как failed. */
  failReview: (reviewChatId: number, message: string) => void
  /** Раскрыть/свернуть review panel. */
  toggleReviewPanel: (reviewChatId: number | null) => void
  /** Очистить in-memory review state для удалённого main-чата. */
  cleanupReviewsFor: (parentChatId: number) => void
}

export const createReviewSlice: StateCreator<ProjectState, [], [], ReviewSlice> = (set, get) => ({
  reviews: {},
  openedReviewId: null,
  refreshReviewsFor: async (parentChatId) => {
    try {
      const list = await window.api.chatSessions.listReviews(parentChatId)
      // Grok audit fix (race): к моменту получения ответа из БД пользователь
      // мог переключиться на другой чат. Проверяем, что parentChatId всё
      // ещё активен — иначе результат stale, выбрасываем.
      const activeNow = get().activeChatId
      if (activeNow !== parentChatId) return
      const toHydrate: number[] = []
      set(s => {
        const next = { ...s.reviews }
        for (const r of list) {
          // Не перезаписываем streaming/error entries в памяти данными из БД.
          // БД-версия — это «сохранённый факт ревью», память может содержать
          // живой стрим, который мы не должны затирать.
          if (next[r.id] && next[r.id].status !== 'done') continue
          if (!next[r.id]) {
            next[r.id] = {
              reviewChatId: r.id,
              parentChatId,
              providerId: r.providerId ?? 'unknown',
              model: r.model,
              content: '',
              status: 'done',
              createdAt: r.createdAt,
              noteCount: -1,
              findings: [],
              accepted: []
            }
            toHydrate.push(r.id)  // подгрузить сохранённый текст ревью ниже
          }
        }
        return { reviews: next }
      })
      // Гидратация content+findings из сохранённых сообщений review-чата (аудит
      // P0 #5): finalizeReview персистит текст ревью как assistant-сообщение
      // review-сессии. Без этого restored pill раскрывался пустым «фантомом».
      // Best-effort, по одному; повторно активный чат сверяем (анти-stale).
      for (const reviewChatId of toHydrate) {
        try {
          const msgs = await window.api.chats.list(reviewChatId)
          const content = [...msgs].reverse().find(mm => mm.role === 'assistant')?.content ?? ''
          if (!content.trim()) continue
          if (get().activeChatId !== parentChatId) return
          const firstLine = content.split('\n', 1)[0] ?? ''
          const m = firstLine.match(/ЗАМЕЧАНИЙ:\s*(\d+)/i)
          const noteCount = m ? parseInt(m[1], 10) : -1
          const findings = parseReviewFindings(content)
          set(s => {
            const cur = s.reviews[reviewChatId]
            if (!cur || cur.status !== 'done' || cur.content) return {}
            return { reviews: { ...s.reviews, [reviewChatId]: { ...cur, content, noteCount, findings } } }
          })
        } catch { /* гидратация best-effort — pill останется без содержимого */ }
      }
    } catch (err) {
      console.error('[store] refreshReviewsFor failed:', err)
    }
  },
  startReview: async ({ providerId, model, payload }) => {
    const s = get()
    if (!s.path || s.activeChatId == null) return null
    const parentChatId = s.activeChatId
    const reviewerLabel = providerId
    // 1. Создаём sub-chat в БД с kind='review' и привязкой к parent.
    let reviewChat
    try {
      reviewChat = await window.api.chatSessions.create(s.path, {
        title: `Review: ${reviewerLabel}`,
        providerId,
        model,
        kind: 'review',
        parentChatId
      })
    } catch (err) {
      console.error('[store] startReview create failed:', err)
      return null
    }
    // 2. Регистрируем ревью в локальном state СРАЗУ — pill в Timeline
    //    появится в статусе streaming.
    set(state => ({
      reviews: {
        ...state.reviews,
        [reviewChat.id]: {
          reviewChatId: reviewChat.id,
          parentChatId,
          providerId,
          model,
          content: '',
          status: 'streaming' as const,
          createdAt: Date.now(),
          noteCount: -1,
          findings: [],
          accepted: []
        }
      }
    }))
    // 2b. Логируем старт ревью в журнал проекта — это аудит-trail, чтобы
    //     потом можно было посмотреть когда / какой провайдер / каким был
    //     payload. Detail обрезаем до разумного размера.
    void window.api.journal.append(s.path, 'note',
      `🔍 Запущено ревью: ${providerId}`,
      payload.length > 500 ? payload.slice(0, 500) + '…' : payload
    ).catch(() => {})
    // 3. Стартуем ai:send с override провайдером + флагом useReviewerPrompt.
    //    Сам текст REVIEWER_SYSTEM_PROMPT живёт в electron/ai/ — renderer не
    //    может его импортнуть, поэтому шлём флаг, main process подставляет
    //    промпт сам (см. ipc/ai.ts).
    try {
      const sendId = await window.api.ai.sendWithOverrides(
        [{ role: 'user', content: payload }],
        s.path,
        {
          providerId,
          model,
          noTools: true,
          useReviewerPrompt: true
        }
      )
      // Grok audit fix: ai:send возвращает 0 если провайдер недоступен
      // (нет API key, не найден бинарь CLI, и т.п.). Error event улетел с
      // id=0 — наш routing его не словит, и pill повиснет в streaming.
      // Если sendId=0, сами помечаем review как failed с понятным сообщением.
      if (!sendId || sendId <= 0) {
        get().failReview(reviewChat.id,
          `Провайдер «${providerId}» недоступен (нет ключа, не установлен CLI, или другая ошибка инициализации). Проверь Settings.`)
        return reviewChat.id
      }
      get().registerSendOwner(sendId, { kind: 'review', reviewChatId: reviewChat.id, parentChatId })
      return reviewChat.id
    } catch (err) {
      console.error('[store] startReview sendWithOverrides failed:', err)
      get().failReview(reviewChat.id, err instanceof Error ? err.message : String(err))
      return reviewChat.id
    }
  },
  appendReviewContent: (reviewChatId, text) => set(s => {
    const r = s.reviews[reviewChatId]
    if (!r) return {}
    return { reviews: { ...s.reviews, [reviewChatId]: { ...r, content: r.content + text } } }
  }),
  finalizeReview: (reviewChatId) => {
    const r = get().reviews[reviewChatId]
    if (!r) return
    // Парсим «ЗАМЕЧАНИЙ: N» из первой строки (V1, на нём завязан pill noteCount).
    const firstLine = r.content.split('\n', 1)[0] ?? ''
    const m = firstLine.match(/ЗАМЕЧАНИЙ:\s*(\d+)/i)
    const noteCount = m ? parseInt(m[1], 10) : -1
    // V2: вытаскиваем структурированные findings из ```json блока (fallback на
    // старый текстовый формат внутри parseReviewFindings).
    const findings = parseReviewFindings(r.content)
    set(s => {
      const cur = s.reviews[reviewChatId]
      if (!cur) return {}
      return { reviews: { ...s.reviews, [reviewChatId]: { ...cur, status: 'done', noteCount, findings } } }
    })
    // Персист (аудит P0 #5): сохраняем текст ревью как сообщение review-чата,
    // чтобы после рестарта refreshReviewsFor восстановил content+findings, а не
    // показывал пустой «фантомный» pill. Best-effort.
    const path = get().path
    if (path && r.content.trim()) {
      void window.api.chats.append(reviewChatId, path, 'assistant', r.content).catch(() => {})
    }
  },
  toggleFinding: (reviewChatId, findingId) => set(s => {
    const r = s.reviews[reviewChatId]
    if (!r) return {}
    const accepted = r.accepted.includes(findingId)
      ? r.accepted.filter(id => id !== findingId)
      : [...r.accepted, findingId]
    return { reviews: { ...s.reviews, [reviewChatId]: { ...r, accepted } } }
  }),
  failReview: (reviewChatId, message) => set(s => {
    const r = s.reviews[reviewChatId]
    if (!r) return {}
    return { reviews: { ...s.reviews, [reviewChatId]: { ...r, status: 'error', errorMessage: message } } }
  }),
  toggleReviewPanel: (reviewChatId) => set(s => ({
    openedReviewId: s.openedReviewId === reviewChatId ? null : reviewChatId
  })),
  cleanupReviewsFor: (parentChatId) => set(s => {
    // Удаляем review entries этого main-чата + связанные sendOwners.
    // Закрываем openedReviewId если он был из этого чата.
    const nextReviews: typeof s.reviews = {}
    const removedIds = new Set<number>()
    for (const r of Object.values(s.reviews)) {
      if (r.parentChatId === parentChatId) {
        removedIds.add(r.reviewChatId)
      } else {
        nextReviews[r.reviewChatId] = r
      }
    }
    // Drain sendOwners: убираем review-owner'ы удалённых чатов + chat-owner
    // самого parentChatId (если main чат удалён, его in-flight sendId
    // больше некуда роутить).
    const nextOwners: typeof s.sendOwners = {}
    for (const [sid, owner] of Object.entries(s.sendOwners)) {
      if (owner.kind === 'review' && removedIds.has(owner.reviewChatId)) continue
      if (owner.kind === 'chat' && owner.chatId === parentChatId) continue
      nextOwners[Number(sid)] = owner
    }
    return {
      reviews: nextReviews,
      sendOwners: nextOwners,
      openedReviewId: (s.openedReviewId != null && removedIds.has(s.openedReviewId)) ? null : s.openedReviewId
    }
  }),
})
