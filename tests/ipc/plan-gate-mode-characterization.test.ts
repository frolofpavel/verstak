// Блок B-2 (ТЗ §5, матрица режимов) — гейт согласования ПОСЛЕ переворота.
//
// ИСТОРИЯ ЭТОГО ФАЙЛА ВАЖНА. Он был снят как characterization «как есть» ДО
// правок (коммит d1925d0): тогда карточка появлялась РОВНО в одном режиме —
// `plan`, и только при включённой настройке. §5 требует обратного: в `plan`
// согласовывать нечего (выполнение там запрещено всегда), зато карточка обязана
// появляться в `ask` и `accept-edits`, где гейта не было вовсе.
//
// Шесть кейсов ниже переписаны из «как есть» в «как стало» — ровно те, чьё
// поведение §5 отменяет. Отменённый кейс переходит в противоположный, а не
// исчезает молча: снимок «до» лежит в истории git и сравним построчно. Все
// остальные кейсы файла остались дословно теми же и зелёными — доказательство,
// что переворот сломал ровно предназначенное.
//
// Рубильник чат-контекста — настройка `plan_approval_gate` («Ждать одобрения
// плана»). Она выключена по умолчанию, поэтому при выключенном тумблере поведение
// осталось прежним байт в байт, а §5 включается вместе с ним. Почему матрицу
// нельзя включить по умолчанию прямо сейчас — разобрано в аудите (хвост §10).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPlanHandler } from '../../electron/ipc/tool-handlers/verification'
import { __resetPlanForRunForTests, __resetAwaitingPlansForTests } from '../../electron/ai/runner-shared'
import { validContract } from '../contracts/outcome-contract.test'
import type { PlanStepSpecV1 } from '../../shared/contracts/outcome'
import type { AgentMode } from '../../electron/ai/mode-policy'

const ALL_MODES: AgentMode[] = ['ask', 'accept-edits', 'plan', 'auto', 'bypass']

/** Шаг без structured spec — легаси-путь; текст подобран так, чтобы пройти
 *  planSpecFeedback (иначе хендлер вернётся раньше решения о карточке). */
const legacyStep = {
  title: 'Исправить auth',
  detail: 'В src/auth/login.ts исправить создание сессии. Критерий готовности: npm test -- auth проходит.',
}

/** Spec, заведомо проходящий quality-гейт против validContract (форма из
 *  create-plan-handler.test.ts). writeScope пуст → порог считает план читающим. */
const readOnlySpec: PlanStepSpecV1 = {
  key: 'auth-fix', title: 'Исправить auth', intent: 'Исправить создание сессии в функции login',
  files: ['src/auth/login.ts'], symbols: ['login'], actions: ['Прочитать ветку сохранения сессии'],
  dependsOn: [], readScope: ['src/auth'], writeScope: [],
  acceptanceCriterionIds: ['auth-green'], verification: ['npm test -- auth'],
  expectedEvidence: ['command:npm test -- auth'], rollback: 'git revert',
  role: 'executor', execution: 'main', risk: 'medium',
}

interface CtxOpts {
  mode: AgentMode
  gateSetting?: boolean
  outcomePhase?: 'refine' | 'plan' | 'execute-step' | null
  spec?: PlanStepSpecV1 | null
}

function makeCtx(opts: CtxOpts) {
  const sender = { send: vi.fn() }
  const setAgentMode = vi.fn()
  const ctx = {
    projectPath: '/p', sendId: 1, runId: 'run-1', parentChatId: 7,
    agentMode: opts.mode, setAgentMode,
    getSecretForDelegate: (k: string) =>
      (k === 'plan_approval_gate' ? (opts.gateSetting ? 'true' : null) : null),
    recordPlan: vi.fn(() => ({ id: 42, planRevision: 1 })),
    getPlan: vi.fn(() => null),
    recordJournal: vi.fn(),
    pendingPlans: new Map(),
    scopedKey: (s: number, c: string) => `${s}::${c}`,
    sender,
    ...(opts.outcomePhase
      ? {
        outcome: { pipelineId: 7, phase: opts.outcomePhase },
        pipelineRuns: {
          get: vi.fn(() => ({
            id: 7, projectPath: '/p', taskContract: validContract,
            contractRevision: validContract.revision, planId: null,
          })),
        },
      }
      : {}),
  }
  return { ctx: ctx as never, sender, setAgentMode }
}

