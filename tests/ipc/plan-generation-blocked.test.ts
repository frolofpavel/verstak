// ДЕФЕКТ ЖИВОЙ ПРОВЕРКИ (29.07, второй заход): фолбэк сработал, прогон пошёл — а
// плана нет. На экране: «Не удалось сформировать план: модель не создала план».
//
// Разбор идёт СНИЗУ ВВЕРХ по механике, как требует постановка: сперва доказываем,
// что инструмент вообще доехал до модели, и только потом смотрим, что с вызовом
// случилось. Иначе «инструмент не дали», «модель не захотела» и «механика
// отвергла результат» неразличимы — а лечатся они по-разному.
//
// БЕЗ SQLITE СОЗНАТЕЛЬНО: `create_plan` пишет через `ctx.recordPlan`, поэтому
// хранилище здесь поддельное. Тест проверяет РЕШЕНИЕ обработчика, а не работу БД,
// и заодно не ломается, когда файл нативного модуля занят запущенным приложением.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPlanHandler } from '../../electron/ipc/tool-handlers/verification'
import { runSubAgentLoop } from '../../electron/ai/sub-agent-loop'
import { PLAN_GENERATION_TOOLS, PLAN_GENERATION_MODE } from '../../electron/ipc/plans-generate'
import { __resetPlanForRunForTests, getPlanForRun } from '../../electron/ai/runner-shared'
import { planSpecFeedback, planSpecBlockers } from '../../electron/ai/task-spec-check'
import type { ChatProvider, ToolDefinition } from '../../electron/ai/types'

const DIR = '/проект'

/** Поддельное хранилище планов: обработчику нужен только recordPlan/getPlan. */
function fakeStore() {
  const rows: Array<{ id: number; title: string; steps: unknown[] }> = []
  return {
    rows,
    recordPlan: (_p: string, title: string, steps: unknown[]) => {
      const plan = { id: rows.length + 1, title, steps }
      rows.push(plan)
      return plan
    },
    getPlan: (id: number) => rows.find(r => r.id === id) ?? null,
  }
}

/** Контекст прогона генерации — тот же, что собирает runScheduledHeadless. */
function genCtx(store: ReturnType<typeof fakeStore>) {
  return {
    projectPath: DIR,
    sendId: -1000,
    runId: 'gen-1',
    parentChatId: null,
    agentMode: PLAN_GENERATION_MODE,
    delegationDepth: 0,
    recordPlan: store.recordPlan,
    getPlan: store.getPlan,
    recordJournal: () => {},
    getSecretForDelegate: () => null,
    sender: { send: vi.fn() },
  } as never
}

/** Реальная постановка Павла: настройка рекламы. Файлов в проекте она не трогает. */
const MARKETING_STEPS = [
  {
    title: 'Собрать текущие кампании',
    detail: 'Выгрузить список активных кампаний и ключевых фраз из рекламного кабинета за последние 30 дней. Критерий готовности: список кампаний с расходом и конверсиями собран.',
  },
  {
    title: 'Найти неэффективные фразы',
    detail: 'Отобрать фразы с расходом выше среднего и нулевыми конверсиями, сгруппировать по кампаниям. Критерий готовности: перечень фраз на отключение готов.',
  },
]

const MARKETING_PLAN = { id: 'c1', name: 'create_plan', args: { title: 'Настройка Директа', steps: MARKETING_STEPS } } as never

/** Тот же по форме план, но про код — там пути к файлам есть естественным образом. */
const CODE_PLAN = {
  id: 'c2', name: 'create_plan',
  args: {
    title: 'Починить загрузку',
    steps: [{
      title: 'Разобрать загрузчик',
      detail: 'Прочитать src/lib/loader.ts и выписать порядок инициализации модулей. Критерий готовности: порядок описан.',
    }],
  },
} as never

beforeEach(() => { __resetPlanForRunForTests() })

