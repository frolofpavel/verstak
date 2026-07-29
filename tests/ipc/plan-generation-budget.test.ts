// ДЕФЕКТ ЖИВОЙ ПРОВЕРКИ (29.07, третий заход): плана снова нет, но теперь причина
// названа самой программой — «модель не уложилась в отведённые шаги». Диагностика,
// добавленная на втором заходе, показала настоящий дефект вместо общего «не вышло».
//
// ПРИЧИНА. Генерация брала общий `MAX_SUB_ITERATIONS = 8`, написанный под узкую
// подзадачу («прочитать пару файлов, применить патч, проверить» — так и сказано в
// его комментарии). Генерация плана начинается с ОСМОТРА проекта, и восьми
// раундов ей не хватает. Тот же класс, что unattended-гейт и требование путей в
// ТЗ: ограничение исходного вызывающего, применённое к новому сценарию.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runSubAgentLoop, MAX_SUB_ITERATIONS } from '../../electron/ai/sub-agent-loop'
import {
  generatePlan,
  __resetPlanGenerationForTests,
  PLAN_GENERATION_MAX_TURNS,
  PLAN_GENERATION_TIME_BUDGET_MS,
} from '../../electron/ipc/plans-generate'
import { EXTRA_REQUIRED_SETTINGS } from '../../electron/ai/plan-generation-provider'
import { __resetPlanForRunForTests } from '../../electron/ai/runner-shared'
import type { ChatProvider } from '../../electron/ai/types'
import type { createPlans } from '../../electron/storage/plans'

const ROOT = process.cwd()

/** Провайдер, который зовёт инструмент КАЖДЫЙ раунд — так цикл упирается в лимит. */
function endlessProvider(rounds: { n: number }): ChatProvider {
  return {
    async *send() {
      rounds.n++
      yield { type: 'tool-call', call: { id: `t${rounds.n}`, name: 'read_file', args: { path: 'x.ts' } } }
    },
  } as unknown as ChatProvider
}

const loopCtx = () => ({
  projectPath: '/p', sendId: -1, runId: 'r', agentMode: 'plan',
  sender: { send: vi.fn() }, recordJournal: () => {},
  tools: { readFile: async () => 'файл' },
} as never)

beforeEach(() => {
  __resetPlanForRunForTests()
  __resetPlanGenerationForTests()
})

describe('бюджет раундов генерации — свой, а не общий', () => {
  it('вызывающий может задать свой бюджет, и цикл его соблюдает', async () => {
    const rounds = { n: 0 }
    const res = await runSubAgentLoop({
      provider: endlessProvider(rounds),
      messages: [{ role: 'user', content: 'план' }],
      allowedToolNames: ['read_file'],
      ctx: loopCtx(),
      signal: new AbortController().signal,
      maxIterations: 3,
    })
    expect(rounds.n, 'заданный бюджет не соблюдён').toBe(3)
    expect(res.exitReason).toBe('max-iterations')
  })

  // КОНТРОЛЬ: без параметра поведение прежнее — узкая подзадача не подорожала.
  it('контроль: без параметра остаётся общий дефолт узкой подзадачи', async () => {
    const rounds = { n: 0 }
    await runSubAgentLoop({
      provider: endlessProvider(rounds),
      messages: [{ role: 'user', content: 'подзадача' }],
      allowedToolNames: ['read_file'],
      ctx: loopCtx(),
      signal: new AbortController().signal,
    })
    expect(rounds.n).toBe(MAX_SUB_ITERATIONS)
  })

  // ГЛАВНЫЙ ПИН КЛАССА ОШИБКИ: если бюджет генерации однажды снова станет общим
  // дефолтом — этот тест обязан упасть, а не промолчать.
  it('бюджет генерации НЕ равен общему дефолту и кратно больше израсходованных 8', () => {
    expect(PLAN_GENERATION_MAX_TURNS).not.toBe(MAX_SUB_ITERATIONS)
    expect(PLAN_GENERATION_MAX_TURNS).toBeGreaterThanOrEqual(MAX_SUB_ITERATIONS * 3)
  })

  it('генерация действительно ПОЛУЧАЕТ свой бюджет — проводка на месте', () => {
    const src = readFileSync(join(ROOT, 'electron/main.ts'), 'utf8')
    expect(src, 'константа объявлена, но прогону не передана').toContain('maxIterations: PLAN_GENERATION_MAX_TURNS')
  })
})

