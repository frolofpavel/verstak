// Распил ai.ts (2.1.10-G): recall памяти проекта для ai:send.
//
// Вынесено из registerAiIpc БЕЗ изменения логики. Здесь живёт вся подготовка
// «что модель вспомнит о проекте» до сборки system-промпта:
//  · реестр уже прогретых чатов (инъекция recall один раз за app-сессию на чат);
//  · снапшот памяти прогона (RRF-fusion релевантность ⊕ недавность) + core memory;
//  · memory-nudge консолидации.
//
// Побочные эффекты передаются callback'ом emitProgress — порядок событий остаётся
// за вызывающим хендлером. Реестр memorizedChats переехал сюда вместе с блоком,
// но forgetMemorizedChat/forgetMemorizedProject реэкспортируются из ipc/ai.ts:
// публичная поверхность модуля для main.ts и тестов не меняется.

import type { ChatMessage } from '../../ai/types'
import type { AgentProgressPayload } from '../../ai/runner-progress'
import { createLegacyMemoryProvider } from '../../ai/memory/provider'
import { buildRunMemorySnapshot, memorySnapshotFingerprint, snapshotPromptMemories } from '../../ai/memory/run-snapshot'
import { logRuntime, logRuntimeError } from '../../runtime-log'

// Track which chats have already received memory injection in this process
// lifetime. Replaces the old isFirstTurn check so memory is injected on the
// first ai:send for a chat in this app session — not only on truly-first-ever
// turns (which broke reopened old chats with existing assistant messages).
const memorizedChats = new Set<string>()

/**
 * Remove a single chat key from the memory-injection cache.
 * Call when a chat session is deleted so a new session reusing the same
 * numeric id (or projectPath fallback) gets a fresh memory injection.
 */
export function forgetMemorizedChat(key: string): void {
  memorizedChats.delete(key)
}

/**
 * Remove a projectPath fallback key when a project is removed.
 * Only relevant for chats where no chatId was provided to ai:send.
 */
export function forgetMemorizedProject(projectPath: string): void {
  memorizedChats.delete(projectPath)
}

/** Только для тестов: сбросить реестр прогретых чатов между кейсами. */
export function resetMemorizedChats(): void {
  memorizedChats.clear()
}

export interface SendMemoryContext {
  memories: { type: string; content: string; tags: string[] }[]
  consolidationHint: string | null
  coreMemory: { memory: string; user: string }
}

export interface MemoryContextDeps {
  searchMemories: (projectPath: string, query: string, limit: number) => Array<{ id: string; type: string; content: string; tags: string[]; created_at: number }>
  memoryConsolidationHint?: (projectPath: string) => string | null
}

/**
 * Recall памяти проекта для одного ai:send.
 *
 * Нет projectPath → память не трогаем вовсе (пустой контекст, ни одного события).
 * Есть — снимаем снапшот и сообщаем прогресс. Падение recall'а НЕ блокирует ответ:
 * прогон продолжается без памяти, как и раньше.
 */
export function buildSendMemoryContext(input: {
  projectPath: string | null
  /** Ключ кеша инъекции: chatId, иначе projectPath, иначе общий фолбэк. */
  chatId?: string
  messages: ChatMessage[]
  deps: MemoryContextDeps
  sendId: number
  runId: string
  emitProgress: (payload: AgentProgressPayload) => void
}): SendMemoryContext {
  // Накопители объявлены снаружи try ровно как в исходном хендлере: если исключение
  // прилетит ПОСЛЕ снятия снапшота (лог/прогресс), уже собранная память не теряется.
  let memories: { type: string; content: string; tags: string[] }[] = []
  let consolidationHint: string | null = null
  let coreMemory = { memory: '', user: '' }
  const memoryCacheKey = input.chatId ?? (input.projectPath ?? '__no_project__')
  const shouldInjectMemory = input.projectPath && !memorizedChats.has(memoryCacheKey)
  if (shouldInjectMemory) {
    // Safety net: if the Set has grown past 500 entries (process running for
    // many days without restart), clear it entirely. This is a one-time
    // cache miss — memories get re-injected once per affected chat — not data loss.
    if (memorizedChats.size > 500) memorizedChats.clear()
    memorizedChats.add(memoryCacheKey)
  }
  const projectPath = input.projectPath
  if (!projectPath) return { memories, consolidationHint, coreMemory }

  input.emitProgress({
    id: 'context-memory',
    phase: 'context',
    title: 'Ищу память проекта',
    detail: 'Подбираю сохранённые факты и недавние записи, которые могут быть полезны для ответа.',
    status: 'running'
  })
  try {
    // #1 релевантный recall + ось 4 #1 RRF-fusion: блендим два канала вместо бинарного
    // «релевантные ИЛИ недавние». Канал релевантности (FTS5/BM25 по последнему user-
    // сообщению) ⊕ канал недавности (без session-summary, чтобы не вытесняли факты).
    // Факт и релевантный, и недавний — всплывает выше. Чисто на позициях, без векторов.
    const recallQuery = [...input.messages].reverse().find(m => m.role === 'user')?.content ?? ''
    const memoryProvider = createLegacyMemoryProvider({
      searchMemories: input.deps.searchMemories,
      memoryConsolidationHint: input.deps.memoryConsolidationHint,
    })
    // Ревью HIGH: фильтр session-summary ПОСЛЕ LIMIT обнулял recency-канал — session-summary
    // (свежайший accessed_at, пишутся в конце каждой сессии) занимали топ-5 и все выпадали
    // фильтром, реальные факты не попадали. Берём с запасом (20) ДО фильтра, потом slice(5).
    const memorySnapshot = buildRunMemorySnapshot(memoryProvider, {
      projectPath,
      query: typeof recallQuery === 'string' ? recallQuery : '',
      includeRecall: Boolean(shouldInjectMemory),
    })
    memories = snapshotPromptMemories(memorySnapshot)
    // memory-nudge консолидации (раз на чат, как и recall): если воспоминания
    // накопились/задублировались — мягко предлагаем модели консолидировать.
    consolidationHint = memorySnapshot.consolidationHint
    coreMemory = memorySnapshot.coreMemory
    logRuntime('ai.memory.snapshot', {
      sendId: input.sendId,
      runId: input.runId,
      projectPath,
      entries: memories.length,
      coreMemoryChars: coreMemory.memory.length,
      coreUserChars: coreMemory.user.length,
      fingerprint: memorySnapshotFingerprint(memorySnapshot),
    })
    input.emitProgress({
      id: 'context-memory',
      phase: 'context',
      title: memories.length > 0 ? 'Память проекта добавлена' : 'Память проверена',
      detail: memories.length > 0
        ? `Нашёл ${memories.length} подходящих записей и добавил их в контекст.`
        : 'Подходящих записей не нашёл, продолжаю по истории чата и настройкам проекта.',
      status: 'done'
    })
    return { memories, consolidationHint, coreMemory }
  } catch (err) {
    // Память недоступна — продолжаем без неё, не блокируем пользователя
    logRuntimeError('ai.memories.search.fail', err, { sendId: input.sendId, runId: input.runId, projectPath })
    console.warn('[ai] searchMemories failed:', err instanceof Error ? err.message : err)
    input.emitProgress({
      id: 'context-memory',
      phase: 'context',
      title: 'Память проекта недоступна',
      detail: 'Не блокирую ответ: продолжаю без сохранённой памяти проекта.',
      status: 'done'
    })
    return { memories, consolidationHint, coreMemory }
  }
}
