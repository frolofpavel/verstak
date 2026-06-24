import { describe, it, expect } from 'vitest'
import { buildCompactSummaryPrompt, extractTouchedFiles } from '../../electron/ai/compact-history'
import type { ChatMessage } from '../../electron/ai/types'

// T1.6 — структурная итеративная компакция: вместо free-form резюме фиксированная
// схема (Goal/Progress/Files) + протяжка тронутых файлов + итеративное обновление
// предыдущего резюме (не ре-суммаризация с нуля).
const msgs: ChatMessage[] = [
  { role: 'user', content: 'сделай рефактор' },
  { role: 'assistant', content: 'читаю файлы', toolCalls: [
    { id: '1', name: 'read_file', args: { path: 'src/a.ts' } },
    { id: '2', name: 'write_file', args: { path: 'src/b.py', content: '...' } },
  ] },
  { role: 'user', content: '', toolResults: [{ id: '1', name: 'read_file', result: 'код' }] },
  { role: 'assistant', content: 'правлю', toolCalls: [
    { id: '3', name: 'apply_patch', args: { path: 'src/a.ts', diff: '...' } },
  ] },
]

describe('extractTouchedFiles', () => {
  it('собирает пути из read/write/apply_patch, дедупит, в порядке', () => {
    expect(extractTouchedFiles(msgs)).toEqual(['src/a.ts', 'src/b.py'])
  })
  it('нет файловых тулзов → []', () => {
    expect(extractTouchedFiles([{ role: 'user', content: 'привет' }])).toEqual([])
  })
  // Ревью 24.06: propose_edits — главный мульти-файловый редактор, пути в edits[].path.
  it('извлекает пути из propose_edits (edits[].path)', () => {
    const m: ChatMessage[] = [{ role: 'assistant', content: '', toolCalls: [
      { id: '1', name: 'propose_edits', args: { edits: [{ path: 'src/x.ts', diff: '...' }, { path: 'src/y.ts', diff: '...' }] } },
    ] }]
    expect(extractTouchedFiles(m)).toEqual(['src/x.ts', 'src/y.ts'])
  })
})

describe('buildCompactSummaryPrompt — структурная схема', () => {
  it('требует фиксированные разделы (ЦЕЛЬ/ПРОГРЕСС/ФАЙЛЫ)', () => {
    const p = buildCompactSummaryPrompt(msgs)[0].content ?? ''
    expect(p).toContain('ЦЕЛЬ')
    expect(p).toContain('ПРОГРЕСС')
    expect(p).toContain('ФАЙЛЫ')
  })
  it('протягивает тронутые файлы в промпт (провенанс не теряется)', () => {
    const p = buildCompactSummaryPrompt(msgs)[0].content ?? ''
    expect(p).toContain('src/a.ts')
    expect(p).toContain('src/b.py')
  })
  it('без previousSummary — нет инструкции «обнови»', () => {
    const p = buildCompactSummaryPrompt(msgs)[0].content ?? ''
    expect(p).not.toMatch(/ОБНОВИ/i)
  })
  it('с previousSummary — итеративное обновление (включает прежнее + «обнови»)', () => {
    const p = buildCompactSummaryPrompt(msgs, { previousSummary: 'ЦЕЛЬ: старая цель' })[0].content ?? ''
    expect(p).toContain('ЦЕЛЬ: старая цель')
    expect(p).toMatch(/ОБНОВИ/i)
  })
})
