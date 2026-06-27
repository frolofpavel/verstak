import { describe, it, expect } from 'vitest'
import { microcompact } from '../../electron/ai/compact-history'
import type { ChatMessage } from '../../electron/ai/types'

// Tier-2 #2 — microcompact: дешёвый обратимый прунинг по РАЗМЕРУ (не по возрасту,
// как sliding-window) без LLM. Маркеруем самые большие старые tool-результаты, пока
// не наберём target; последние turn'ы защищены; мелкие/уже-сжатые не трогаем.
const big = (n: number) => 'x'.repeat(n)
const tr = (name: string, result: string) => ({ id: name, name, result })

function history(): ChatMessage[] {
  return [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'read_file', args: {} }] },
    { role: 'user', content: '', toolResults: [tr('read_file', big(8000))] },   // turn 0 (старый, большой)
    { role: 'assistant', content: '', toolCalls: [{ id: '2', name: 'run_command', args: {} }] },
    { role: 'user', content: '', toolResults: [tr('run_command', big(500))] },  // turn 1 (мелкий)
    { role: 'assistant', content: '', toolCalls: [{ id: '3', name: 'read_file', args: {} }] },
    { role: 'user', content: '', toolResults: [tr('read_file', big(9000))] },   // turn 2 (свежий — защищён)
  ]
}

describe('microcompact', () => {
  it('маркерует самый большой СТАРЫЙ результат, свежий не трогает', () => {
    const r = microcompact(history(), { targetReclaimChars: 5000, keepRecentTurns: 1 })
    expect(r.pruned).toBe(1)
    expect(r.reclaimedChars).toBeGreaterThanOrEqual(8000)
    // turn 0 (стр.2) сжат в маркер
    const t0 = r.messages[2].toolResults![0].result as string
    expect(t0).toContain('microcompact')
    // turn 2 (стр.6, свежий) цел
    expect((r.messages[6].toolResults![0].result as string).length).toBe(9000)
  })

  it('мелкие (< minResultChars) не трогает', () => {
    const r = microcompact(history(), { targetReclaimChars: 100000, keepRecentTurns: 1, minResultChars: 2000 })
    // turn 1 (500 симв) не должен попасть в маркер
    expect(r.messages[4].toolResults![0].result).toBe(big(500))
  })

  it('нечего сжимать (всё защищено/мелкое) → pruned=0, исходные messages', () => {
    const msgs = history()
    const r = microcompact(msgs, { targetReclaimChars: 5000, keepRecentTurns: 5 })
    expect(r.pruned).toBe(0)
    expect(r.messages).toBe(msgs)
  })

  it('уже сжатый (microcompact/compacted маркер) повторно не трогает', () => {
    const msgs = history()
    msgs[2].toolResults![0].result = '[microcompacted: read_file (8000 симв.) …]'
    const r = microcompact(msgs, { targetReclaimChars: 5000, keepRecentTurns: 1 })
    expect(r.pruned).toBe(0)
  })
})
