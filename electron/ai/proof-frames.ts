/**
 * Tier-2 #5 — буфер кадров browser-прохода per-send. browser_screenshot складывает
 * PNG-кадры сюда, create_proof_video забирает и кодирует в MP4-доказательство.
 * Модульное состояние (оба хендлера видят), ключ — sendId (стабилен в рамках прогона).
 */

const MAX_FRAMES = 60
const MAX_SENDS = 8 // прогоны, не вызвавшие create_proof_video, иначе Map растёт
const buffers = new Map<number, Buffer[]>()

export function addProofFrame(sendId: number, png: Buffer): void {
  const arr = buffers.get(sendId) ?? []
  arr.push(png)
  while (arr.length > MAX_FRAMES) arr.shift() // кап кадров на прогон
  buffers.set(sendId, arr)
  // Эвикт самого старого прогона (Map хранит порядок вставки), если их слишком много.
  while (buffers.size > MAX_SENDS) {
    const oldest = buffers.keys().next().value
    if (oldest === undefined || oldest === sendId) break
    buffers.delete(oldest)
  }
}

/** Прочитать кадры прогона БЕЗ удаления (чтобы при сбое кодирования не потерять). */
export function peekProofFrames(sendId: number): Buffer[] {
  return buffers.get(sendId) ?? []
}

/** Забрать и очистить кадры прогона (вызывать только после успешного кодирования). */
export function takeProofFrames(sendId: number): Buffer[] {
  const arr = buffers.get(sendId) ?? []
  buffers.delete(sendId)
  return arr
}