function callWith(spec: PlanStepSpecV1 | null) {
  return {
    id: 'c1', name: 'create_plan',
    args: { title: 'Рефактор', steps: [spec ? { ...legacyStep, spec } : legacyStep] },
  } as never
}

/** Появилась ли карточка согласования. */
function cardShown(sender: { send: ReturnType<typeof vi.fn> }): boolean {
  return sender.send.mock.calls
    .map(c => (c[1] as { event: { type: string } }).event.type)
    .includes('plan-approval')
}

beforeEach(() => {
  __resetPlanForRunForTests()
  __resetAwaitingPlansForTests()
})

describe('КАК СТАЛО: карточка в ask и accept-edits, в plan её нет', () => {
  // Ядро матрицы §5. Раньше эта таблица была обратной: true стоял только у plan.
  const GATED: AgentMode[] = ['ask', 'accept-edits']
  it.each(ALL_MODES)('режим %s + настройка ВКЛ', async mode => {
    const { ctx, sender } = makeCtx({ mode, gateSetting: true })
    const res = await createPlanHandler.handle(callWith(null), ctx) as { result: string }
    if (GATED.includes(mode)) {
      expect(cardShown(sender), `в режиме ${mode} карточка обязана появиться`).toBe(true)
      expect(res.result).toContain('согласование')
    } else {
      // plan — согласовывать нечего (выполнение запрещено всегда);
      // auto — план автоутверждается целиком; bypass — без нового гейта.
      expect(cardShown(sender), `в режиме ${mode} карточки быть не должно`).toBe(false)
      expect(res.result).toContain('Plan #42')
    }
  })

  it.each(ALL_MODES)('режим %s + настройка ВЫКЛ: карточки нет ни в одном режиме', async mode => {
    const { ctx, sender } = makeCtx({ mode, gateSetting: false })
    const res = await createPlanHandler.handle(callWith(null), ctx) as { result: string }
    expect(cardShown(sender)).toBe(false)
    expect(res.result).toContain('Plan #42')
  })

  // Тумблер остался рубильником чат-контекста — сменился только режим, в котором
  // он что-то включает. Раньше это был plan, теперь ask.
  it('в режиме ask настройка и есть весь гейт: ВЫКЛ → карточки нет', async () => {
    const on = makeCtx({ mode: 'ask', gateSetting: true })
    const off = makeCtx({ mode: 'ask', gateSetting: false })
    await createPlanHandler.handle(callWith(null), on.ctx)
    await createPlanHandler.handle(callWith(null), off.ctx)
    expect(cardShown(on.sender)).toBe(true)
    expect(cardShown(off.sender)).toBe(false)
  })

  // Инверсия ТЗ отдельным пином, чтобы её нельзя было потерять молча.
  it('в режиме plan карточки нет вовсе — одобрять нечем, кнопки не существует', async () => {
    for (const gateSetting of [true, false]) {
      const { ctx, sender } = makeCtx({ mode: 'plan', gateSetting })
      const res = await createPlanHandler.handle(callWith(null), ctx) as { result: string }
      expect(cardShown(sender), `настройка=${gateSetting}`).toBe(false)
      expect(res.result).toContain('Plan #42')
    }
  })
})

