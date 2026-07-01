import { describe, it, expect } from 'vitest'
import { withHistoryCacheControl } from '../../electron/ai/claude'

describe('history-prefix caching — withHistoryCacheControl', () => {
  it('строку конвертирует в text-блок с cache_control:ephemeral', () => {
    const r = withHistoryCacheControl('привет')
    expect(Array.isArray(r)).toBe(true)
    const arr = r as Array<Record<string, unknown>>
    expect(arr[0]).toEqual({ type: 'text', text: 'привет', cache_control: { type: 'ephemeral' } })
  })

  it('пустую строку не трогает (нечего кэшировать)', () => {
    expect(withHistoryCacheControl('')).toBe('')
  })

  it('массив блоков — cache_control на ПОСЛЕДНЕМ блоке', () => {
    const blocks = [
      { type: 'tool_result', tool_use_id: 'a', content: 'x' },
      { type: 'text', text: 'итог' },
    ]
    const r = withHistoryCacheControl(blocks) as Array<Record<string, unknown>>
    expect(r[0].cache_control).toBeUndefined()        // не последний — без маркера
    expect(r[1].cache_control).toEqual({ type: 'ephemeral' })  // последний — с маркером
  })

  it('не мутирует исходный массив', () => {
    const blocks = [{ type: 'text', text: 'a' }]
    const r = withHistoryCacheControl(blocks)
    expect((blocks[0] as Record<string, unknown>).cache_control).toBeUndefined()  // оригинал чист
    expect((r as Array<Record<string, unknown>>)[0].cache_control).toBeDefined()
  })

  it('пустой массив блоков — как есть', () => {
    expect(withHistoryCacheControl([])).toEqual([])
  })
})
