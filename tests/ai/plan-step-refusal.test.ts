// §2.4 A3 · отказ человека виден в плане, а не выдаётся за выполненную работу.
//
// ЧТО ВЫЯСНИЛОСЬ ПРИ РАЗВЕДКЕ, И ЭТО ХУЖЕ, ЧЕМ ОПИСАНО В ТЗ. ТЗ говорит «статус
// не ставит ни одна строка кода». На пайплайн-оси это уже неверно:
// `outcome.ts:187-193` пишет `blocked → 'skipped'` с 29.07. А на ЧАТ-оси статус
// ставится, но ЛОЖНЫЙ: `Chat.tsx` на событии `done` помечает шаг `'done'`, на
// `error` — `'failed'`, третьего исхода нет. Отказ же человека завершает прогон
// ШТАТНО: инструмент возвращает «User rejected» обычным tool-результатом, модель
// это видит и заканчивает ход — приходит `done`. То есть шаг, который человек
// ЗАПРЕТИЛ, отмечался ВЫПОЛНЕННЫМ. Молчание было бы честнее записи-неправды.
//
// ПОЧЕМУ `'skipped'`, А НЕ НОВОЕ `'blocked'`: ровно этот исход уже кладётся как
// `'skipped'` на пайплайн-оси (комментарий там: «работа не сделана, но и не
// провалена — остальные шаги идут дальше»). Две оси, пишущие РАЗНЫЕ статусы для
// одного исхода, — заготовка будущего дрейфа, а его сегодня чинили дважды.
// Если в «Планах» нужно слово «заблокирован» — это подпись в UI, а не третье
// значение в данных.
//
// Признак рождается там же, где собираются прочие факты хода
// (`collectToolTurnOutcome`), и по единому тексту отказа: все семь хендлеров
// возвращают ровно `'User rejected'` (command, connectors, file-ops, files, mcp,
// process, browser).
import { describe, it, expect } from 'vitest'
import { collectToolTurnOutcome } from '../../electron/ai/runner-tool-outcome'
import type { ToolCall, ToolResult } from '../../electron/ai/types'

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: 'c1', name, args })
const ok = (name: string): ToolResult => ({ id: 'c1', name, result: 'ok' })
const rejected = (name: string): ToolResult => ({ id: 'c1', name, result: '', error: 'User rejected' })
const failed = (name: string, error: string): ToolResult => ({ id: 'c1', name, result: '', error })

function collect(pairs: Array<[ToolCall, ToolResult]>) {
  return collectToolTurnOutcome({
    toolCalls: pairs.map(p => p[0]),
    toolResults: pairs.map(p => p[1]),
    filesTouched: new Set<string>(),
    commandsRun: [],
    sessionChanges: [],
    executedChecks: new Map<string, number>(),
  })
}

describe('§2.4 · ход помнит, что человек отказал', () => {
  // ОБЯЗАТЕЛЬНЫЙ: без этого признака renderer на `done` не отличит отказ от успеха.
  it('отказ от команды отмечается в итоге хода', () => {
    const outcome = collect([[call('run_command', { command: 'git push origin main' }), rejected('run_command')]])

    expect(outcome.userRejected, 'отказ человека потерян — шаг запишется выполненным').toBe(true)
  })

  it('отказ узнаётся у любого инструмента, который спрашивает', () => {
    for (const name of ['run_command', 'connector_query', 'write_file', 'apply_patch', 'browser_click', 'edit_spreadsheet']) {
      expect(collect([[call(name), rejected(name)]]).userRejected, name).toBe(true)
    }
  })

  it('отказ в одном вызове помечает весь ход, даже если рядом были успешные', () => {
    const outcome = collect([
      [call('read_file', { path: 'a.ts' }), ok('read_file')],
      [call('run_command', { command: 'npm publish' }), rejected('run_command')],
    ])

    expect(outcome.userRejected).toBe(true)
  })

  // КОНТРОЛЬ, без которого пин был бы декоративен: обычная ошибка — НЕ отказ.
  // Иначе любой сбой инструмента превращал бы шаг в «пропущен», и провал
  // маскировался бы под решение человека.
  it('контроль: сбой инструмента отказом НЕ считается', () => {
    for (const err of ['ENOENT: no such file', 'Blocked by safety policy: denylist', 'timeout']) {
      expect(collect([[call('run_command'), failed('run_command', err)]]).userRejected, err).toBe(false)
    }
  })

  it('контроль: успешный ход отказа не содержит', () => {
    const outcome = collect([[call('read_file', { path: 'a.ts' }), ok('read_file')]])
    expect(outcome.userRejected).toBe(false)
  })

  // КОНТРОЛЬ: прочие факты хода не сломаны появлением нового признака.
  it('контроль: остальной учёт хода не изменился', () => {
    const outcome = collect([
      [call('attest_verification'), ok('attest_verification')],
      [call('run_command', { command: 'npm test' }), ok('run_command')],
    ])

    expect(outcome.attested, 'учёт attest сломан').toBe(true)
    expect(outcome.userRejected).toBe(false)
  })
})