// ВЕРХНЯЯ ГРАНИЦА. Раунды защищают от спирали, но человек у экрана меряет не
// раунды, а минуты. Исход по времени обязан отличаться от отмены человеком:
// иначе «я нажал отмену» и «оно сдалось само» читаются одинаково.
describe('верхняя граница по времени', () => {
  const REQ = () => ({ projectPath: '/p', title: 'Отчёт', taskDescription: 'Собери отчёт по кампаниям за месяц.' })
  const store = () => ({ get: () => null, list: () => [], create: () => ({ id: 1 }) } as never as ReturnType<typeof createPlans>)
  const chooseOk = () => ({ providerId: 'claude' as const, notice: null, error: null })

  afterEach(() => { vi.useRealTimers() })

  it('превышение бюджета времени — свой текст, не «отменена»', async () => {
    vi.useFakeTimers()
    // Прогон, который никогда не заканчивается сам: ждёт только сигнала.
    const runPlanning = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<{ ok: boolean; text: string }>(resolve => {
      signal.addEventListener('abort', () => resolve({ ok: false, text: '' }), { once: true })
    }))

    const pending = generatePlan({ plans: store(), runPlanning, isKnownProject: () => true, choosePlanProvider: chooseOk }, REQ())
    await vi.advanceTimersByTimeAsync(PLAN_GENERATION_TIME_BUDGET_MS + 10)
    const res = await pending

    expect(res.ok).toBe(false)
    expect(res.error ?? '', 'исход по времени выдан за отмену человеком').not.toContain('отменена')
    expect(res.error ?? '').toContain('минут')
    expect(res.error ?? '').toContain('разбейте')
  })

  // КОНТРОЛЬ: отмена человеком по-прежнему говорит про отмену.
  it('контроль: отмена человеком сохраняет свой текст', async () => {
    const { cancelPlanGeneration } = await import('../../electron/ipc/plans-generate')
    const started = vi.fn()
    const runPlanning = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<{ ok: boolean; text: string }>(resolve => {
      started()
      signal.addEventListener('abort', () => resolve({ ok: false, text: '' }), { once: true })
    }))

    const pending = generatePlan({ plans: store(), runPlanning, isKnownProject: () => true, choosePlanProvider: chooseOk }, REQ())
    await vi.waitFor(() => expect(started).toHaveBeenCalled())
    cancelPlanGeneration('/p')
    const res = await pending

    expect(res.error ?? '').toContain('отменена')
  })

  // ПЯТЫЙ ЗАХОД: на одной постановке Gemini укладывается, DeepSeek нет. Причины
  // разной природы — «медленная модель» и «модель тратит раунды впустую» — и
  // лечатся по-разному. Отказ обязан нести ЗАМЕР, иначе выбор константы снова
  // станет угадыванием.
  it('отказ по времени печатает, сколько раундов модель успела пройти', async () => {
    const { explainTimeout } = await import('../../electron/ipc/plans-generate')
    const slow = explainTimeout({ iterations: 3 })
    const spinning = explainTimeout({ iterations: 22 })

    expect(slow).toContain('3 из ' + PLAN_GENERATION_MAX_TURNS)
    expect(spinning).toContain('22 из ' + PLAN_GENERATION_MAX_TURNS)
    expect(slow, 'два разных случая дают одинаковый текст').not.toBe(spinning)
  })

  it('замера нет — текст остаётся связным, без «undefined»', async () => {
    const { explainTimeout } = await import('../../electron/ipc/plans-generate')
    const t = explainTimeout({})
    expect(t).not.toContain('undefined')
    expect(t).toContain('минут')
  })

  it('раунды считаются по НАЧАТЫМ, оборванный до модели прогон даёт ноль', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const res = await runSubAgentLoop({
      provider: endlessProvider({ n: 0 }),
      messages: [{ role: 'user', content: 'план' }],
      allowedToolNames: ['read_file'],
      ctx: loopCtx(),
      signal: aborted.signal,
    })
    expect(res.iterations, 'прогон, не дошедший до модели, отчитался о работе').toBe(0)
  })

  it('пройденные раунды совпадают с числом обращений к модели', async () => {
    const rounds = { n: 0 }
    const res = await runSubAgentLoop({
      provider: endlessProvider(rounds),
      messages: [{ role: 'user', content: 'план' }],
      allowedToolNames: ['read_file'],
      ctx: loopCtx(),
      signal: new AbortController().signal,
      maxIterations: 4,
    })
    expect(res.iterations).toBe(rounds.n)
  })

  it('бюджет времени соразмерен человеческому ожиданию, а не бесконечности', () => {
    expect(PLAN_GENERATION_TIME_BUDGET_MS).toBeGreaterThanOrEqual(60_000)
    expect(PLAN_GENERATION_TIME_BUDGET_MS).toBeLessThanOrEqual(300_000)
  })
})

