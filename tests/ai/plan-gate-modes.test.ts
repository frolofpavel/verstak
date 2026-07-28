// ТЗ VSK-TASK-FLOW-A1 §5 — матрица режимов агента, машиночитаемая.
//
// Это перевёрнутая версия снимка «как есть»
// (tests/ipc/plan-gate-mode-characterization.test.ts): там зафиксировано, что
// карточка была ровно в одном режиме `plan`, здесь — что она в `ask` и
// `accept-edits`, а в `plan` её нет. Пины стоят на ЧИСТОЙ функции: матрица —
// решение о том, кто спрашивает, и рантайм для её проверки не нужен.
import { describe, it, expect } from 'vitest'
import { planGateApplies } from '../../electron/ai/plan-gate-modes'
import type { AgentMode } from '../../electron/ai/mode-policy'

const ALL_MODES: AgentMode[] = ['ask', 'accept-edits', 'plan', 'auto', 'bypass']

/** Ожидаемая строка матрицы §5 в чат-контексте при включённом тумблере. */
const EXPECTED_WITH_SETTING: Record<AgentMode, boolean> = {
  'ask': true,
  'accept-edits': true,
  'plan': false,      // ПЕРЕВОРОТ: было единственное true
  'auto': false,
  'bypass': false,
}

describe('§5: матрица режимов в чат-контексте', () => {
  it.each(ALL_MODES)('режим %s при включённом тумблере', mode => {
    expect(planGateApplies({ agentMode: mode, planApprovalSetting: true }))
      .toBe(EXPECTED_WITH_SETTING[mode])
  })

  // Рубильник: выключен → чат-контекст ведёт себя как до §5, во всех режимах.
  it.each(ALL_MODES)('режим %s при выключенном тумблере — гейта нет', mode => {
    expect(planGateApplies({ agentMode: mode, planApprovalSetting: false })).toBe(false)
    expect(planGateApplies({ agentMode: mode })).toBe(false)
  })

  // Главная инверсия ТЗ, отдельным пином — чтобы её нельзя было потерять молча.
  it('в режиме plan гейта нет ни при какой настройке: согласовывать нечего', () => {
    expect(planGateApplies({ agentMode: 'plan', planApprovalSetting: true })).toBe(false)
    expect(planGateApplies({ agentMode: 'plan', planApprovalSetting: false })).toBe(false)
  })

  // Обратная сторона той же инверсии.
  it('в ask и accept-edits гейт есть — этого раньше не было вовсе', () => {
    expect(planGateApplies({ agentMode: 'ask', planApprovalSetting: true })).toBe(true)
    expect(planGateApplies({ agentMode: 'accept-edits', planApprovalSetting: true })).toBe(true)
  })
})

describe('§5: Outcome-пайплайн — своя ось, проверяется первой', () => {
  // Если бы матрица судила только по режиму, эта строка убила бы пайплайн:
  // фаза plan форсит режим 'plan', а approve — единственное, что двигает
  // пайплайн на execute.
  it.each(ALL_MODES)('фаза plan + режим %s: гейт есть, настройка не нужна', mode => {
    expect(planGateApplies({ agentMode: mode, outcomePhase: 'plan' })).toBe(true)
    expect(planGateApplies({ agentMode: mode, outcomePhase: 'plan', planApprovalSetting: false })).toBe(true)
  })

  it('другие фазы пайплайна гейта не включают — решает режим', () => {
    for (const phase of ['refine', 'execute-step', 'verify', 'replan']) {
      expect(planGateApplies({ agentMode: 'plan', outcomePhase: phase, planApprovalSetting: true }), phase).toBe(false)
      expect(planGateApplies({ agentMode: 'ask', outcomePhase: phase, planApprovalSetting: true }), phase).toBe(true)
    }
  })
})

describe('§5: субагент гейта не получает', () => {
  // Защита на будущее, а не лечение живого сценария: create_plan не входит ни в
  // один роль-набор, комбинация достижима только через самодельный agent-файл.
  // Цена ошибки высока — setAgentMode субагента мутирует holder РОДИТЕЛЬСКОГО
  // прогона, то есть суб понизил бы права родителя и удержал чужой чекпойнт.
  it('delegationDepth ≥ 1 снимает гейт в любом режиме чат-контекста', () => {
    for (const mode of ALL_MODES) {
      expect(planGateApplies({ agentMode: mode, planApprovalSetting: true, delegationDepth: 1 }), mode).toBe(false)
    }
  })

  it('глубина 0 и отсутствие глубины — это главный агент', () => {
    expect(planGateApplies({ agentMode: 'ask', planApprovalSetting: true, delegationDepth: 0 })).toBe(true)
    expect(planGateApplies({ agentMode: 'ask', planApprovalSetting: true })).toBe(true)
  })

  // Порядок ветвей: Outcome-ось стоит ДО проверки глубины, и это осознанно —
  // поведение пайплайна §5 менять не должна.
  it('в фазе plan пайплайна глубина гейт не снимает', () => {
    expect(planGateApplies({ agentMode: 'plan', outcomePhase: 'plan', delegationDepth: 2 })).toBe(true)
  })
})
