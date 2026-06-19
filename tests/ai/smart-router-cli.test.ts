import { describe, it, expect } from 'vitest'
import { detectCliWorthiness } from '../../electron/ai/smart-router'
import type { ChatMessage } from '../../electron/ai/types'

const u = (content: string): ChatMessage => ({ role: 'user', content })

describe('detectCliWorthiness (гибридный роутинг API↔CLI)', () => {
  it('сборка/типы → терминальная (Сценарий Б из ТЗ)', () => {
    expect(detectCliWorthiness([u('Найди почему падает сборка tsc и исправь типы')])?.reason)
      .toMatch(/сборк|компил/)
  })

  it('прогон тестов → терминальная', () => {
    expect(detectCliWorthiness([u('запусти тесты и убедись что проходят')])?.reason).toMatch(/тест/)
    expect(detectCliWorthiness([u('make the failing test pass')])?.reason).toMatch(/тест/)
    expect(detectCliWorthiness([u('почему тесты падают, npm run test красный')])).not.toBeNull()
  })

  it('итеративная отладка по выводу → терминальная', () => {
    expect(detectCliWorthiness([u('почему приложение крашится при старте?')])).not.toBeNull()
    expect(detectCliWorthiness([u('debug this stack trace')])).not.toBeNull()
  })

  it('локальное окружение/команды → терминальная', () => {
    expect(detectCliWorthiness([u('npm install и подними сервер локально')])).not.toBeNull()
    expect(detectCliWorthiness([u('прогони миграции базы')])).not.toBeNull()
  })

  it('простой вопрос/правка текста → НЕ терминальная (не сжигаем CLI зря)', () => {
    expect(detectCliWorthiness([u('объясни простыми словами что такое замыкание')])).toBeNull()
    expect(detectCliWorthiness([u('перепиши этот абзац короче')])).toBeNull()
    expect(detectCliWorthiness([u('как называется этот паттерн?')])).toBeNull()
  })

  it('берёт ПОСЛЕДНЕЕ сообщение пользователя', () => {
    const msgs: ChatMessage[] = [
      u('запусти тесты'),
      { role: 'assistant', content: 'готово' },
      u('спасибо, объясни результат'),
    ]
    expect(detectCliWorthiness(msgs)).toBeNull() // последнее — объяснение, не терминал
  })

  it('пустая история → null', () => {
    expect(detectCliWorthiness([])).toBeNull()
    expect(detectCliWorthiness([{ role: 'assistant', content: 'hi' }])).toBeNull()
  })
})
