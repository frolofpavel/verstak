import { describe, it, expect } from 'vitest'
import { activeMentionQuery } from '../../src/components/MentionPopup'

describe('activeMentionQuery — активный @-токен в конце', () => {
  it('@ в конце после пробела → query', () => {
    const r = activeMentionQuery('глянь @src/Ap')
    expect(r).toEqual({ query: 'src/Ap', start: 6 })
  })

  it('@ в начале строки', () => {
    const r = activeMentionQuery('@READ')
    expect(r).toEqual({ query: 'READ', start: 0 })
  })

  it('пустой query сразу после @', () => {
    const r = activeMentionQuery('добавь @')
    expect(r).toEqual({ query: '', start: 7 })
  })

  it('@ не в конце (есть пробел после) → null', () => {
    expect(activeMentionQuery('@src/App.tsx поправь')).toBeNull()
  })

  it('нет @ → null', () => {
    expect(activeMentionQuery('обычный текст')).toBeNull()
  })

  it('email-подобное (нет пробела перед @) → null', () => {
    expect(activeMentionQuery('user@example')).toBeNull()
  })

  it('start корректно указывает на символ @', () => {
    const text = 'fix @a/b'
    const r = activeMentionQuery(text)!
    expect(text[r.start]).toBe('@')
  })
})
