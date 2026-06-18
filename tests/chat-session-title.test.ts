import { describe, expect, it } from 'vitest'
import { isGenericChatTitle, titleFromFirstMessage } from '../src/lib/chat-session-title'

describe('chat-session-title', () => {
  it('detects generic placeholders in ru and en', () => {
    expect(isGenericChatTitle('Новый чат')).toBe(true)
    expect(isGenericChatTitle('Parallel chat')).toBe(true)
    expect(isGenericChatTitle('Основной чат')).toBe(true)
    expect(isGenericChatTitle('Настройка автозапуска Zapret')).toBe(false)
  })

  it('builds a short title from the first line', () => {
    expect(titleFromFirstMessage('почини автозапуск zapret hub при старте windows'))
      .toBe('Почини автозапуск zapret hub при старте windows')
  })

  it('truncates long questions', () => {
    const long = 'а'.repeat(80)
    const title = titleFromFirstMessage(long)
    expect(title).not.toBeNull()
    expect(title!.length).toBeLessThanOrEqual(53)
    expect(title!.endsWith('…')).toBe(true)
  })

  it('strips markdown noise', () => {
    expect(titleFromFirstMessage('```ts\nconst x = 1\n```\n\nДобавь кнопку в трей'))
      .toBe('Добавь кнопку в трей')
  })

  it('берёт ТОЛЬКО первую строку многострочного сообщения, не склеивает', () => {
    expect(titleFromFirstMessage('Почини кнопку логина\nвот трейс ошибки:\nTypeError: x is undefined'))
      .toBe('Почини кнопку логина')
  })
})