describe('КАК ЕСТЬ: outcome-пайплайн включает гейт независимо от режима', () => {
  it.each(ALL_MODES)('фаза plan в пайплайне + режим %s: карточка есть, настройка не нужна', async mode => {
    const { ctx, sender } = makeCtx({ mode, gateSetting: false, outcomePhase: 'plan', spec: readOnlySpec })
    await createPlanHandler.handle(callWith(readOnlySpec), ctx)
    // Порог: writeScope пуст, опасных слов нет → план читающий → автоутверждение
    // БЕЗ карточки. Гейт применим, но карточку снимает порог, а не режим.
    expect(cardShown(sender), 'читающий план автоутверждается порогом').toBe(false)
  })

  it('фаза plan + пишущий план: карточка есть в любом режиме, включая bypass', async () => {
    const writing = { ...readOnlySpec, writeScope: ['src/auth/login.ts'] }
    for (const mode of ALL_MODES) {
      const { ctx, sender } = makeCtx({ mode, gateSetting: false, outcomePhase: 'plan', spec: writing })
      await createPlanHandler.handle(callWith(writing), ctx)
      expect(cardShown(sender), `режим ${mode} не отменяет гейт outcome-фазы`).toBe(true)
    }
  })
})

describe('ОСТАЛОСЬ КАК БЫЛО: легаси-путь не умеет автоутверждать', () => {
  // Порог требует structured spec у ВСЕХ шагов; у легаси-шага его нет → вердикт
  // no-declaration → карточка. Значит автоутверждение достижимо ТОЛЬКО через
  // outcome-пайплайн, и §5 этого НЕ изменил.
  //
  // Цена известна и названа честно: при включённом тумблере в ask карточка
  // появится на КАЖДЫЙ многошаговый план, включая читающий, то есть правило §4.2
  // «чтение не требует утверждения» на легаси-пути пока не работает. Починить
  // выносом парсинга spec из-под `if (ctx.outcome)` НЕДОСТАТОЧНО: parsePlanStepSpec
  // отдаёт значение только при нуле диагностик (нужны все 16 полей), а описание
  // инструмента прямо разрешает легаси-планам spec не передавать. Разбор — в
  // аудите; это отдельная позиция, а не строчка внутри §5.
  it('шаг без spec в режиме ask всегда даёт карточку — автоутверждения нет', async () => {
    const { ctx, sender } = makeCtx({ mode: 'ask', gateSetting: true })
    const res = await createPlanHandler.handle(callWith(null), ctx) as { result: string }
    expect(cardShown(sender)).toBe(true)
    expect(res.result).not.toContain('автоутверждён')
  })
})

describe('КАК ЕСТЬ: инварианты §10, которые матрица обязана сохранить', () => {
  it('карточка понижает режим прогона до plan и НИКОГДА не повышает', async () => {
    const { ctx, setAgentMode } = makeCtx({ mode: 'ask', gateSetting: true })
    await createPlanHandler.handle(callWith(null), ctx)
    expect(setAgentMode).toHaveBeenCalledWith('plan')
    for (const raising of ['accept-edits', 'auto', 'bypass']) {
      expect(setAgentMode).not.toHaveBeenCalledWith(raising)
    }
  })

  it('ожидание внутри прогона не заводится ни в одном режиме', async () => {
    for (const mode of ALL_MODES) {
      const { ctx } = makeCtx({ mode, gateSetting: true })
      await createPlanHandler.handle(callWith(null), ctx)
      expect((ctx as unknown as { pendingPlans: Map<string, unknown> }).pendingPlans.size, mode).toBe(0)
    }
  })

  it('план сохраняется во всех режимах: карточка решает показ, а не запись в БД', async () => {
    for (const mode of ALL_MODES) {
      const { ctx } = makeCtx({ mode, gateSetting: true })
      await createPlanHandler.handle(callWith(null), ctx)
      expect((ctx as unknown as { recordPlan: ReturnType<typeof vi.fn> }).recordPlan, mode).toHaveBeenCalledTimes(1)
    }
  })
})
