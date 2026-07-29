// Пакет VSK-PLAN-GEN-A2, §5 «Ошибки и защита от дублей» — главное содержание.
//
// Правило дня, применённое здесь буквально: если механизм должен ЧТО-ТО
// ЗАПРЕТИТЬ, тест обязан доказать, что вызов НЕ ПРОШЁЛ, а не что в тексте есть
// предупреждение. Поэтому проверяется состояние БД и факт запуска прогона, а не
// формулировки: сколько строк в `plans`, был ли второй запуск, в какой проект
// записан план.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createPlans } from '../../electron/storage/plans'
import {
  generatePlan,
  cancelPlanGeneration,
  isGenerating,
  buildGenerationPrompt,
  __resetPlanGenerationForTests,
  PLAN_GENERATION_MODE,
  PLAN_GENERATION_TOOLS,
} from '../../electron/ipc/plans-generate'
import { rememberPlanForRun, __resetPlanForRunForTests } from '../../electron/ai/runner-shared'

let dir: string
let db: Database | undefined
type Plans = ReturnType<typeof createPlans>

function openStores() {
  db = openDb(join(dir, 'verstak.db'))
  return createPlans(db)
}

/** ФИКСТУРА, ДОБАВЛЕННАЯ 29.07 (утверждения этого файла не менялись). Выбор
 *  провайдера стал явной зависимостью — до дефекта 1 живой приёмки генерация
 *  молча брала активного провайдера чата и падала на CLI-подписке. Здесь случай
 *  «подмены не потребовалось»: активный провайдер годится. Сам выбор проверяется
 *  в tests/ipc/plan-generate-cli-provider.test.ts, и там он на CLI. */
const chooseApi = () => ({ providerId: 'claude' as const, notice: null, error: null })

const REQ = { projectPath: '', title: 'Настройка Директа', taskDescription: 'Проверь кампании и составь порядок исправлений.' }
const req = (patch: Partial<typeof REQ> = {}) => ({ ...REQ, projectPath: dir, ...patch })

/** Прогон, который «создал план»: кладёт его в БД и в реестр прогона — ровно так,
 *  как это делает настоящий create_plan внутри агентного цикла. */