// ─────────────────────────────────────────────────────────────────────────────
// СЛОЙ 1: инструмент реально доезжает до модели. Если бы дело было здесь, то
// «модель не вызвала create_plan» означало бы «модель его не видела».
// ─────────────────────────────────────────────────────────────────────────────
describe('механика: набор инструментов генерации доходит до провайдера', () => {
  it('модель ВИДИТ create_plan и не видит инструментов записи', async () => {
    const seen: ToolDefinition[][] = []
    const provider = {
      // eslint-disable-next-line require-yield
      async *send(_msgs: unknown, toolDefs: ToolDefinition[]) { seen.push(toolDefs ?? []) },
    } as unknown as ChatProvider

    await runSubAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'составь план' }],
      allowedToolNames: [...PLAN_GENERATION_TOOLS],
      ctx: genCtx(fakeStore()),
      signal: new AbortController().signal,
      role: 'plan-generation',
    })

    const names = (seen[0] ?? []).map(t => t.name)
    expect(names, 'инструмента создания плана нет в наборе — модель его не видит').toContain('create_plan')
    expect(names).toContain('read_file')
    for (const forbidden of ['write_file', 'apply_patch', 'run_command']) {
      expect(names, forbidden).not.toContain(forbidden)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// СЛОЙ 2: что происходит с вызовом. ЗДЕСЬ И ЛЕЖАЛ ДЕФЕКТ.
//
// `create_plan` на чат-пути возвращал «План не сохранён: требуется доработка»,
// если у шага нет КОНКРЕТНЫХ ФАЙЛОВ/ПУТЕЙ (task-spec-check.scoreTaskSpec). Для
// задачи про код это разумно. Для «настрой Директ», «собери отчёт по Ozon»,
// «разбери переписку с клиентом» путей нет и быть не может — и план не
// сохранялся НИКОГДА, сколько бы модель ни старалась. Причём проверка пути
// написана под латиницу (`\w` без флага u), так что русский текст её не проходит
// в принципе.
//
// Это тот же класс, что вчерашний unattended-гейт: ограничение, осмысленное для
// исходного вызывающего, применено ко всем подряд.
// ─────────────────────────────────────────────────────────────────────────────
describe('механика: план непрограммистской задачи сохраняется', () => {
  it('план про рекламу СОХРАНЁН — путей к файлам в нём нет и быть не должно', async () => {
    const store = fakeStore()

    const res = await createPlanHandler.handle(MARKETING_PLAN, genCtx(store)) as { result: string; error?: string }

    expect(res.error).toBeUndefined()
    expect(res.result, 'план отвергнут — человек увидит «модель не создала план»').not.toContain('не сохранён')
    expect(store.rows, 'плана нет в хранилище').toHaveLength(1)
    expect(getPlanForRun(-1000), 'план не попал в реестр прогона — генерация сочтёт его несозданным').not.toBeNull()
  })

  it('подсказка про тонкое ТЗ остаётся — она полезна, но не запрещает', async () => {
    const store = fakeStore()

    const res = await createPlanHandler.handle(MARKETING_PLAN, genCtx(store)) as { result: string }

    expect(store.rows).toHaveLength(1)
    expect(res.result, 'модель не узнала, что ТЗ можно усилить').toContain('Тонкое ТЗ')
  })

  // КОНТРОЛЬ: полноценный план про код сохраняется и БЕЗ подсказки — иначе первый
  // кейс был бы зелёным просто оттого, что проверку качества снесли целиком.
  it('контроль: полноценный план про код сохраняется без замечаний', async () => {
    const store = fakeStore()

    const res = await createPlanHandler.handle(CODE_PLAN, genCtx(store)) as { result: string }

    expect(store.rows).toHaveLength(1)
    expect(res.result, 'замечание там, где ТЗ полное').not.toContain('Тонкое ТЗ')
  })

  // КОНТРОЛЬ ВТОРОЙ СТОРОНЫ: по-настоящему пустое ТЗ по-прежнему отвергается.
  // Проверка качества ослаблена ровно в одном признаке, а не выключена.
  it('контроль: расплывчатый шаг без критерия готовности — отказ, плана нет', async () => {
    const store = fakeStore()

    const res = await createPlanHandler.handle({
      id: 'c3', name: 'create_plan',
      args: { title: 'План', steps: [{ title: 'Сделать хорошо', detail: 'Разобраться' }] },
    } as never, genCtx(store)) as { result: string }

    expect(res.result).toContain('не сохранён')
    expect(store.rows, 'расплывчатый план сохранён').toHaveLength(0)
  })
})

// Разделение «что советуем» и «что запрещаем» — чистой функцией, отдельно от
// обработчика: именно из-за их слипания непрограммистские планы не сохранялись.
describe('task-spec-check: совет и запрет — разные вещи', () => {
  it('отсутствие путей — совет, а не запрет', () => {
    expect(planSpecFeedback(MARKETING_STEPS), 'совет пропал').toContain('конкретные файлы/пути')
    expect(planSpecBlockers(MARKETING_STEPS), 'отсутствие путей запрещает сохранение').toBe('')
  })

  it('отсутствие критерия готовности — запрет', () => {
    const vague = [{ title: 'Шаг', detail: 'Посмотреть на кампании и что-нибудь придумать по ходу дела.' }]
    expect(planSpecBlockers(vague)).toContain('критерий готовности')
  })

  it('слишком короткое описание — запрет', () => {
    expect(planSpecBlockers([{ title: 'Шаг', detail: 'Проверь.' }])).toContain('детальность')
  })

  it('полное ТЗ не даёт ни совета, ни запрета', () => {
    const full = [{ title: 'Шаг', detail: 'Прочитать src/app.ts и выписать зависимости модуля. Критерий готовности: список собран.' }]
    expect(planSpecFeedback(full)).toBe('')
    expect(planSpecBlockers(full)).toBe('')
  })
})
