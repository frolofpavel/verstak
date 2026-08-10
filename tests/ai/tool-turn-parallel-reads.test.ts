// V2 ось C (волна 2.6.0): читающие инструменты идут пачкой, пишущие — строго
// последовательно.
//
// ЧТО ЗДЕСЬ ВАЖНО ЗНАТЬ. Постановка описывала ось C как «вызовы исполняются
// последовательно (for i < toolCalls.length в runner-api.ts)» — и это оказалось
// НЕВЕРНО: цитируемый цикл в runner-api.ts обрабатывает уже готовые РЕЗУЛЬТАТЫ,
// а исполнение живёт в executeHandlers (runner-tool-turn.ts), где parallel-read
// стартуют конкурентно с 2.1.x. То есть ось C была построена до постановки, но
// НЕ ЗАСТЕРЕЖЕНА пином: поведение держалось на честном слове, и любая правка
// диспетчера могла молча вернуть последовательность (класс «зелёные тесты ≠
// доказанная функция»). Здесь оно закреплено.
//
// Зеркальная пара обязательна (§3.1): рядом с «читающие перекрываются» стоит
// «пишущие НЕ перекрываются» — иначе пин зелен и в мире, где параллельно всё.
import { describe, it, expect } from 'vitest'
import { dispatchToolTurn } from '../../electron/ai/runner-tool-turn'
import type { ToolContext, ToolHandler } from '../../electron/ipc/tool-handlers/shared'
import type { ToolCall } from '../../electron/ai/types'

/** Хендлер, который держится DELAY мс и записывает свои старт/финиш. */
function tracked(mode: ToolHandler['mode'], log: string[], delayMs = 40): ToolHandler {
  return {
    mode,
    async handle(call) {
      log.push(`start:${call.id}`)
      await new Promise(r => setTimeout(r, delayMs))
      log.push(`end:${call.id}`)
      return { id: call.id, name: call.name, result: 'ok' }
    },
  }
}

const ctx = { projectPath: '/p', allowedToolNames: null } as unknown as ToolContext
const calls = (n: number, name: string): ToolCall[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, name, args: {} }))

/** Перекрываются ли исполнения: хоть один старт раньше чужого финиша. */
function overlapped(log: string[]): boolean {
  const firstEnd = log.findIndex(e => e.startsWith('end:'))
  const startsBeforeFirstEnd = log.slice(0, firstEnd).filter(e => e.startsWith('start:')).length
  return startsBeforeFirstEnd > 1
}

describe('V2 ось C: читающие инструменты исполняются пачкой', () => {
  it('три parallel-read стартуют, не дожидаясь друг друга', async () => {
    const log: string[] = []
    const started = Date.now()

    const results = await dispatchToolTurn({
      toolCalls: calls(3, 'read_file'),
      context: ctx,
      hooks: null,
      addContext: () => {},
      resolveHandler: () => tracked('parallel-read', log),
    })

    expect(results.map(r => r.result)).toEqual(['ok', 'ok', 'ok'])
    expect(overlapped(log), 'читающие вызовы шли друг за другом — пачки нет').toBe(true)
    // Три по 40 мс параллельно ≈ 40 мс, последовательно ≈ 120 мс.
    expect(Date.now() - started).toBeLessThan(110)
  })

  it('КОНТРОЛЬ: два sequential НЕ перекрываются — порядок сохранён', async () => {
    const log: string[] = []

    await dispatchToolTurn({
      toolCalls: calls(2, 'run_command'),
      context: ctx,
      hooks: null,
      addContext: () => {},
      resolveHandler: () => tracked('sequential', log),
    })

    expect(overlapped(log), 'пишущие/командные пошли параллельно — общий стейт и гейты в опасности').toBe(false)
    expect(log).toEqual(['start:c1', 'end:c1', 'start:c2', 'end:c2'])
  })

  it('смешанный ход: результаты возвращаются В ПОРЯДКЕ ВЫЗОВОВ, а не завершения', async () => {
    // Порядок результатов — часть контракта: модель сопоставляет их с вызовами по
    // позиции. Параллельность не имеет права его перемешать.
    const log: string[] = []
    const mixed: ToolCall[] = [
      { id: 'r1', name: 'read_file', args: {} },
      { id: 's1', name: 'run_command', args: {} },
      { id: 'r2', name: 'read_file', args: {} },
    ]

    const results = await dispatchToolTurn({
      toolCalls: mixed,
      context: ctx,
      hooks: null,
      addContext: () => {},
      resolveHandler: (name) => tracked(name === 'read_file' ? 'parallel-read' : 'sequential', log),
    })

    expect(results.map(r => r.id)).toEqual(['r1', 's1', 'r2'])
  })
})