function runnerThatCreatesPlan(plans: Plans, opts: { title?: string } = {}) {
  return vi.fn(async ({ projectPath, sendId }: { projectPath: string; sendId: number }) => {
    const plan = plans.create(projectPath, opts.title ?? 'План', [{ title: 'Шаг' }])
    rememberPlanForRun(sendId, plan.id)
    return { ok: true, text: 'готово' }
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gg-plan-gen-'))
  __resetPlanForRunForTests()
  __resetPlanGenerationForTests()
})
afterEach(() => { db?.close(); db = undefined; rmSync(dir, { recursive: true, force: true }) })

describe('§5.1: агент завершился без create_plan', () => {
  it('ошибка с ПРИЧИНОЙ и ноль строк в БД', async () => {
    const plans = openStores()
    const runPlanning = vi.fn(async () => ({ ok: true, text: 'Не могу: не указан рекламный кабинет.' }))

    const res = await generatePlan({ plans, runPlanning, isKnownProject: () => true, choosePlanProvider: chooseApi }, req())

    expect(res.ok).toBe(false)
    expect(res.error, 'голое «не удалось» запрещено ТЗ').toContain('не указан рекламный кабинет')
    expect(plans.list(dir), 'в БД появилась строка при неудаче').toHaveLength(0)
  })

  it('пустой ответ модели — понятная ошибка, всё равно ноль строк', async () => {
    const plans = openStores()
    const runPlanning = vi.fn(async () => ({ ok: true, text: '   ' }))
    const res = await generatePlan({ plans, runPlanning, isKnownProject: () => true, choosePlanProvider: chooseApi }, req())
    expect(res.ok).toBe(false)
    expect(res.error).toContain('Не удалось сформировать план')
    expect(plans.list(dir)).toHaveLength(0)
  })
})

describe('§5.2: провайдер недоступен', () => {
  it('ошибка маршрута отдаётся как есть, ничего не создаётся', async () => {
    const plans = openStores()
    const runPlanning = vi.fn(async () => ({ ok: false, text: '', error: 'Нет API-ключа для claude' }))

    const res = await generatePlan({ plans, runPlanning, isKnownProject: () => true, choosePlanProvider: chooseApi }, req())

    expect(res.error, 'свои сообщения вместо штатной ошибки маршрута запрещены').toBe('Нет API-ключа для claude')
    expect(plans.list(dir)).toHaveLength(0)
  })
})

describe('§5.3: двойной клик — один активный запрос на проект', () => {
  it('второй запуск ОТКАЗАН, прогон НЕ стартовал, план один', async () => {
    const plans = openStores()
    let release: (() => void) | null = null
    const started = vi.fn()
    const runPlanning = vi.fn(async ({ projectPath, sendId }: { projectPath: string; sendId: number }) => {
      started()
      await new Promise<void>(r => { release = r })
      const plan = plans.create(projectPath, 'План', [{ title: 'Шаг' }])
      rememberPlanForRun(sendId, plan.id)
      return { ok: true, text: 'ок' }
    })
    const deps = { plans, runPlanning, isKnownProject: () => true, choosePlanProvider: chooseApi }

    const first = generatePlan(deps, req())
    await vi.waitFor(() => expect(started).toHaveBeenCalled())
    const second = await generatePlan(deps, req())

    expect(second.ok, 'второй запрос прошёл — guard не работает').toBe(false)
    expect(started, 'второй прогон РЕАЛЬНО стартовал').toHaveBeenCalledTimes(1)
    release!()
    const firstRes = await first
    expect(firstRes.ok).toBe(true)
    expect(plans.list(dir), 'двойной клик дал два плана').toHaveLength(1)
  })

  it('после завершения генерация снова разрешена', async () => {
    const plans = openStores()
    const deps = { plans, runPlanning: runnerThatCreatesPlan(plans), isKnownProject: () => true, choosePlanProvider: chooseApi }

    await generatePlan(deps, req())
    expect(isGenerating(dir)).toBe(false)
    const second = await generatePlan(deps, req())

    expect(second.ok).toBe(true)
    expect(plans.list(dir)).toHaveLength(2)
  })
})

describe('§5.4: дубль внутри одного прогона закрыт РЕЕСТРОМ, а не вторым механизмом', () => {
  it('повторный create_plan в прогоне возвращает тот же planId', async () => {
    const plans = openStores()
    const runPlanning = vi.fn(async ({ projectPath, sendId }: { projectPath: string; sendId: number }) => {
      const plan = plans.create(projectPath, 'План', [{ title: 'Шаг' }])
      rememberPlanForRun(sendId, plan.id)
      // Второй вызов в том же прогоне: реестр уже занят — id остаётся прежним.
      rememberPlanForRun(sendId, plan.id)
      return { ok: true, text: 'ок' }
    })

    const res = await generatePlan({ plans, runPlanning, isKnownProject: () => true, choosePlanProvider: chooseApi }, req())

    expect(res.ok).toBe(true)
    expect(plans.list(dir)).toHaveLength(1)
    expect(res.planId).toBe(plans.list(dir)[0].id)
  })
})

describe('§5.6: смена проекта во время генерации', () => {
  it('план записан в ИСХОДНЫЙ проект, а не в тот, что открыт сейчас', async () => {
    const plans = openStores()
    const otherProject = join(dir, 'другой-проект')
    const runPlanning = vi.fn(async ({ projectPath, sendId }: { projectPath: string; sendId: number }) => {
      // Пользователь ушёл в другой проект прямо во время прогона.
      const plan = plans.create(projectPath, 'План', [{ title: 'Шаг' }])
      rememberPlanForRun(sendId, plan.id)
      return { ok: true, text: 'ок' }
    })

    const res = await generatePlan({ plans, runPlanning, isKnownProject: () => true, choosePlanProvider: chooseApi }, req())

    expect(res.ok).toBe(true)
    expect(plans.list(dir), 'план потерялся из исходного проекта').toHaveLength(1)
    expect(plans.list(otherProject), 'план записан в ЧУЖОЙ проект').toHaveLength(0)
  })

  it('незарегистрированный путь — отказ ДО запуска прогона', async () => {
    const plans = openStores()
    const runPlanning = vi.fn(async () => ({ ok: true, text: '' }))

    const res = await generatePlan({ plans, runPlanning, isKnownProject: () => false, choosePlanProvider: chooseApi }, req())

    expect(res.ok).toBe(false)
    expect(runPlanning, 'прогон стартовал по незарегистрированному пути').not.toHaveBeenCalled()
  })
})

describe('§5.7: отмена во время генерации', () => {
  it('отмена до create_plan → ноль строк в БД и честный ответ', async () => {
    const plans = openStores()
    const started = vi.fn()
    const runPlanning = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      started()
      await new Promise<void>(r => {
        if (signal.aborted) return r()
        signal.addEventListener('abort', () => r(), { once: true })
      })
      return { ok: false, text: '', error: 'aborted' }
    })
    const deps = { plans, runPlanning, isKnownProject: () => true, choosePlanProvider: chooseApi }

    const pending = generatePlan(deps, req())
    await vi.waitFor(() => expect(started).toHaveBeenCalled())
    expect(cancelPlanGeneration(dir)).toBe(true)
    const res = await pending

    expect(res.ok).toBe(false)
    expect(res.error).toContain('отменена')
    expect(plans.list(dir), 'при отмене осталась строка в БД').toHaveLength(0)
  })

  it('отменять нечего — честное false, без исключения', () => {
    expect(cancelPlanGeneration(dir)).toBe(false)
  })
})

