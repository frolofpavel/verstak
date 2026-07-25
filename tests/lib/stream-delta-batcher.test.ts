import { describe, expect, it, vi } from 'vitest'
import { createStreamDeltaBatcher, type StreamDeltaBatch } from '../../src/lib/stream-delta-batcher'

describe('stream delta batcher', () => {
  it('склеивает text и thought одного send в один render update', () => {
    const applied: StreamDeltaBatch[] = []
    let scheduled: (() => void) | null = null
    const batcher = createStreamDeltaBatcher(
      batch => applied.push(batch),
      callback => {
        scheduled = callback
        return 1
      },
      vi.fn()
    )

    batcher.enqueue(7, 42, 'text', 'бы')
    batcher.enqueue(7, 42, 'text', 'стро')
    batcher.enqueue(7, 42, 'thought', 'думаю')
    expect(applied).toEqual([])

    const runScheduled = scheduled as (() => void) | null
    expect(runScheduled).not.toBeNull()
    runScheduled?.()

    expect(applied).toEqual([{ chatId: 42, text: 'быстро', thought: 'думаю' }])
  })

  it('не смешивает параллельные send и flush сохраняет порядок terminal event', () => {
    const applied: StreamDeltaBatch[] = []
    const batcher = createStreamDeltaBatcher(
      batch => applied.push(batch),
      () => 1,
      vi.fn()
    )

    batcher.enqueue(1, 10, 'text', 'A')
    batcher.enqueue(2, 20, 'text', 'B')
    batcher.flush(2)
    expect(applied).toEqual([{ chatId: 20, text: 'B', thought: '' }])

    batcher.flush(1)
    expect(applied).toEqual([
      { chatId: 20, text: 'B', thought: '' },
      { chatId: 10, text: 'A', thought: '' }
    ])
  })

  it('dispose отменяет frame и не теряет накопленный текст', () => {
    const cancel = vi.fn()
    const applied: StreamDeltaBatch[] = []
    const batcher = createStreamDeltaBatcher(batch => applied.push(batch), () => 17, cancel)

    batcher.enqueue(1, 10, 'text', 'done')
    batcher.dispose()

    expect(cancel).toHaveBeenCalledWith(17)
    expect(applied).toEqual([{ chatId: 10, text: 'done', thought: '' }])
  })
})
