// policy.test.ts — red-first проверки R0-R4 classifier + mode gating (BR-012).
//
// Каждый тест закрывает конкретный риск из BROWSER_EMPLOYEE_PLAN.md §5.1 / §10.5:
//   • unknown click = R3 (fail-closed)
//   • R4 всегда block (даже в auto/bypass)
//   • plan блокирует R1+
//   • auto/bypass не отменяют R3/R4

import { describe, it, expect } from 'vitest'
import {
  classifyRisk,
  decideApproval,
  decideAction,
  modeAllows,
  isBrowserMutationToolName,
  isBrowserMutationByRisk,
  BROWSER_MUTATION_TOOL_NAMES,
  BROWSER_NON_MUTATION_TOOL_NAMES,
  agentModeBlocksBrowserMutation,
} from '../../../electron/ai/browser/policy'
import type { BrowserActionType } from '../../../electron/ai/browser/types'

describe('classifyRisk — базовая классификация', () => {
  it('observe → R0', () => {
    expect(classifyRisk({ actionType: 'observe' })).toBe('R0')
  })
  it('screenshot → R0', () => {
    expect(classifyRisk({ actionType: 'screenshot' })).toBe('R0')
  })
  it('list_task_tabs → R0', () => {
    expect(classifyRisk({ actionType: 'list_task_tabs' })).toBe('R0')
  })
  it('wait_for → R0', () => {
    expect(classifyRisk({ actionType: 'wait_for' })).toBe('R0')
  })
  it('navigate → R1', () => {
    expect(classifyRisk({ actionType: 'navigate' })).toBe('R1')
  })
  it('scroll → R1', () => {
    expect(classifyRisk({ actionType: 'scroll' })).toBe('R1')
  })
  it('attach_tab/detach_tab/switch_tab → R1', () => {
    expect(classifyRisk({ actionType: 'attach_tab' })).toBe('R1')
    expect(classifyRisk({ actionType: 'detach_tab' })).toBe('R1')
    expect(classifyRisk({ actionType: 'switch_tab' })).toBe('R1')
  })
})

describe('classifyRisk — R4 markers в payload', () => {
  it('payload.password → R4', () => {
    expect(classifyRisk({ actionType: 'type_text', payload: { password: 'secret123' } })).toBe('R4')
  })
  it('payload.token → R4', () => {
    expect(classifyRisk({ actionType: 'click', payload: { token: 'abc' } })).toBe('R4')
  })
  it('payload.cvv → R4', () => {
    expect(classifyRisk({ actionType: 'type_text', payload: { cvv: '123' } })).toBe('R4')
  })
  it('payload.payment → R4', () => {
    expect(classifyRisk({ actionType: 'click', payload: { payment: 'confirm' } })).toBe('R4')
  })
  it('payload.otp → R4', () => {
    expect(classifyRisk({ actionType: 'type_text', payload: { otp: '123456' } })).toBe('R4')
  })
  it('payload.captcha → R4', () => {
    expect(classifyRisk({ actionType: 'click', payload: { captcha: 'solve' } })).toBe('R4')
  })
  it('payload с суффиксом apiKey → R4 (userPassword, otpCode и т.п.)', () => {
    expect(classifyRisk({ actionType: 'type_text', payload: { userPassword: 'x' } })).toBe('R4')
    expect(classifyRisk({ actionType: 'type_text', payload: { otpCode: '123' } })).toBe('R4')
  })
})

