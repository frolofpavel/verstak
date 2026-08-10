import { describe, expect, it } from 'vitest'
import {
  MAX_STRATEGY_NUDGES,
  STAGNATION_TURNS,
  buildStrategyChangeHint,
  callKey,
  createProgressState,
  detectStagnation,
  factKey,
  recordTurn,
  stagnationStopNote,
} from '../../electron/ai/progress'

// V2-4 (agent-runtime-v2.md §4) — предохранитель к автопродолжению бюджета V2-2.
//
// Аудит B4: лестница восстановления в прогоне построена для ПРОВАЙДЕРА, а для
// ЗАДАЧИ рантайм-механизма нет. Вставший агент тихо доедал бюджет — снаружи это
// неотличимо от работы. Правило здесь одно: ход даёт прогресс тогда и только
// тогда, когда породил факт, которого в прогоне ещё не было. Три симптома из
// постановки (повтор вызова · N ходов без нового факта · чтение по кругу) —
// три вида этого одного события, и сетка ниже проверяет каждый ОТДЕЛЬНО.

const call = (name: string, args: unknown, result: unknown) => ({ name, args, result })

describe('factKey — что считается фактом', () => {
  it('тот же вызов с тем же ответом даёт тот же ключ (повтор — не факт)', () => {
    const a = call('read_file', { path: 'a.ts' }, 'export const x = 1')
    const b = call('read_file', { path: 'a.ts' }, 'export const x = 1')
    expect(factKey(a)).toBe(factKey(b))
  })

  it('КОНТРОЛЬ: тот же вызов с ДРУГИМ ответом — новый факт', () => {
    const red = call('run_command', { command: 'npm test' }, 'FAIL 1 test failed')
    const green = call('run_command', { command: 'npm test' }, 'PASS all tests ok')
    expect(factKey(red)).not.toBe(factKey(green))
  })

  it('плавающая длительность в выводе тем же фактом и остаётся', () => {
    // Без нормализации самый частый цикл — повторный прогон тестов — выглядел бы
    // бесконечным прогрессом, и детектор не сработал бы никогда.
    const first = call('run_command', { command: 'npm test' }, 'Duration 1.23s\n2 passed')
    const second = call('run_command', { command: 'npm test' }, 'Duration 4.71s\n2 passed')
    expect(factKey(first)).toBe(factKey(second))
  })

  it('КОНТРОЛЬ: нормализация не съедает содержательную разницу', () => {
    const two = call('run_command', { command: 'npm test' }, 'Duration 1.23s\n2 passed')
    const three = call('run_command', { command: 'npm test' }, 'Duration 1.23s\n3 passed')
    expect(factKey(two)).not.toBe(factKey(three))
  })

  it('ошибка вызова — тоже факт, и повтор той же ошибки новым фактом не является', () => {
    const fail = { name: 'run_command', args: { command: 'nope' }, error: 'command not found' }
    expect(factKey(fail)).toBe(factKey({ ...fail }))
    expect(factKey(fail)).not.toBe(factKey({ name: 'run_command', args: { command: 'nope' }, result: 'ok' }))
  })

  it('callKey различает вызовы по аргументам и не смотрит на ответ', () => {
    expect(callKey(call('read_file', { path: 'a.ts' }, 'v1'))).toBe(callKey(call('read_file', { path: 'a.ts' }, 'v2')))
    expect(callKey(call('read_file', { path: 'a.ts' }, 'v1'))).not.toBe(callKey(call('read_file', { path: 'b.ts' }, 'v1')))
  })
})

describe('recordTurn — прогресс хода', () => {
  it('новый вызов с новым ответом — прогресс, счётчик застоя сброшен', () => {
    const state = createProgressState()
    state.staleTurns = 2
    expect(recordTurn(state, [call('read_file', { path: 'a.ts' }, 'содержимое')]).progressed).toBe(true)
    expect(state.staleTurns).toBe(0)
  })

  it('повтор того же вызова прогрессом не является', () => {
    const state = createProgressState()
    recordTurn(state, [call('read_file', { path: 'a.ts' }, 'одно и то же')])
    const again = recordTurn(state, [call('read_file', { path: 'a.ts' }, 'одно и то же')])
    expect(again.progressed).toBe(false)
    expect(state.staleTurns).toBe(1)
  })

  it('ход без вызовов инструментов прогрессом не считается', () => {
    const state = createProgressState()
    expect(recordTurn(state, []).progressed).toBe(false)
  })

  it('КОНТРОЛЬ: запись с ИЗМЕНЁННЫМ содержимым — прогресс, повторная запись того же — нет', () => {
    const state = createProgressState()
    expect(recordTurn(state, [call('write_file', { path: 'a.ts', content: 'v1' }, 'ok')]).progressed).toBe(true)
    expect(recordTurn(state, [call('write_file', { path: 'a.ts', content: 'v2' }, 'ok')]).progressed).toBe(true)
    expect(recordTurn(state, [call('write_file', { path: 'a.ts', content: 'v2' }, 'ok')]).progressed).toBe(false)
  })
})

