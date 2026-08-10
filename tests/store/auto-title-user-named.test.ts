// A2 (пакет 2.5.0, 10.08): чат, названный человеком, авто-имя НЕ перезаписывает.
//
// Автоимя чата (autoTitleChatSession) выводится локальной эвристикой
// titleFromFirstMessage — без обращения к модели прогона. Гейт: переименовываем
// ТОЛЬКО generic-заголовки (isGenericChatTitle). Этот пин — обязательное условие
// постановки P4: имя, данное человеком, священно.
//
// Контрольный кейс рядом (§3.1): generic «Новый чат» ПЕРЕИМЕНОВЫВАЕТСЯ — иначе
// пин «не произошло» зелен и тогда, когда авто-имя не работает вовсе.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const rename = vi.fn(async () => {})
vi.stubGlobal('window', { api: { chatSessions: { rename } } })

const { useProject } = await import('../../src/store/projectStore')

// Конфиг vitest снимает stubGlobal между кейсами — возвращаем стаб перед каждым.
beforeEach(() => {
  vi.stubGlobal('window', { api: { chatSessions: { rename } } })
})

function seed(title: string) {
  useProject.setState({
    chatSessions: [{
      id: 5, projectPath: '/p', title, kind: 'main' as const,
      providerId: null, model: null, parentChatId: null, createdAt: 1, lastMessageAt: 1,
    }],
  }, false)
}

beforeEach(() => { rename.mockClear() })

describe('A2: авто-имя чата не трогает имя, данное человеком', () => {
  it('чат с именем от человека НЕ переименовывается (rename не зовётся)', async () => {
    seed('Разбор Я.Директа')
    await useProject.getState().autoTitleChatSession(5, 'почини кнопку логина')
    expect(rename, 'авто-имя перезаписало пользовательское название чата').not.toHaveBeenCalled()
    expect(useProject.getState().chatSessions[0].title).toBe('Разбор Я.Директа')
  })

  it('КОНТРОЛЬ: generic «Новый чат» получает имя из первого сообщения', async () => {
    seed('Новый чат')
    await useProject.getState().autoTitleChatSession(5, 'почини кнопку логина')
    expect(rename).toHaveBeenCalledWith(5, 'Почини кнопку логина')
    expect(useProject.getState().chatSessions[0].title).toBe('Почини кнопку логина')
  })

  it('пустое первое сообщение имени не даёт — заголовок остаётся', async () => {
    seed('Новый чат')
    await useProject.getState().autoTitleChatSession(5, '```\ncode only\n```')
    expect(rename).not.toHaveBeenCalled()
    expect(useProject.getState().chatSessions[0].title).toBe('Новый чат')
  })
})