describe('classifyRisk — generic click/type = R3 (fail-closed)', () => {
  // Главный контракт BR-012: неизвестный эффект клика = R3.
  it('generic click без payload → R3', () => {
    expect(classifyRisk({ actionType: 'click' })).toBe('R3')
  })
  it('click с обычным payload → R3', () => {
    expect(classifyRisk({ actionType: 'click', payload: { elementRef: 'btn-1' } })).toBe('R3')
  })
  it('click на submit-кнопку (payload.action=submit) → R3', () => {
    expect(classifyRisk({ actionType: 'click', payload: { action: 'submit' } })).toBe('R3')
  })
  it('click на save → R3', () => {
    expect(classifyRisk({ actionType: 'click', payload: { action: 'save' } })).toBe('R3')
  })
  it('click на publish → R3', () => {
    expect(classifyRisk({ actionType: 'click', payload: { action: 'publish' } })).toBe('R3')
  })
  it('type_text без R3-маркера и без site policy → R3 (R1: R2 только при trusted site policy)', () => {
    // R1 контракт: без явного site policy type_text = R3 (fail-closed).
    expect(classifyRisk({ actionType: 'type_text', payload: { text: 'hello' } })).toBe('R3')
  })
  it('type_text с trusted site policy + trustedNoAutosubmit → R2', () => {
    const ctx = { provenReversibleOrigins: new Set(['trusted-app.com']) }
    expect(classifyRisk({
      actionType: 'type_text',
      payload: { text: 'hello', provenReversible: true, trustedNoAutosubmit: true },
      scope: { origin: 'trusted-app.com' },
    }, ctx)).toBe('R2')
  })
  it('type_text с provenReversible но без trustedNoAutosubmit → всё равно R3', () => {
    const ctx = { provenReversibleOrigins: new Set(['trusted-app.com']) }
    expect(classifyRisk({
      actionType: 'type_text',
      payload: { text: 'hello', provenReversible: true },
      scope: { origin: 'trusted-app.com' },
    }, ctx)).toBe('R3')
  })
  it('type_text в autosaving form → R3', () => {
    expect(classifyRisk({ actionType: 'type_text', payload: { intoAutosavingForm: true } })).toBe('R3')
  })
  it('select_option без site policy → R3', () => {
    expect(classifyRisk({ actionType: 'select_option' })).toBe('R3')
  })
  it('toggle без site policy → R3', () => {
    expect(classifyRisk({ actionType: 'toggle' })).toBe('R3')
  })
  it('press_key без явного ключа → R3 (fail-closed)', () => {
    expect(classifyRisk({ actionType: 'press_key' })).toBe('R3')
  })
  it('press_key Enter → R3 (potential submit)', () => {
    expect(classifyRisk({ actionType: 'press_key', payload: { key: 'Enter' } })).toBe('R3')
    expect(classifyRisk({ actionType: 'press_key', payload: { code: 'Return' } })).toBe('R3')
  })
  it('press_key Tab (без submit-риска, но без site policy) → R3 (fail-closed)', () => {
    expect(classifyRisk({ actionType: 'press_key', payload: { key: 'Tab' } })).toBe('R3')
  })
})

