// `delegate_parallel` отдавал ОБРЫВ как успех — единственное найденное место, где
// система говорит пользователю неправду (29.07).
//
// Три слоя одного дефекта, и каждый проверяется отдельно, потому что чинятся они
// в разных местах:
//   Б1 — обрыв под-агента (время / потолок раундов) с непустым частичным текстом
//        уходил родителю по ветке успеха: половина ответа считалась целым;
//   Б2 — ноль выживших задач возвращался БЕЗ поля `error`, поэтому модель видела
//        обычный успешный tool_result, а процедурная память писала вызов удачным;
//   Б3 — шапка батча эмитилась ДО запуска со `status:'ok'` и больше никогда не
//        переписывалась: «выполнено» на экране при упавших под-агентах.
//
// Тестов на этот путь не было вовсе (единственный вызов жил в выключенном
// live-смоуке и описывал успешный сценарий), поэтому заготовка построена с нуля.
// Мокается РОВНО ОДНО — цикл под-агента: всё остальное (очередь, провайдер,
// набор инструментов, сборка результата) работает по-настоящему.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const loopResults = new Map<string, { text: string; exitReason: string; error?: string }>()

vi.mock('../../electron/ai/sub-agent-loop', () => ({
  MAX_SUB_ITERATIONS: 8,
  runSubAgentLoop: vi.fn(async (params: { messages: Array<{ role: string; content: string }> }) => {
    const prompt = params.messages[params.messages.length - 1]?.content ?? ''
    const preset = loopResults.get(prompt)
    if (!preset) return { text: 'ok', toolCallCount: 1, iterations: 1, exitReason: 'completed' }
    return { ...preset, toolCallCount: 1, iterations: 1 }
  }),
}))

const { delegateParallelHandler } = await import('../../electron/ipc/tool-handlers/delegation/parallel')

interface SentEvent { type: string; callId?: string; name?: string; status?: string; detail?: string }

let sent: SentEvent[]

function ctxOf() {
  sent = []
  return {
    projectPath: process.cwd(),
    sendId: 1,
    signal: new AbortController().signal,
    tools: {},
    currentProviderId: 'gemini-cli',
    delegationDepth: 0,
    recordJournal: () => {},
    getSecretForDelegate: () => null,
    sender: { send: (_ch: string, payload: { event: SentEvent }) => { sent.push(payload.event) } },
  } as never
}

const callWith = (prompts: string[]) => ({
  id: 'batch-1',
  name: 'delegate_parallel',
  args: { tasks: prompts.map((p, i) => ({ id: `t${i + 1}`, prompt: p })) },
}) as never

/** Итоговая шапка батча — последнее событие tool-activity этого вызова. */
const batchHeader = () => [...sent].reverse().find(e => e.type === 'tool-activity' && e.callId === 'batch-1')

beforeEach(() => { loopResults.clear() })

