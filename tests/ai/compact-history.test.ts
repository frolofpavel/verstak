import { describe, it, expect } from 'vitest'
import { compactToolHistory, diffSize, smartCompressResult, shouldAutoCompact } from '../../electron/ai/compact-history'
import type { ChatMessage } from '../../electron/ai/types'

function bigResult(name: string, size: number): ChatMessage {
  return {
    role: 'user',
    content: '',
    toolResults: [{ id: name + '-id', name, result: 'X'.repeat(size) }]
  }
}

describe('compactToolHistory', () => {
  it('не трогает свежие turns в окне (currentTurn <= KEEP_RECENT_TURNS)', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'response' },
      bigResult('read_file', 5000)
    ]
    const out = compactToolHistory(msgs, 0)
    // currentTurn=0, cutoff < 0 → ничего не сжимается, только cap-проверка
    expect(out[2].toolResults![0].result).toBe('X'.repeat(5000))
  })

  it('сжимает старые tool results при currentTurn > KEEP_RECENT_TURNS', () => {
    // 6 turns с большими результатами
    const msgs: ChatMessage[] = []
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: 'assistant', content: `turn ${i}` })
      msgs.push(bigResult('read_file', 5000))
    }
    // currentTurn=6, KEEP_RECENT=3 → cutoff=3, turns 0,1,2,3 сжимаются (4 шт),
    // turns 4,5 остаются (2 шт)
    const out = compactToolHistory(msgs, 6)
    const toolMsgs = out.filter(m => m.toolResults && m.toolResults.length > 0)
    expect(toolMsgs).toHaveLength(6)
    // Старые сжаты: содержат [compacted: ...]
    expect(toolMsgs[0].toolResults![0].result).toMatch(/\[compacted:/)
    expect(toolMsgs[3].toolResults![0].result).toMatch(/\[compacted:/)
    // Свежие нет
    expect(toolMsgs[4].toolResults![0].result).toBe('X'.repeat(5000))
    expect(toolMsgs[5].toolResults![0].result).toBe('X'.repeat(5000))
  })

  it('не сжимает мелкие старые результаты (< 400 chars) — мало пользы', () => {
    const msgs: ChatMessage[] = []
    for (let i = 0; i < 5; i++) {
      msgs.push({ role: 'assistant', content: `turn ${i}` })
      msgs.push(bigResult('list_directory', 200))
    }
    const out = compactToolHistory(msgs, 5)
    const toolMsgs = out.filter(m => m.toolResults && m.toolResults.length > 0)
    // Все мелкие → ни один не сжат
    for (const tm of toolMsgs) {
      expect(tm.toolResults![0].result).toBe('X'.repeat(200))
    }
  })

  it('сильно жирные СВЕЖИЕ результаты обрезаются tail-strategy (cap 12000)', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: 'r' },
      bigResult('read_file', 50_000)
    ]
    const out = compactToolHistory(msgs, 0)
    const r = out[1].toolResults![0].result as string
    expect(r.length).toBeLessThan(50_000)
    expect(r.length).toBeLessThanOrEqual(12_000)
    expect(r).toMatch(/omitted|вырезано/)
  })

  it('не модифицирует оригинальный массив', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: 'a' },
      bigResult('read_file', 5000),
      { role: 'assistant', content: 'b' },
      bigResult('read_file', 5000),
      { role: 'assistant', content: 'c' },
      bigResult('read_file', 5000),
      { role: 'assistant', content: 'd' },
      bigResult('read_file', 5000)
    ]
    const before = JSON.stringify(msgs)
    compactToolHistory(msgs, 5)
    const after = JSON.stringify(msgs)
    expect(after).toBe(before)
  })

  it('diffSize показывает реальное сокращение', () => {
    const msgs: ChatMessage[] = []
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: 'assistant', content: `turn ${i}` })
      msgs.push(bigResult('read_file', 8000))
    }
    const out = compactToolHistory(msgs, 6)
    const stats = diffSize(msgs, out)
    expect(stats.savedChars).toBeGreaterThan(20_000)
    expect(stats.pct).toBeGreaterThan(30)
  })
})

describe('smartCompressResult — жёсткий потолок по символам', () => {
  // keepTail: однострочный run_command (curl/минифицированный JSON/base64) без
  // переносов раньше обходил FRESH_RESULT_HARD_CAP целиком (push-then-check).
  it('keepTail режет однострочный run_command без \\n до max', () => {
    expect(smartCompressResult('run_command', 'A'.repeat(100_000), 12_000).length).toBeLessThanOrEqual(12_000)
    expect(smartCompressResult('run_command', 'short\n' + 'B'.repeat(50_000), 12_000).length).toBeLessThanOrEqual(12_000)
  })

  it('capFreshResults (production path) режет жирный однострочный run_command', () => {
    const out = compactToolHistory(
      [{ role: 'user', content: '', toolResults: [{ id: 'x', name: 'run_command', result: 'A'.repeat(100_000) }] }],
      0,
    )
    expect((out[0].toolResults![0].result as string).length).toBeLessThanOrEqual(12_000)
  })

  // truncateList: немного длинных строк раньше давали вывод БОЛЬШЕ входа и
  // отрицательный счётчик "(-147 more results)".
  it('truncateList не раздувает вывод и не печатает отрицательный счётчик', () => {
    const fewLong = ['A'.repeat(5000), 'B'.repeat(5000), 'C'.repeat(5000)].join('\n')
    const out = smartCompressResult('list_directory', fewLong, 12_000)
    expect(out.length).toBeLessThanOrEqual(12_000)
    expect(out).not.toMatch(/-\d+ more results/)
  })
})

describe('shouldAutoCompact — учёт args tool-вызовов', () => {
  it('считает полное содержимое файла в args write_file/apply_patch', () => {
    const msgs: ChatMessage[] = []
    for (let i = 0; i < 9; i++) msgs.push({ role: 'assistant', content: '' })
    msgs.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'big.ts', content: 'A'.repeat(40_000) } }],
    })
    // moonshot-v1-8k: лимит 8000, порог 0.95 → 7600 токенов. 40000 симв args = 10000 токенов.
    // Без учёта args estimateTotalTokens ≈ 0 → false; с учётом → true.
    expect(shouldAutoCompact(msgs, 'moonshot-v1-8k')).toBe(true)
  })
})

describe('shouldAutoCompact — резерв output-бюджета (ревью #5)', () => {
  it('срабатывает раньше полного limit*0.95 (резерв под вывод модели)', () => {
    // gpt-4o limit=128000 → effectiveLimit=115200, порог 109440. Полный limit*0.95=121600.
    // 115000 токенов попадает МЕЖДУ: раньше (от полного лимита) НЕ сжимал, теперь сжимает.
    const big = 'x'.repeat(46_000) // ~11500 токенов на сообщение
    const msgs: ChatMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant', content: big,
    }))
    expect(shouldAutoCompact(msgs, 'gpt-4o')).toBe(true)
  })

  it('не срабатывает заметно ниже порога', () => {
    const small = 'x'.repeat(4_000) // ~1000 токенов
    const msgs: ChatMessage[] = Array.from({ length: 10 }, () => ({ role: 'user' as const, content: small }))
    expect(shouldAutoCompact(msgs, 'gpt-4o')).toBe(false)
  })
})
