export interface StreamDeltaBatch {
  chatId: number
  text: string
  thought: string
}

type Schedule = (callback: () => void) => number
type Cancel = (handle: number) => void

/**
 * Coalesces tiny provider deltas into one state update per animation frame.
 * Terminal events can flush one send synchronously, preserving event order.
 */
export function createStreamDeltaBatcher(
  apply: (batch: StreamDeltaBatch) => void,
  schedule: Schedule = callback => requestAnimationFrame(callback),
  cancel: Cancel = handle => cancelAnimationFrame(handle)
) {
  const pending = new Map<number, StreamDeltaBatch>()
  let scheduled: number | null = null

  function flush(sendId?: number): void {
    if (sendId != null) {
      const batch = pending.get(sendId)
      if (!batch) return
      pending.delete(sendId)
      apply(batch)
      return
    }

    const batches = [...pending.values()]
    pending.clear()
    for (const batch of batches) apply(batch)
  }

  function scheduleFlush(): void {
    if (scheduled != null) return
    scheduled = schedule(() => {
      scheduled = null
      flush()
    })
  }

  return {
    enqueue(sendId: number, chatId: number, kind: 'text' | 'thought', value: string): void {
      const current = pending.get(sendId) ?? { chatId, text: '', thought: '' }
      pending.set(sendId, {
        chatId,
        text: current.text + (kind === 'text' ? value : ''),
        thought: current.thought + (kind === 'thought' ? value : '')
      })
      scheduleFlush()
    },
    flush,
    dispose(): void {
      if (scheduled != null) cancel(scheduled)
      scheduled = null
      flush()
    }
  }
}
