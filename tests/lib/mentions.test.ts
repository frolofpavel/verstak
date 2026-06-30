import { describe, it, expect } from 'vitest'
import { extractMentions } from '../../src/lib/mentions'

describe('extractMentions', () => {
  it('извлекает @path', () => {
    expect(extractMentions('глянь @src/App.tsx и поправь')).toEqual(['src/App.tsx'])
  })

  it('несколько упоминаний, порядок сохранён, дедуп', () => {
    expect(extractMentions('@a.ts @b/c.ts @a.ts')).toEqual(['a.ts', 'b/c.ts'])
  })

  it('@ в начале строки', () => {
    expect(extractMentions('@README.md что тут')).toEqual(['README.md'])
  })

  it('не ловит email (foo@bar — @ не после пробела/начала)', () => {
    expect(extractMentions('пиши на user@example.com')).toEqual([])
  })

  it('хвостовая пунктуация снимается', () => {
    expect(extractMentions('файл @src/x.ts, потом @y.ts.')).toEqual(['src/x.ts', 'y.ts'])
  })

  it('backslash → forward slash', () => {
    expect(extractMentions('@electron\\ai\\tools.ts')).toEqual(['electron/ai/tools.ts'])
  })

  it('нет упоминаний → []', () => {
    expect(extractMentions('обычный текст без собак')).toEqual([])
  })
})
