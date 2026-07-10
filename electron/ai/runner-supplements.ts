// Дополнения к активному прогону (распил ai.ts, 1.9.8 #1, срез 2).
//
// Инъекция догруженного контекста в идущий agent-loop по sendId (ai:append-context).
// Вынесено из ipc/ai.ts БЕЗ изменения логики — самодостаточный кластер: Map
// слушателей + форматирование supplement-сообщения.

/** Дополнения user-сообщений в активный API agent-loop (sendId → push). */
const conversationSupplements = new Map<number, (text: string) => void>()

export function registerConversationSupplements(sendId: number, push: (text: string) => void): void {
  conversationSupplements.set(sendId, push)
}

export function unregisterConversationSupplements(sendId: number): void {
  conversationSupplements.delete(sendId)
}

/** Инъекция догруженного контекста (supplement) в активный прогон по sendId.
 *  false — если для sendId нет активного слушателя. Используется ai:append-context. */
export function pushConversationSupplement(sendId: number, text: string): 'deferred' | false {
  const push = conversationSupplements.get(sendId)
  if (!push) return false
  push(text)
  return 'deferred'
}

export function formatConversationSupplement(text: string): string {
  return [
    '[Дополнение к текущей задаче]',
    'Это не новая задача и не элемент очереди. Обязательно учти это дополнение в текущем прогоне перед следующим действием, следующим вызовом инструментов или финальным ответом.',
    'Если уже был составлен план, скорректируй его. Не завершай старый вариант работы так, будто этого дополнения нет.',
    '',
    text.trim(),
  ].join('\n')
}
