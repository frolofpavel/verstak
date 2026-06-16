/** Маркер user-сообщения, дополненного во время активного прогона агента. */
export const SUPPLEMENT_TAG = '[Дополнение к текущей задаче]'

export function formatSupplementForAgent(text: string): string {
  return `${SUPPLEMENT_TAG}\n${text.trim()}`
}

export interface QueuedComposerMessage {
  text: string
}