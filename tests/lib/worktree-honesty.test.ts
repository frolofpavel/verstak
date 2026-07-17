import { describe, it, expect } from 'vitest'
import {
  canIsolateChat,
  isolationBlockedReason,
  isolationBlockedHint,
  fileRevertBlockedReason,
  fileRevertBlockedHint,
} from '../../src/lib/worktree-honesty'
// Реестр берём из main: это источник правды о реальных провайдерах. Тест идёт в Node,
// так что импорт легален — в рантайме renderer этого не делает (правило зон src/).
import { PROVIDERS } from '../../electron/ai/registry'

/**
 * Honesty-срез (ре-ревью 2.0.11-B, находки #1/#3).
 *
 * Проверяем не «строка равна строке», а обещания интерфейса: кнопка не смеет обещать
 * изоляцию там, где правки уйдут в реальный репозиторий, и откат — там, где он откатит
 * чужое вместо своего.
 */

const cli = { transport: 'CLI' as const, supportsTools: false, label: 'Claude Code' }
const api = { transport: 'API' as const, supportsTools: true, label: 'Claude' }
const apiNoTools = { transport: 'API' as const, supportsTools: false, label: 'GigaChat' }

describe('изоляция чата: что интерфейс имеет право обещать', () => {
  // Главный сценарий: Павел работает на Claude Code.
  it('CLI → изоляцию НЕ обещаем (правки ушли бы в реальный проект)', () => {
    expect(canIsolateChat(cli)).toBe(false)
  })

  it('API с тулзами → изоляция реальна', () => {
    expect(canIsolateChat(api)).toBe(true)
    expect(isolationBlockedReason(api)).toBeNull()
    expect(isolationBlockedHint(api)).toBeNull()
  })

  it('API без тулзов → изолировать нечего (файлы агент не пишет)', () => {
    expect(canIsolateChat(apiNoTools)).toBe(false)
  })

  it('причина отказа объясняет ГЛАВНОЕ: правки пойдут в реальный проект', () => {
    const reason = isolationBlockedReason(cli)!
    expect(reason).toMatch(/реальн/i)
    expect(reason).toContain('Claude Code') // человек видит СВОЙ провайдер, а не «CLI»
    expect(reason).toMatch(/API/) // и куда идти за рабочей изоляцией
  })

  it('причина для API-без-тулзов другая и честная (не пугаем реальным проектом)', () => {
    const reason = isolationBlockedReason(apiNoTools)!
    expect(reason).toMatch(/не правит файлы/)
    expect(reason).not.toMatch(/реальн/i)
  })

  it('короткая подпись не пустая и называет провайдера', () => {
    expect(isolationBlockedHint(cli)).toContain('Claude Code')
  })

  // Страж от дрейфа: правило живёт в контракте, а не второй копией в UI.
  it('решение сходится с контрактом провайдеров для ВСЕХ реальных провайдеров', () => {
    for (const p of Object.values(PROVIDERS)) {
      const byUi = canIsolateChat({ transport: p.transport, supportsTools: p.supportsTools, label: p.name })
      const byContract = p.transport === 'API' && p.supportsTools
      expect(byUi, `${p.id}`).toBe(byContract)
    }
  })

  it('ни один CLI-провайдер не получает обещания изоляции', () => {
    for (const p of Object.values(PROVIDERS)) {
      if (p.transport === 'CLI') {
        expect(canIsolateChat({ transport: p.transport, supportsTools: p.supportsTools, label: p.name }), p.id).toBe(false)
      }
    }
  })
})

describe('откат файлов в изолированной сессии', () => {
  // Своё не откатит (правки под путём копии), чужое (параллельный чат) — откатит.
  it('в изоляции откат файлов заблокирован', () => {
    expect(fileRevertBlockedReason(true)).not.toBeNull()
  })

  it('и отправляет к штатному пути — «Отбросить», а не в тупик', () => {
    expect(fileRevertBlockedReason(true)!).toContain('Отбросить')
    expect(fileRevertBlockedHint(true)!).toContain('Отбросить')
  })

  it('вне изоляции откат работает как раньше (легитимный путь не сломан)', () => {
    expect(fileRevertBlockedReason(false)).toBeNull()
    expect(fileRevertBlockedHint(false)).toBeNull()
  })
})
