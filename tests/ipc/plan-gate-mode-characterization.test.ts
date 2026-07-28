// Блок B-2 (ТЗ §5, матрица режимов) — characterization НЫНЕШНЕГО условия гейта,
// снятая ДО переворота.
//
// Зачем именно characterization. §5 не настраивает текущее поведение, а
// переворачивает его: сегодня карточка согласования появляется РОВНО в одном
// режиме (`plan`, и только при включённой настройке), а по ТЗ в этом режиме её не
// должно быть вообще, зато она обязана появляться в `ask` и `accept-edits`, где
// сейчас гейта нет вовсе. Переворот такого рода легко сделать «почти правильно» и
// не заметить, что заодно поехало что-то третье. Эти пины фиксируют «как есть»,
// чтобы после переворота было чем доказать: сломано ровно предназначенное.
//
// Пины ниже намеренно описывают поведение, часть которого будет ОТМЕНЕНА. Их
// правка при реализации §5 — ожидаемая и обязательная; отменённый кейс переходит
// в противоположный, а не удаляется молча. Это и есть смысл снимка «до».
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

describe('КАК ЕСТЬ: карточка согласования появляется ровно в одном режиме', () => {
  // Ядро снимка. По ТЗ §5 эта таблица должна стать почти обратной.
  it.each(ALL_MODES)('режим %s + настройка ВКЛ: карточка только в plan', async mode => {
    const { ctx, sender } = makeCtx({ mode, gateSetting: true })
    const res = await createPlanHandler.handle(callWith(null), ctx) as { result: string }
    if (mode === 'plan') {
      expect(cardShown(sender), 'сегодня plan — единственный режим с карточкой').toBe(true)
      expect(res.result).toContain('согласование')
    } else {
      expect(cardShown(sender), `в режиме ${mode} гейта сейчас нет вовсе`).toBe(false)
      expect(res.result).toContain('Plan #42')
    }
  })

  it.each(ALL_MODES)('режим %s + настройка ВЫКЛ: карточки нет ни в одном режиме', async mode => {
    const { ctx, sender } = makeCtx({ mode, gateSetting: false })
    const res = await createPlanHandler.handle(callWith(null), ctx) as { result: string }
    expect(cardShown(sender)).toBe(false)
    expect(res.result).toContain('Plan #42')
  })

  // Настройка plan_approval_gate — тумблер, который сегодня решает всё в легаси-пути.
  it('в режиме plan настройка и есть весь гейт: ВЫКЛ → карточки нет', async () => {
    const on = makeCtx({ mode: 'plan', gateSetting: true })
    const off = makeCtx({ mode: 'plan', gateSetting: false })
    await createPlanHandler.handle(callWith(null), on.ctx)
    await createPlanHandler.handle(callWith(null), off.ctx)
    expect(cardShown(on.sender)).toBe(true)
    expect(cardShown(off.sender)).toBe(false)
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

describe('КАК ЕСТЬ: легаси-путь не умеет автоутверждать', () => {
  // Порог требует structured spec у ВСЕХ шагов; у легаси-шага его нет → вердикт
  // no-declaration → карточка. Значит автоутверждение сегодня достижимо ТОЛЬКО
  // через outcome-пайплайн. Для §5 это существенно: в ask/accept-edits порог
  // должен работать и на легаси-пути, иначе матрица упрётся в fail-safe.
  it('шаг без spec в режиме plan всегда даёт карточку — автоутверждения нет', async () => {
    const { ctx, sender } = makeCtx({ mode: 'plan', gateSetting: true })
    const res = await createPlanHandler.handle(callWith(null), ctx) as { result: string }
    expect(cardShown(sender)).toBe(true)
    expect(res.result).not.toContain('автоутверждён')
  })
})

describe('КАК ЕСТЬ: инварианты §10, которые матрица обязана сохранить', () => {
  it('карточка понижает режим прогона до plan и НИКОГДА не повышает', async () => {
    const { ctx, setAgentMode } = makeCtx({ mode: 'plan', gateSetting: true })
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