describe('валидация и постановка', () => {
  it('пустые поля не запускают прогон вовсе', async () => {
    const plans = openStores()
    const runPlanning = vi.fn(async () => ({ ok: true, text: '' }))
    const deps = { plans, runPlanning, isKnownProject: () => true, choosePlanProvider: chooseApi }

    for (const bad of [{ title: '   ' }, { taskDescription: '  ' }, { title: '', taskDescription: '' }]) {
      const res = await generatePlan(deps, req(bad))
      expect(res.ok).toBe(false)
    }
    expect(runPlanning, 'пустая форма дошла до прогона').not.toHaveBeenCalled()
    expect(plans.list(dir)).toHaveLength(0)
  })

  it('уточнение — продолжение той же постановки, и второго круга вопросов быть не может', () => {
    const first = buildGenerationPrompt({ projectPath: dir, title: 'Креативы', taskDescription: 'Сделай креативы для моего бренда' })
    expect(first).toContain('Сделай креативы для моего бренда')
    expect(first).not.toContain('Уточнение пользователя')

    const second = buildGenerationPrompt({
      projectPath: dir, title: 'Креативы',
      taskDescription: 'Сделай креативы для моего бренда',
      clarification: 'Бренд — Альфа Девелопмент, площадка — Авито',
    })
    expect(second, 'исходная постановка потеряна').toContain('Сделай креативы для моего бренда')
    expect(second).toContain('Альфа Девелопмент')
    expect(second, 'второй круг вопросов запрещён ТЗ').toContain('Больше вопросов не задавай')
  })
})

describe('§3/§6: генерация идёт в режиме планирования', () => {
  it('режим прогона — plan, значит изменения блокирует mode-policy, а не свой список', async () => {
    const { decide } = await import('../../electron/ai/mode-policy')
    expect(PLAN_GENERATION_MODE).toBe('plan')
    for (const tool of ['write_file', 'apply_patch', 'run_command', 'connector_query', 'execute_code']) {
      expect(decide(tool, PLAN_GENERATION_MODE), tool).toBe('block')
    }
  })

  it('набор инструментов — изучение проекта и create_plan, без изменяющих', () => {
    expect(PLAN_GENERATION_TOOLS).toContain('create_plan')
    expect(PLAN_GENERATION_TOOLS).toContain('read_file')
    for (const forbidden of ['write_file', 'apply_patch', 'run_command', 'delegate_task', 'execute_code', 'connector_query']) {
      expect(PLAN_GENERATION_TOOLS, forbidden).not.toContain(forbidden)
    }
  })
})
