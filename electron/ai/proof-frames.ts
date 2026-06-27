/**
 * Tier-2 #5 — буфер кадров browser-прохода per-send. browser_screenshot складывает
 * PNG-кадры сюда, create_proof_video забирает и кодирует в MP4-доказательство.
 * Модульное состояние (оба хендлера видят), ключ — sendId (стабилен в рамках прогона).
 */

const MAX_FRAMES = 60
const buffers = new Map<number, Buffer[]>()

export function addProofFrame(sendId: number, png: Buffer): void {
  const arr = buffers.get(sendId) ?? []
  arr.push(png)
  while (arr.length > MAX_FRAMES) arr.shift() // кап: не копим бесконечно
  buffers.set(sendId, arr)
}

/** Забрать и очистить кадры прогона. */
export function takeProofFrames(sendId: number): Buffer[] {
  const arr = buffers.get(sendId) ?? []
  buffers.delete(sendId)
  return arr
}

export function proofFrameCount(sendId: number): number {
  return buffers.get(sendId)?.length ?? 0
}
