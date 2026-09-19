import { describe, it, expect } from 'vitest'
import { computerUseStopCode, describeComputerUseStop } from '../../src/lib/computer-use-stop-message'
import { ru } from '../../src/i18n/ru'
import { en } from '../../src/i18n/en'

const AUTH = 'COMPUTER_USE_AUTHORIZATION_FAILED: '

describe('ранний стоп Computer Use → текст для человека', () => {
  it('вынимает код только из авторизационного стопа', () => {
    expect(computerUseStopCode(`${AUTH}uncertain-reconciliation-required`))
      .toBe('uncertain-reconciliation-required')
    expect(computerUseStopCode('COMPUTER_USE_TRANSPORT_UNSUPPORTED: Computer Use доступен только…'))
      .toBeNull()
    expect(computerUseStopCode('Аккаунт «Личный Max» остывает после лимита')).toBeNull()
    expect(computerUseStopCode(AUTH.trimEnd())).toBeNull()
  })

  it('переводит код блокировки и называет выход из тупика', () => {
    const text = describeComputerUseStop(`${AUTH}uncertain-reconciliation-required`, ru.chat.computerUseStops)
    expect(text).toContain('Я проверил результат')
    expect(text).not.toContain('COMPUTER_USE_AUTHORIZATION_FAILED')
    expect(describeComputerUseStop(`${AUTH}uncertain-reconciliation-required`, en.chat.computerUseStops))
      .toContain('I reviewed the result')
  })

  // Контрольная пара к переводу: неизвестный код и чужое сообщение обязаны
  // пройти насквозь, иначе подмена съела бы настоящую причину стопа.
  it('незнакомый код и не-Computer-Use сообщение отдаёт без изменений', () => {
    expect(describeComputerUseStop(`${AUTH}some-future-code`, ru.chat.computerUseStops))
      .toBe(`${AUTH}some-future-code`)
    expect(describeComputerUseStop('Провайдер недоступен', ru.chat.computerUseStops))
      .toBe('Провайдер недоступен')
  })

  it('обе локали покрывают один и тот же набор кодов', () => {
    expect(Object.keys(en.chat.computerUseStops).sort())
      .toEqual(Object.keys(ru.chat.computerUseStops).sort())
  })
})