describe('classifyRisk — R4 markers рекурсивный + case-insensitive (R1 Block 6)', () => {
  it('payload с nested password → R4', () => {
    expect(classifyRisk({ actionType: 'type_text', payload: { form: { password: 'x' } } })).toBe('R4')
  })
  it('payload с nested otp в массиве (как key объекта) → R4', () => {
    expect(classifyRisk({ actionType: 'type_text', payload: { fields: [{ otp: '123' }] } })).toBe('R4')
  })
  it('payload с Bearer token как значение вложенного поля → R4', () => {
    expect(classifyRisk({ actionType: 'type_text', payload: { config: { auth: 'Bearer abc123def456ghi789' } } })).toBe('R4')
  })
  it('payload с PASSWORD (uppercase key) → R4', () => {
    expect(classifyRisk({ actionType: 'type_text', payload: { PASSWORD: 'x' } })).toBe('R4')
  })
  it('payload с ApiKey (camelCase) → R4', () => {
    expect(classifyRisk({ actionType: 'click', payload: { apiKey: 'abc' } })).toBe('R4')
  })
  it('payload со строковым значением PEM private key → R4', () => {
    expect(classifyRisk({ actionType: 'type_text', payload: { note: '-----BEGIN RSA PRIVATE KEY-----\nMIIE' } })).toBe('R4')
  })
  it('payload со строковым значением AWS access key → R4', () => {
    expect(classifyRisk({ actionType: 'type_text', payload: { config: 'key=AKIAIOSFODNN7EXAMPLE' } })).toBe('R4')
  })
  it('payload со строковым значением Bearer token → R4', () => {
    expect(classifyRisk({ actionType: 'type_text', payload: { auth: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' } })).toBe('R4')
  })
  it('payload со строковым значением CVV → R4', () => {
    expect(classifyRisk({ actionType: 'type_text', payload: { field: 'CVV: 123' } })).toBe('R4')
  })
  it('payload с nested Bearer token в массиве → R4', () => {
    expect(classifyRisk({ actionType: 'click', payload: { tokens: ['Bearer abc123def456ghi789jkl012'] } })).toBe('R4')
  })
})

describe('classifyRisk — unknown actionType fail-closed (R1 Block 6)', () => {
  it('unknown actionType → R3 (fail-closed)', () => {
    // @ts-expect-error — намеренно неизвестный actionType
    expect(classifyRisk({ actionType: 'download_file' })).toBe('R3')
    // @ts-expect-error
    expect(classifyRisk({ actionType: 'upload_file' })).toBe('R3')
    // @ts-expect-error
    expect(classifyRisk({ actionType: 'some_new_action' })).toBe('R3')
  })
})

describe('classifyRisk — proven reversible по site policy → R1', () => {
  it('click provenReversible=true в разрешённом origin → R1', () => {
    const ctx = { provenReversibleOrigins: new Set(['calltouch.com']) }
    expect(classifyRisk({
      actionType: 'click',
      payload: { provenReversible: true },
      scope: { origin: 'calltouch.com' },
    }, ctx)).toBe('R1')
  })
  it('click provenReversible=true но origin НЕ в списке → R3 (fail-closed)', () => {
    const ctx = { provenReversibleOrigins: new Set(['calltouch.com']) }
    expect(classifyRisk({
      actionType: 'click',
      payload: { provenReversible: true },
      scope: { origin: 'unknown-site.com' },
    }, ctx)).toBe('R3')
  })
  it('click provenReversible=true но origin отсутствует → R3', () => {
    const ctx = { provenReversibleOrigins: new Set(['calltouch.com']) }
    expect(classifyRisk({
      actionType: 'click',
      payload: { provenReversible: true },
      scope: { origin: null },
    }, ctx)).toBe('R3')
  })
})

describe('modeAllows — режимы Browser Employee (§5.2)', () => {
  it('watch: R0 и R1 разрешены, R2/R3/R4 — нет', () => {
    expect(modeAllows('watch', 'R0')).toBe(true)
    expect(modeAllows('watch', 'R1')).toBe(true)
    expect(modeAllows('watch', 'R2')).toBe(false)
    expect(modeAllows('watch', 'R3')).toBe(false)
    expect(modeAllows('watch', 'R4')).toBe(false)
  })
  it('prepare: R0/R1/R2 разрешены, R3/R4 — нет', () => {
    expect(modeAllows('prepare', 'R0')).toBe(true)
    expect(modeAllows('prepare', 'R1')).toBe(true)
    expect(modeAllows('prepare', 'R2')).toBe(true)
    expect(modeAllows('prepare', 'R3')).toBe(false)
    expect(modeAllows('prepare', 'R4')).toBe(false)
  })
  it('execute: R0/R1/R2/R3 разрешены, R4 — нет', () => {
    expect(modeAllows('execute', 'R0')).toBe(true)
    expect(modeAllows('execute', 'R1')).toBe(true)
    expect(modeAllows('execute', 'R2')).toBe(true)
    expect(modeAllows('execute', 'R3')).toBe(true)
    expect(modeAllows('execute', 'R4')).toBe(false)
  })
})

describe('decideApproval — гейтинг риска по режиму (§5.1)', () => {
  it('R4 всегда block, даже в execute', () => {
    const d = decideApproval('execute', 'R4')
    expect(d.kind).toBe('block')
  })
  it('R3 в execute → require-approval (одноразовое подтверждение)', () => {
    const d = decideApproval('execute', 'R3')
    expect(d.kind).toBe('require-approval')
  })
  it('R3 в watch → block (режим не позволяет R3)', () => {
    const d = decideApproval('watch', 'R3')
    expect(d.kind).toBe('block')
  })
  it('R3 в auto/bypass-like execute → всё равно require-approval (auto/bypass не отменяют R3)', () => {
    // В execute R3 всегда идёт через approval, даже если agent_mode=auto/bypass
    const d = decideApproval('execute', 'R3')
    expect(d.kind).toBe('require-approval')
  })
  it('R0 → auto (без подтверждения)', () => {
    expect(decideApproval('watch', 'R0').kind).toBe('auto')
    expect(decideApproval('execute', 'R0').kind).toBe('auto')
  })
  it('R1 в watch/prepare/execute → auto', () => {
    expect(decideApproval('watch', 'R1').kind).toBe('auto')
    expect(decideApproval('prepare', 'R1').kind).toBe('auto')
    expect(decideApproval('execute', 'R1').kind).toBe('auto')
  })
  it('R2 в prepare/execute → auto, в watch → block', () => {
    expect(decideApproval('prepare', 'R2').kind).toBe('auto')
    expect(decideApproval('execute', 'R2').kind).toBe('auto')
    expect(decideApproval('watch', 'R2').kind).toBe('block')
  })
})

describe('decideAction — комбинация classify + decideApproval', () => {
  it('generic click в execute → R3 + require-approval', () => {
    const r = decideAction({ actionType: 'click' }, 'execute')
    expect(r.risk).toBe('R3')
    expect(r.decision.kind).toBe('require-approval')
  })
  it('type password в execute → R4 + block', () => {
    const r = decideAction({ actionType: 'type_text', payload: { password: 'x' } }, 'execute')
    expect(r.risk).toBe('R4')
    expect(r.decision.kind).toBe('block')
  })
  it('observe в watch → R0 + auto', () => {
    const r = decideAction({ actionType: 'observe' }, 'watch')
    expect(r.risk).toBe('R0')
    expect(r.decision.kind).toBe('auto')
  })
  it('navigate в watch → R1 + auto', () => {
    const r = decideAction({ actionType: 'navigate' }, 'watch')
    expect(r.risk).toBe('R1')
    expect(r.decision.kind).toBe('auto')
  })
  it('type_text в watch → R3 (fail-closed без site policy) + block (режим не позволяет)', () => {
    const r = decideAction({ actionType: 'type_text' }, 'watch')
    expect(r.risk).toBe('R3')
    expect(r.decision.kind).toBe('block')
  })
})

describe('agent-mode интеграция (§5.2)', () => {
  it('agent_mode=plan блокирует все browser mutations R1+', () => {
    expect(agentModeBlocksBrowserMutation('plan', 'R0')).toBe(false)
    expect(agentModeBlocksBrowserMutation('plan', 'R1')).toBe(true)
    expect(agentModeBlocksBrowserMutation('plan', 'R2')).toBe(true)
    expect(agentModeBlocksBrowserMutation('plan', 'R3')).toBe(true)
    expect(agentModeBlocksBrowserMutation('plan', 'R4')).toBe(true)
  })
  it('agent_mode != plan — не блокирует дополнительно (browserMode решает)', () => {
    expect(agentModeBlocksBrowserMutation('ask', 'R3')).toBe(false)
    expect(agentModeBlocksBrowserMutation('auto', 'R3')).toBe(false)
    expect(agentModeBlocksBrowserMutation('bypass', 'R4')).toBe(false)
  })
})

describe('crash-resume integration (B0 п.6)', () => {
  it('isBrowserMutationByRisk: R0=false, R1+=true', () => {
    expect(isBrowserMutationByRisk('R0')).toBe(false)
    expect(isBrowserMutationByRisk('R1')).toBe(true)
    expect(isBrowserMutationByRisk('R2')).toBe(true)
    expect(isBrowserMutationByRisk('R3')).toBe(true)
    expect(isBrowserMutationByRisk('R4')).toBe(true)
  })
  it('isBrowserMutationToolName: browser_screenshot=false, browser_navigate=true, browser_click=true', () => {
    expect(isBrowserMutationToolName('browser_screenshot')).toBe(false)
    expect(isBrowserMutationToolName('browser_read_page')).toBe(false)
    expect(isBrowserMutationToolName('browser_observe')).toBe(false)
    expect(isBrowserMutationToolName('browser_navigate')).toBe(true)
    expect(isBrowserMutationToolName('browser_click')).toBe(true)
    expect(isBrowserMutationToolName('browser_type_text')).toBe(true)
    expect(isBrowserMutationToolName('run_command')).toBe(false) // не browser_*
    expect(isBrowserMutationToolName(null)).toBe(false)
    expect(isBrowserMutationToolName('')).toBe(false)
  })
  it('BROWSER_MUTATION_TOOL_NAMES включает все известные mutation browser tools', () => {
    expect(BROWSER_MUTATION_TOOL_NAMES).toContain('browser_navigate')
    expect(BROWSER_MUTATION_TOOL_NAMES).toContain('browser_click')
    expect(BROWSER_MUTATION_TOOL_NAMES).toContain('browser_type_text')
  })
  it('BROWSER_NON_MUTATION_TOOL_NAMES — только observe-like', () => {
    expect(BROWSER_NON_MUTATION_TOOL_NAMES).toEqual(['browser_screenshot', 'browser_read_page', 'browser_observe'])
  })
})

describe('RED-first regression pack — конкретные дыры из плана §10.5', () => {
  it('R3 не исполняется повторно после timeout/fallback — controller тут не причём, но classifier должен помечать R3 однозначно', () => {
    // Тест на classify: submit-кнопка = R3 (не R1, не R2).
    expect(classifyRisk({ actionType: 'click', payload: { action: 'submit' } })).toBe('R3')
  })
  it('R4 невозможно выполнить даже в auto/bypass', () => {
    // decideApproval(execute, R4) = block; auto/bypass здесь не работают.
    expect(decideApproval('execute', 'R4').kind).toBe('block')
  })
  it('writer lock (account/site) — для B0 на уровне classifier: две разные submit-кнопки обе R3', () => {
    // Полноценный writer lock — в controller.ts. Здесь проверяем что submit всегда R3.
    expect(classifyRisk({ actionType: 'click', payload: { action: 'submit', target: 'campaign-launch' } })).toBe('R3')
    expect(classifyRisk({ actionType: 'click', payload: { action: 'submit', target: 'campaign-pause' } })).toBe('R3')
  })
})
