/** Маркер user-сообщения, дополненного во время активного прогона агента. */
export const SUPPLEMENT_TAG = '[Дополнение к текущей задаче]'
export const CANCELLED_SUPPLEMENT_CONTENT = '[Дополнение отменено]\nПользователь отменил ранее добавленное дополнение к текущей задаче. Не учитывай его в будущих ответах.'

export function formatSupplementForAgent(text: string): string {
  return `${SUPPLEMENT_TAG}\n${text.trim()}`
}

export function isSupplementMessage(content: string): boolean {
  return content.startsWith(SUPPLEMENT_TAG)
}

export function parseSupplementMessage(content: string): { tag: string; body: string } | null {
  if (!isSupplementMessage(content)) return null
  const body = content.slice(SUPPLEMENT_TAG.length).replace(/^\n/, '').trim()
  return { tag: SUPPLEMENT_TAG, body }
}

let _itemSeq = 0

export function nextComposerItemId(): string {
  return `cq-${Date.now()}-${++_itemSeq}`
}

export interface QueuedComposerMessage {
  id: string
  text: string
  at: number
}

export type PendingSupplementStatus = 'accepted' | 'deferred'

export interface PendingSupplement {
  id: string
  text: string
  at: number
  status: PendingSupplementStatus
  messageId?: number
}