// ─────────────────────────────────────────────────────────────────────────────
// Б1. ОБРЫВ — НЕ ЗАВЕРШЕНИЕ.
// ─────────────────────────────────────────────────────────────────────────────
describe('Б1: обрыв под-агента виден в результате', () => {
  it('остановка по времени помечает результат неполным и называет причину', async () => {
    loopResults.set('посчитай', { text: 'начал считать, дошёл до половины', exitReason: 'aborted' })

    const res = await delegateParallelHandler.handle(callWith(['посчитай']), ctxOf()) as { result: string }

    expect(res.result, 'обрыв по времени отдан как готовый ответ').toContain('ЧАСТИЧНЫЙ РЕЗУЛЬТАТ')
    expect(res.result, 'причина не названа — время и раунды лечатся по-разному').toContain('по времени')
    expect(res.result, 'частичный текст потерян').toContain('дошёл до половины')
  })

  it('упор в потолок раундов помечается ДРУГОЙ причиной', async () => {
    loopResults.set('покопай', { text: 'частичный вывод', exitReason: 'max-iterations' })

    const res = await delegateParallelHandler.handle(callWith(['покопай']), ctxOf()) as { result: string }

    expect(res.result).toContain('ЧАСТИЧНЫЙ РЕЗУЛЬТАТ')
    expect(res.result).toContain('раундов')
    expect(res.result, 'две разные причины слиты в одну').not.toContain('по времени')
  })

  // КОНТРОЛЬ: нормальное завершение отметки НЕ получает — иначе главный агент
  // перестанет доверять пометке вовсе.
  it('контроль: завершённая задача идёт без пометки о неполноте', async () => {
    loopResults.set('готово', { text: 'полный ответ', exitReason: 'completed' })

    const res = await delegateParallelHandler.handle(callWith(['готово']), ctxOf()) as { result: string }

    expect(res.result).toContain('полный ответ')
    expect(res.result).not.toContain('ЧАСТИЧНЫЙ РЕЗУЛЬТАТ')
  })

  it('счётчик неполных виден в шапке результата', async () => {
    loopResults.set('a', { text: 'кусок', exitReason: 'aborted' })
    loopResults.set('b', { text: 'целое', exitReason: 'completed' })

    const res = await delegateParallelHandler.handle(callWith(['a', 'b']), ctxOf()) as { result: string }

    expect(res.result).toContain('Выполнено 2 из 2')
    expect(res.result).toContain('с неполным ответом: 1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Б2. ПРОВАЛ ВСЕХ ЗАДАЧ — ЭТО ОШИБКА ВЫЗОВА, А НЕ УСПЕХ С КРЕСТИКАМИ ВНУТРИ.
// ─────────────────────────────────────────────────────────────────────────────
describe('Б2: провал батча возвращается ошибкой', () => {
  it('ни одной выжившей задачи → поле error взведено', async () => {
    loopResults.set('раз', { text: '', exitReason: 'error', error: 'провайдер лёг' })
    loopResults.set('два', { text: '', exitReason: 'error', error: 'провайдер лёг' })

    const res = await delegateParallelHandler.handle(callWith(['раз', 'два']), ctxOf()) as { result: string; error?: string }

    expect(res.error, 'ноль успешных вернулся как успешный tool_result').toBeTruthy()
    expect(res.error).toContain('ни одна')
    expect(res.result, 'счётчик обязан быть виден и в тексте').toContain('Выполнено 0 из 2')
  })

  // КОНТРОЛЬ ГРАНИЦЫ: частичный провал для параллельного запуска — законный
  // исход, ошибкой он НЕ становится, но счётчик обязан быть в тексте.
  it('частичный провал: error НЕ взводится, счётчик в тексте есть', async () => {
    loopResults.set('живая', { text: 'результат', exitReason: 'completed' })
    loopResults.set('мёртвая', { text: '', exitReason: 'error', error: 'упала' })

    const res = await delegateParallelHandler.handle(callWith(['живая', 'мёртвая']), ctxOf()) as { result: string; error?: string }

    expect(res.error, 'законный частичный исход объявлен провалом вызова').toBeUndefined()
    expect(res.result).toContain('Выполнено 1 из 2')
    expect(res.result).toContain('❌')
  })

  it('контроль: полный успех — ни ошибки, ни крестиков', async () => {
    loopResults.set('одна', { text: 'готово', exitReason: 'completed' })

    const res = await delegateParallelHandler.handle(callWith(['одна']), ctxOf()) as { result: string; error?: string }

    expect(res.error).toBeUndefined()
    expect(res.result).toContain('Выполнено 1 из 1')
    expect(res.result).not.toContain('❌')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Б3. ШАПКА НА ЭКРАНЕ ГОВОРИТ ПРАВДУ.
// ─────────────────────────────────────────────────────────────────────────────
describe('Б3: шапка батча переписывается фактом', () => {
  it('упавшая задача — шапка перестаёт быть «ok»', async () => {
    loopResults.set('живая', { text: 'результат', exitReason: 'completed' })
    loopResults.set('мёртвая', { text: '', exitReason: 'error', error: 'упала' })

    await delegateParallelHandler.handle(callWith(['живая', 'мёртвая']), ctxOf())

    const header = batchHeader()
    expect(header, 'итоговая шапка не отправлена вовсе').toBeTruthy()
    expect(header!.status, '«выполнено» на экране при упавшем под-агенте').toBe('error')
    expect(header!.detail).toContain('1/2')
  })

  it('обрыв по времени тоже снимает «ok» с шапки', async () => {
    loopResults.set('долгая', { text: 'кусок', exitReason: 'aborted' })

    await delegateParallelHandler.handle(callWith(['долгая']), ctxOf())

    expect(batchHeader()!.status).toBe('error')
    expect(batchHeader()!.detail).toContain('неполных: 1')
  })

  // КОНТРОЛЬ: при честном полном успехе шапка обязана остаться «ok» — иначе
  // «правдивая» шапка стала бы просто всегда красной.
  it('контроль: всё выполнено — шапка «ok»', async () => {
    loopResults.set('одна', { text: 'готово', exitReason: 'completed' })

    await delegateParallelHandler.handle(callWith(['одна']), ctxOf())

    expect(batchHeader()!.status).toBe('ok')
    expect(batchHeader()!.detail).toContain('1/1')
  })

  // Ключ карточки — `tool-<callId>-<name>`: событие с тем же callId и именем
  // ОБНОВЛЯЕТ карточку, а не заводит вторую. Если ключ разъедется, на экране
  // появится дубль вместо исправленной шапки.
  it('итоговая шапка адресована той же карточке, что стартовая', async () => {
    loopResults.set('одна', { text: 'готово', exitReason: 'completed' })

    await delegateParallelHandler.handle(callWith(['одна']), ctxOf())

    const headers = sent.filter(e => e.type === 'tool-activity' && e.callId === 'batch-1')
    expect(headers.length, 'ожидались ровно стартовая и итоговая').toBe(2)
    expect(headers[0].name).toBe(headers[1].name)
    expect(headers[0].callId).toBe(headers[1].callId)
  })
})
