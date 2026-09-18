import { describe, expect, it } from 'vitest'
import {
  chooseAutomaticTarget,
  parseAutomaticComputerUseRequest,
  type AutomaticTargetCandidate,
} from '../../../electron/ai/computer/automatic-target'

const candidate = (
  id: string,
  processName: string,
  title: string,
  foreground = false,
): AutomaticTargetCandidate => ({
  candidateId: id,
  processName,
  title,
  foreground,
  visible: true,
  bounds: { left: 10, top: 10, width: 800, height: 600 },
  blocked: false,
})

describe('Computer Use automatic target intent', () => {
  it('recognizes an ordinary Notepad task without a slash command', () => {
    expect(parseAutomaticComputerUseRequest('Открой Блокнот и напиши: Тест Verstak Computer Use'))
      .toEqual({
        targetApp: 'notepad',
        sourceApp: null,
        openTargetIfMissing: true,
        allowedActions: ['observe', 'wait_for', 'type'],
      })
  })

  it('recognizes an ordinary Calculator task and grants only the actions needed for UIA buttons', () => {
    expect(parseAutomaticComputerUseRequest('Открой калькулятор и посчитай 125 × 47.'))
      .toEqual({
        targetApp: 'calculator',
        sourceApp: null,
        openTargetIfMissing: true,
        allowedActions: ['observe', 'wait_for', 'click'],
      })
  })

  it('recognizes a browser-to-Notepad transfer as read source plus exact desktop target', () => {
    expect(parseAutomaticComputerUseRequest('Возьми текст из открытой страницы браузера и вставь его в Блокнот.'))
      .toEqual({
        targetApp: 'notepad',
        sourceApp: 'browser',
        openTargetIfMissing: true,
        allowedActions: ['observe', 'wait_for', 'type'],
      })
  })

  it('does not turn an informational conversation into desktop authority', () => {
    expect(parseAutomaticComputerUseRequest('Расскажи, как устроен Блокнот Windows')).toBeNull()
  })

  it.each([
    'Не открывай Блокнот и не пиши туда ничего',
    'Открой Блокнот и напиши тест, но сначала спроси меня',
    'Открой калькулятор и посчитай 125 × 47 только после моего подтверждения',
  ])('does not grant desktop authority for a denied or deferred command: %s', (text) => {
    expect(parseAutomaticComputerUseRequest(text)).toBeNull()
  })
})

describe('Computer Use automatic target selection', () => {
  it('selects the single safe matching app', () => {
    const result = chooseAutomaticTarget('notepad', [
      candidate('calc', 'CalculatorApp.exe', 'Калькулятор'),
      candidate('note', 'notepad.exe', 'Безымянный — Блокнот'),
    ])
    expect(result).toEqual({ kind: 'selected', candidateId: 'note' })
  })

  it('uses foreground as a deterministic tie-breaker for the same app', () => {
    const result = chooseAutomaticTarget('notepad', [
      candidate('old', 'notepad.exe', 'Старый файл — Блокнот'),
      candidate('active', 'notepad.exe', 'Новый файл — Блокнот', true),
    ])
    expect(result).toEqual({ kind: 'selected', candidateId: 'active' })
  })

  it('asks only when equal candidates cannot be selected safely', () => {
    const result = chooseAutomaticTarget('notepad', [
      candidate('a', 'notepad.exe', 'A — Блокнот'),
      candidate('b', 'notepad.exe', 'B — Блокнот'),
    ])
    expect(result).toEqual({ kind: 'ambiguous', candidates: ['a', 'b'] })
  })

  it('requests an allowlisted launch when the target is absent', () => {
    expect(chooseAutomaticTarget('calculator', [candidate('note', 'notepad.exe', 'Блокнот')]))
      .toEqual({ kind: 'missing' })
  })
})