// «ЗАДАЧА НЕ ПРО ЭТОТ ПРОЕКТ» — случай реальный (человек держит открытым один
// проект, спрашивает про другой). Автоматически отличить его нельзя без
// угадывания, поэтому в коде эвристики НЕТ. Вместо неё — прямое разрешение
// остановиться, адресованное единственному, кто уже видел содержимое проекта.
describe('постановка не про этот проект: модель может сказать это сразу', () => {
  it('в промпте назван проект и разрешено остановиться, а не искать до упора', async () => {
    const { buildGenerationPrompt } = await import('../../electron/ipc/plans-generate')
    const p = buildGenerationPrompt({
      projectPath: 'C:/Users/Pavel/Downloads',
      title: 'Долгие тесты',
      taskDescription: 'Проверь, какие тесты в проекте самые долгие.',
    })
    expect(p, 'модель не знает, про какой проект её спрашивают').toContain('C:/Users/Pavel/Downloads')
    expect(p).toContain('не продолжай поиск')
    expect(p, 'человеку не подскажут самую частую причину').toContain('не тот проект')
  })

  it('постановка человека при этом не потерялась', async () => {
    const { buildGenerationPrompt } = await import('../../electron/ipc/plans-generate')
    const p = buildGenerationPrompt({ projectPath: '/p', title: 'Т', taskDescription: 'Собери отчёт по Ozon.' })
    expect(p).toContain('Собери отчёт по Ozon.')
  })
})

// ДЕФЕКТ 2, ПРОВЕРКА ФАКТОМ (а не предположением). Ключи обязательных полей
// должны быть ТЕМИ ЖЕ, что читает код, который эти поля потребляет. Опечатка
// вроде `custom_openai_base_url` дала бы «всегда настроен» и вернула бы дефект,
// причём молча: юнит-тест с собственным списком ключей остался бы зелёным.
describe('готовность провайдера: имена полей совпадают с теми, что читает код', () => {
  const consumer = readFileSync(join(ROOT, 'electron/ipc/ai-send/provider-options.ts'), 'utf8')

  for (const [providerId, keys] of Object.entries(EXTRA_REQUIRED_SETTINGS)) {
    for (const key of keys ?? []) {
      it(`${providerId}: «${key}» читается и потребителем`, () => {
        expect(consumer, `ключ ${key} не встречается в provider-options.ts`).toContain(`'${key}'`)
      })
    }
  }

  it('контроль: выдуманного ключа в потребителе нет', () => {
    expect(consumer).not.toContain("'custom_openai_base_url'")
  })
})