describe('detectStagnation — три симптома постановки', () => {
  it('симптом «повтор того же вызова»: STAGNATION_TURNS ходов → stagnant с reason repeat-call', () => {
    const state = createProgressState()
    recordTurn(state, [call('run_command', { command: 'npm test' }, 'FAIL')])
    for (let i = 0; i < STAGNATION_TURNS; i++) {
      recordTurn(state, [call('run_command', { command: 'npm test' }, 'FAIL')])
    }
    const verdict = detectStagnation(state)
    expect(verdict.stagnant).toBe(true)
    expect(verdict.reason).toBe('repeat-call')
  })

  it('симптом «чтение по кругу»: разные файлы, но ничего нового → reread-loop', () => {
    const state = createProgressState()
    // Сначала прочитали три файла (это был прогресс), потом крутим их же.
    for (const path of ['a.ts', 'b.ts', 'c.ts']) recordTurn(state, [call('read_file', { path }, `текст ${path}`)])
    for (const path of ['a.ts', 'b.ts', 'c.ts']) recordTurn(state, [call('read_file', { path }, `текст ${path}`)])
    const verdict = detectStagnation(state)
    expect(verdict.stagnant).toBe(true)
    expect(verdict.reason).toBe('reread-loop')
  })

  it('симптом «N ходов без нового факта»: разные инструменты, ни одного нового ответа', () => {
    const state = createProgressState()
    const turns = [
      [call('list_directory', { path: '.' }, 'a.ts b.ts')],
      [call('run_command', { command: 'git status' }, 'clean')],
      [call('search_project', { query: 'foo' }, 'нет совпадений')],
    ]
    for (const turn of turns) recordTurn(state, turn)      // прогресс: всё впервые
    expect(detectStagnation(state).stagnant).toBe(false)
    for (const turn of turns) recordTurn(state, turn)      // то же самое второй раз
    const verdict = detectStagnation(state)
    expect(verdict.stagnant).toBe(true)
    expect(verdict.reason).toBe('no-new-facts')
  })

  it('КОНТРОЛЬ: работающий агент застоем НЕ объявляется', () => {
    const state = createProgressState()
    for (let i = 0; i < 12; i++) {
      recordTurn(state, [call('read_file', { path: `file-${i}.ts` }, `содержимое ${i}`)])
      expect(detectStagnation(state).stagnant).toBe(false)
    }
  })

  it('КОНТРОЛЬ: застой снимается, как только появился новый факт', () => {
    const state = createProgressState()
    recordTurn(state, [call('run_command', { command: 'npm test' }, 'FAIL')])
    for (let i = 0; i < STAGNATION_TURNS; i++) recordTurn(state, [call('run_command', { command: 'npm test' }, 'FAIL')])
    expect(detectStagnation(state).stagnant).toBe(true)
    recordTurn(state, [call('write_file', { path: 'fix.ts', content: 'исправление' }, 'ok')])
    expect(detectStagnation(state).stagnant).toBe(false)
  })

  it('порог не срабатывает раньше STAGNATION_TURNS', () => {
    const state = createProgressState()
    recordTurn(state, [call('read_file', { path: 'a.ts' }, 'текст')])
    for (let i = 0; i < STAGNATION_TURNS - 1; i++) recordTurn(state, [call('read_file', { path: 'a.ts' }, 'текст')])
    expect(detectStagnation(state).stagnant).toBe(false)
  })
})

describe('тексты для человека и модели', () => {
  it('подсказка называет причину и предлагает СМЕНИТЬ подход, а не повторить', () => {
    const hint = buildStrategyChangeHint('repeat-call', STAGNATION_TURNS)
    expect(hint).toContain('повторяешь')
    expect(hint).toContain('oracle')
    expect(hint).toContain('остановись')
  })

  it('остановка описывает блокер, а не выдаёт работу за сделанную', () => {
    const note = stagnationStopNote('reread-loop', 4)
    expect(note).toContain('остановлена без результата')
    expect(note).toContain('перечитываешь')
    expect(note).not.toContain('готово')
  })

  it('подсказка bounded: один шанс на смену стратегии, дальше остановка', () => {
    expect(MAX_STRATEGY_NUDGES).toBe(1)
    expect(STAGNATION_TURNS).toBeGreaterThanOrEqual(3)
  })
})
