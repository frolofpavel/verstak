// Врезка доверия в гейт разрешений.
//
// Два обязательства. Первое: БЕЗ уровня доверия гейт обязан вести себя ровно как
// прежде — иначе слой, задуманный как надстройка, молча переписал бы поведение
// всех сегодняшних вызовов. Второе: доверие не отменяет ничего из того, что уже
// защищено, — ни deny-правила, ни plan-режима, ни паузы перед ответственным
// действием. Порядок гейта: deny → plan-block → ответственное → ask → allow → режим.
import { describe, it, expect } from 'vitest'
import { resolveDecision } from '../../electron/ai/permission-rules'
import type { AgentMode } from '../../electron/ai/mode-policy'
import { TRUST_LEVELS } from '../../shared/contracts/capability'

const MODES: AgentMode[] = ['ask', 'accept-edits', 'plan', 'auto', 'bypass']

/** Набор вызовов, покрывающий разные ветки гейта. */
const CALLS: Array<[string, Record<string, unknown>]> = [
  ['read_file', { path: 'src/index.ts' }],
  ['write_file', { path: 'src/index.ts', content: 'x' }],
  ['run_command', { command: 'npm run type' }],
  ['connector_query', { id: 'telegram', action: 'send_message' }],
]

describe('без доверия гейт ведёт себя ровно как прежде', () => {
  it('результат с undefined совпадает с результатом без параметра вовсе', () => {
    for (const mode of MODES) {
      for (const [name, args] of CALLS) {
        const withoutParam = resolveDecision(name, args, mode, undefined, undefined)
        const withUndefined = resolveDecision(name, args, mode, undefined, undefined, undefined)
        expect(withUndefined, `${mode}/${name}`).toEqual(withoutParam)
      }
    }
  })
})

describe('доверие не отменяет существующих защит', () => {
  it('plan-режим остаётся строгим при любом уровне', () => {
    for (const trust of TRUST_LEVELS) {
      expect(resolveDecision('write_file', { path: 'a.ts' }, 'plan', undefined, undefined, trust).decision)
        .toBe('block')
    }
  })

  // Пауза перед ответственным действием стоит выше режима и правил. Доверие —
  // тем более: наивысший уровень не имеет права её снять.
  it('ответственное действие спрашивают даже при наивысшем доверии', () => {
    const r = resolveDecision('connector_query', { id: 'telegram', action: 'send_message' }, 'auto', undefined, undefined, 'T4')
    expect(r.decision).toBe('confirm')
    expect(r.confirmCause).toBe('responsible-action')
  })

  it('низкое доверие ужесточает ответственное действие до запрета, а не ослабляет', () => {
    const r = resolveDecision('connector_query', { id: 'telegram', action: 'send_message' }, 'auto', undefined, undefined, 'T0')
    expect(r.decision).toBe('block')
  })
})

describe('доверие ужесточает рутину режима', () => {
  it('на полу доверия авто-режим перестаёт принимать правки сам', () => {
    const free = resolveDecision('write_file', { path: 'a.ts' }, 'auto', undefined, undefined)
    expect(free.decision).toBe('auto-accept')

    const governed = resolveDecision('write_file', { path: 'a.ts' }, 'auto', undefined, undefined, 'T1')
    expect(governed.decision).toBe('confirm')
    // Причина обязана называться своим именем: потребитель, снимающий модалку по
    // причине 'mode', не должен снять её здесь.
    expect(governed.confirmCause).toBe('trust')
  })

  // Контроль: без него пины выше зелены и у врезки, которая ужесточает ВСЁ и
  // всегда, то есть просто ломает продукт.
  it('контроль: при высоком доверии авто-режим работает как прежде', () => {
    const free = resolveDecision('write_file', { path: 'a.ts' }, 'auto', undefined, undefined)
    const governed = resolveDecision('write_file', { path: 'a.ts' }, 'auto', undefined, undefined, 'T3')
    expect(governed).toEqual(free)
  })

  it('чтение остаётся чтением: доверие не мешает безопасным вызовам', () => {
    for (const trust of ['T1', 'T2', 'T3', 'T4'] as const) {
      expect(resolveDecision('read_file', { path: 'a.ts' }, 'auto', undefined, undefined, trust).decision)
        .toBe('auto-accept')
    }
  })
})

describe('пауза перед ответственным действием не ослабляется НИКОГДА', () => {
  // Самый важный пин пакета: врезка прошла по ветке, которую регламент запрещает
  // ослаблять под любой формулировкой. Проверяем перебором, а не примером.
  const RESPONSIBLE: Array<[string, Record<string, unknown>]> = [
    ['connector_query', { id: 'telegram', action: 'send_message' }],
    // id и операции — РЕАЛЬНЫЕ из responsible-action.ts. Здесь сначала стояло
    // выдуманное `yandex-direct/update_campaign`: коннектор Директа read-only,
    // такой операции нет вовсе, и пин молча стерёг несуществующий вход — ровно
    // тот отказ, о котором CLAUDE.md §3.1. Поймано перебором, исправлено фактом.
    ['connector_query', { id: 'yookassa', action: 'refund' }],
    ['connector_query', { id: 'ssh', op: 'run_remote', command: 'ls' }],
    ['connector_query', { id: 'http', method: 'DELETE', url: 'https://example.com/x' }],
    ['run_command', { command: 'rm -rf build' }],
  ]

  it('ни один уровень доверия не превращает ответственное действие в автоприём', () => {
    for (const trust of TRUST_LEVELS) {
      for (const mode of MODES) {
        if (mode === 'bypass') continue // единственное законное исключение, объявлено в гейте
        for (const [name, args] of RESPONSIBLE) {
          const r = resolveDecision(name, args, mode, { commands: true, edits: true }, undefined, trust)
          expect(r.decision, `${trust}/${mode}/${name}`).not.toBe('auto-accept')
        }
      }
    }
  })

  it('решение с доверием никогда не мягче решения без него', () => {
    const strictness = { 'auto-accept': 0, confirm: 1, block: 2 } as const
    for (const trust of TRUST_LEVELS) {
      for (const mode of MODES) {
        for (const [name, args] of [...CALLS, ...RESPONSIBLE]) {
          const without = resolveDecision(name, args, mode, undefined, undefined)
          const governed = resolveDecision(name, args, mode, undefined, undefined, trust)
          expect(
            strictness[governed.decision],
            `${trust}/${mode}/${name}: ${without.decision} -> ${governed.decision}`
          ).toBeGreaterThanOrEqual(strictness[without.decision])
        }
      }
    }
  })
})
