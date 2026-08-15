import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { decideWhatsNew } from '../../src/lib/whats-new-gate'
import { chooseStartupProject } from '../../src/lib/project-bootstrap'

const src = (rel: string) => readFileSync(join(__dirname, '..', '..', 'src', rel), 'utf8')

/**
 * Враждебное ревью 2.6.4, первые пять минут: §5 (модалка «Обновление
 * установлено» при ПЕРВОЙ установке) и §3 (проект по умолчанию — весь домашний
 * каталог, 5055 файлов, 83 инструмента, запись `.verstak/MEMORY.md` без спроса).
 */
describe('«Обновление установлено» при первой установке (§5)', () => {
  it('первая в жизни установка — модалки НЕТ', () => {
    expect(decideWhatsNew({ current: '2.6.4', last: null, onboardingCompleted: false }))
      .toBe('first-install')
  })

  it('контроль: обновление поверх работавшей версии модалку ПОКАЗЫВАЕТ', () => {
    expect(decideWhatsNew({ current: '2.6.5', last: '2.6.4', onboardingCompleted: true })).toBe('show')
    // Профиль жил до появления ключа last_whats_new_version — это тоже обновление.
    expect(decideWhatsNew({ current: '2.6.5', last: null, onboardingCompleted: true })).toBe('show')
  })

  it('та же версия повторно модалку не показывает', () => {
    expect(decideWhatsNew({ current: '2.6.4', last: '2.6.4', onboardingCompleted: true })).toBe('skip')
    expect(decideWhatsNew({ current: '2.6.3', last: '2.6.4', onboardingCompleted: true })).toBe('skip')
  })

  it('на первой установке версия ЗАПОМИНАЕТСЯ — иначе следующее обновление покажет и её', () => {
    // Решение first-install обязано вести к записи ключа: без неё человек,
    // обновившись с 2.6.4 на 2.6.5, получил бы ноты обеих версий.
    const modal = src('components/WhatsNewModal.tsx')
    expect(modal).toMatch(/decision === 'first-install'[\s\S]{0,240}setKey\(LAST_WHATS_NEW_KEY, current\)/)
  })
})

describe('проект по умолчанию (§3)', () => {
  it('пустой профиль: ничего не открываем — папку выбирает человек', () => {
    expect(chooseStartupProject({ lastPath: null, knownPaths: [] })).toEqual({ kind: 'ask' })
  })

  it('контроль: известные проекты по-прежнему открываются сами', () => {
    expect(chooseStartupProject({ lastPath: 'C:\\work\\shop', knownPaths: ['C:\\work\\shop', 'C:\\work\\site'] }))
      .toEqual({ kind: 'open', path: 'C:\\work\\shop' })
    expect(chooseStartupProject({ lastPath: null, knownPaths: ['C:\\work\\site'] }))
      .toEqual({ kind: 'open', path: 'C:\\work\\site' })
  })

  it('проект прошлой сессии, которого больше нет в списке, не открывается вслепую', () => {
    expect(chooseStartupProject({ lastPath: 'C:\\удалённый', knownPaths: [] })).toEqual({ kind: 'ask' })
  })

  /**
   * Анти-дрейф по ПРОДОВОМУ вхождению: до 16.08 назначение домашнего каталога
   * стояло в двух местах сразу — ProjectRail.tsx (загрузка приложения) и
   * Chat.tsx (первая отправка без проекта). Починка одного места оставила бы
   * второе, и дефект вернулся бы через другую дверь.
   */
  it('ни один экран больше не берёт домашний каталог как проект', () => {
    for (const file of ['components/ProjectRail.tsx', 'components/Chat.tsx']) {
      expect(src(file), file).not.toContain('getHomeDir')
    }
  })

  it('контроль: пин смотрит на реальную форму вызова', () => {
    // Так это было написано в 2.6.4 — пин обязан такую строку ловить.
    expect('const home = await window.api.app.getHomeDir()').toContain('getHomeDir')
  })
})
