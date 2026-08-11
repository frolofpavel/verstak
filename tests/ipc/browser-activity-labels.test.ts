// В2 (живая проверка 11.08): пустые чипы в «Ходе работы» и в ленте активности.
//
// У части браузерных действий не было ветки в summarizeToolCall — сводка
// возвращала null, emitActivity не звался, след не оставался вовсе; а у
// browser_screenshot ветка была, но с ПУСТЫМ detail — чип рендерился кружком
// без текста. Обе формы — одна болезнь: подпись действия не гарантирована.
//
// Пин — ПЕРЕБОРОМ по браузерной группе TOOL_DEFS, не выборочно: новый
// браузерный инструмент без ветки в summarizeToolCall уронит сетку сам, без
// напоминания. Аргументы фикстуры СИНТЕЗИРУЮТСЯ из схемы инструмента
// (parameters.required + тип/enum), а не пишутся руками — по §3.1 фикстура,
// не совпадающая с продовой формой вызова, не защищает ничего.
import { describe, it, expect } from 'vitest'
import { TOOL_DEFS } from '../../electron/ai/tools'
import { summarizeToolCall } from '../../electron/ipc/tool-handlers/shared'

interface SchemaProp { type?: string; enum?: unknown[] }
interface ToolDefLike {
  name: string
  parameters?: { properties?: Record<string, SchemaProp>; required?: string[] }
}

/** Аргументы по схеме самого инструмента: required-поля, значения по типу/enum. */
function argsFromSchema(def: ToolDefLike): Record<string, unknown> {
  const props = def.parameters?.properties ?? {}
  const required = def.parameters?.required ?? []
  const args: Record<string, unknown> = {}
  for (const name of required) {
    const p = props[name] ?? {}
    if (Array.isArray(p.enum) && p.enum.length > 0) args[name] = p.enum[0]
    else if (p.type === 'number') args[name] = 7
    else if (name === 'url') args[name] = 'https://example.com/path'
    else args[name] = 'пример'
  }
  return args
}

const browserGroup = (TOOL_DEFS as ToolDefLike[]).filter(d => d.name.startsWith('browser_'))

describe('В2: подпись есть у КАЖДОГО браузерного инструмента', () => {
  it('контроль состава: браузерная группа собрана, перебор не пустой', () => {
    // Пин «у каждого есть подпись» зелен и тогда, когда фильтр не нашёл ничего.
    // Известный на 11.08 состав — 12 инструментов; меньше — фильтр сломан.
    expect(browserGroup.length).toBeGreaterThanOrEqual(12)
  })

  it.each(browserGroup.map(d => [d.name, d] as const))(
    '%s: сводка непустая даже БЕЗ результата (worst case)',
    (_name, def) => {
      const s = summarizeToolCall(def.name, argsFromSchema(def), undefined)
      expect(s, `summarizeToolCall не знает про ${def.name} — след не оставляется вовсе`).toBeTruthy()
      expect(s!.label.trim(), `пустой label у ${def.name}`).not.toBe('')
      expect(s!.detail.trim(), `пустой detail у ${def.name} — кружок без текста`).not.toBe('')
    }
  )

  it('press_key: в подписи видно КАКАЯ клавиша и что Enter — отправка формы', () => {
    const enter = summarizeToolCall('browser_press_key', { key: 'Enter' }, undefined)
    expect(enter?.detail).toContain('Enter')
    expect(enter?.detail.toLowerCase()).toContain('форм')
    const tab = summarizeToolCall('browser_press_key', { key: 'Tab', n: 3 }, undefined)
    expect(tab?.detail).toContain('Tab')
    expect(tab?.detail).toContain('3')
  })

  it('wait_for: в подписи видно ЧЕГО ждали', () => {
    const s = summarizeToolCall('browser_wait_for', { query: '.search-results' }, undefined)
    expect(s?.detail).toContain('.search-results')
  })

  it('контроль-зеркало: у инструмента вне ведома сводки по-прежнему null', () => {
    // Без этого кейса пин «сводка есть» не отличим от «summarize вернул
    // что-то на любое имя»: перебор обязан уметь падать.
    expect(summarizeToolCall('run_command', { command: 'dir' }, undefined)).toBeNull()
  })
})
