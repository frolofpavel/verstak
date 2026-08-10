// V5 (волна 2.6.0): авто-режим по умолчанию.
//
// ЧТО МЕНЯЕТСЯ. Новый пользователь получает `auto` из коробки — Verstak не
// спрашивает на рутинных правках и командах. Кто режим уже выбирал сам —
// остаётся на своём, каким бы он ни был.
//
// ГЛАВНЫЙ РИСК, РАДИ КОТОРОГО ЗДЕСЬ ЗЕРКАЛЬНАЯ ПАРА. Соблазнительная (и
// неверная) реализация — «сохранённое === старый дефолт, значит человек не
// выбирал». Тогда пользователь, СОЗНАТЕЛЬНО выбравший `ask`, после обновления
// молча получил бы `auto` и лишился подтверждений, ради которых и выбирал.
// Поэтому признак выбора — ФАКТ ЗАПИСИ, и пин ниже это стережёт.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_AGENT_MODE, resolveAgentMode, hasExplicitAgentMode, isAgentModeId,
} from '../../shared/contracts/agent-mode-policy'
import { resolveDecision } from '../../electron/ai/permission-rules'

describe('V5: дефолт агентного режима', () => {
  it('дефолт продукта — auto', () => {
    expect(DEFAULT_AGENT_MODE).toBe('auto')
  })

  it('свежий профиль (значения нет) → auto', () => {
    expect(resolveAgentMode(null)).toBe('auto')
    expect(resolveAgentMode(undefined)).toBe('auto')
    expect(resolveAgentMode('')).toBe('auto')
  })

  it('ЗЕРКАЛО: профиль с явно выбранным ask → ask и после смены дефолта', () => {
    // Тот самый случай, который ломает реализация «сравнить с прежним дефолтом».
    expect(resolveAgentMode('ask'), 'выбравшего ask молча перевели в auto').toBe('ask')
    expect(hasExplicitAgentMode('ask')).toBe(true)
    expect(hasExplicitAgentMode(null)).toBe(false)
  })

  it('любой явный выбор уважается, включая bypass и plan (их V5 не трогает)', () => {
    for (const mode of ['ask', 'accept-edits', 'plan', 'auto', 'bypass'] as const) {
      expect(resolveAgentMode(mode)).toBe(mode)
    }
  })

  it('мусорное значение — это не выбор: дефолт, а не падение', () => {
    expect(resolveAgentMode('yolo')).toBe('auto')
    expect(isAgentModeId('yolo')).toBe(false)
  })

  it('свой fallback (справочный чат) продуктовым дефолтом не перебивается', () => {
    expect(resolveAgentMode(null, 'plan')).toBe('plan')
    expect(resolveAgentMode('yolo', 'plan')).toBe('plan')
  })
})

// Смысл V5 в поведении, а не в строке настройки: рутина обязана ехать без
// вопроса, ответственное действие — спрашивать. Обе половины проверяются на
// НАСТОЯЩЕМ resolveDecision (его V5 не трогает — только читает).
describe('V5: что означает auto на деле', () => {
  it('рутина в auto идёт без вопроса', () => {
    expect(resolveDecision('write_file', { path: 'src/a.ts' }, 'auto', undefined, undefined).decision).toBe('auto-accept')
    expect(resolveDecision('run_command', { command: 'npm test' }, 'auto', undefined, undefined).decision).toBe('auto-accept')
  })

  it('КОНТРОЛЬ: ответственное действие в auto СПРАШИВАЕТ (иначе смена дефолта опасна)', () => {
    // Платёж/отправка/публикация — то, ради чего пауза и строилась. Если этот
    // кейс позеленеет «auto-accept», дефолт auto выпускать нельзя.
    const payment = resolveDecision('connector_query', { id: 'yookassa', op: 'payments.create' }, 'auto', undefined, undefined)
    expect(payment.decision, 'платёж проехал молча в auto').toBe('confirm')
    expect(payment.confirmCause).toBe('responsible-action')

    const send = resolveDecision('connector_query', { id: 'telegram', op: 'send_message' }, 'auto', undefined, undefined)
    expect(send.decision, 'отправка сообщения проехала молча в auto').toBe('confirm')
  })

  it('в ask рутина по-прежнему спрашивает — прежний режим не сломан', () => {
    expect(resolveDecision('run_command', { command: 'npm test' }, 'ask', undefined, undefined).decision).toBe('confirm')
  })

  it('plan остаётся строгим: в нём по-прежнему блок, V5 его не касается', () => {
    expect(resolveDecision('write_file', { path: 'a.ts' }, 'plan', undefined, undefined).decision).toBe('block')
  })
})

// Анти-дрейф. Дефолт обязан жить В ОДНОМ месте: разъехавшись, main и renderer
// показали бы человеку один режим, а работали бы в другом — ровно тот дефект,
// ради которого полярность plan_approval_gate уехала в shared (A3 §2.1).
describe('V5: дефолт не продублирован в main и renderer', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  it('main читает режим через общий контракт, а не сравнивает строку сам', () => {
    const src = read('electron/main.ts')
    expect(src, 'main перестал звать resolveAgentMode — дефолт снова в двух местах').toContain('resolveAgentMode(settings.getSecret(\'agent_mode\'))')
    expect(src, 'в main вернулся собственный фолбэк режима').not.toMatch(/return 'ask' as const/)
  })

  it('renderer берёт дефолт оттуда же', () => {
    const src = read('src/hooks/useAgentMode.ts')
    expect(src).toContain('shared/contracts/agent-mode-policy')
    expect(src).toContain('resolveAgentMode')
  })
})
