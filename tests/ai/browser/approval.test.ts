// approval.test.ts — строгий scoped digest + atomic consume (BR-017).
//
// Главные свойства:
//   • digest детерминированный (тот же snapshot → тот же digest)
//   • любое изменение поля → другой digest
//   • cross-scope approval отклоняется (другой task/run/tenant/observationVersion)
//   • stale observation version отклоняется
//   • constantTimeEqual работает

import { describe, it, expect } from 'vitest'
import {
  buildDigest,
  buildApprovalSnapshot,
  computeDigest,
  verifyDigest,
  canonicalJson,
  constantTimeEqual,
  checkPreconditions,
  checkScopeAlignment,
} from '../../../electron/ai/browser/approval'
import type {
  BrowserActionScope,
  BrowserActionType,
} from '../../../electron/ai/browser/types'

function mkScope(over: Partial<BrowserActionScope> = {}): BrowserActionScope {
  return {
    browserTaskId: 'bt-1',
    runId: 'run-1',
    tabRef: 'tab-1',
    documentId: 'doc-1',
    url: 'https://calltouch.com/report',
    origin: 'calltouch.com',
    tenant: 'acct-x',
    account: 'user@x',
    observationId: 'obs-1',
    observationVersion: 5,
    elementRef: 'btn-submit',
    ...over,
  }
}

const baseAction = {
  actionId: 'a-1',
  browserTaskId: 'bt-1',
  runId: 'run-1',
  scope: mkScope(),
  actionType: 'click' as BrowserActionType,
  payload: { elementRef: 'btn-submit', action: 'submit' },
  preconditions: { expectedOrigin: 'calltouch.com', expectedObservationVersion: 5 },
  expectedPostcondition: { urlContains: '/report/submitted' },
  risk: 'R3' as const,
}

describe('canonicalJson — детерминированная сериализация', () => {
  it('ключи объекта отсортированы', () => {
    const a = canonicalJson({ b: 1, a: 2, c: 3 })
    const b = canonicalJson({ c: 3, a: 2, b: 1 })
    expect(a).toBe(b)
  })
  it('null → "null"', () => {
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(undefined)).toBe('null')
  })
  it('вложенные объекты тоже отсортированы', () => {
    const a = canonicalJson({ outer: { z: 1, a: 2 } })
    const b = canonicalJson({ outer: { a: 2, z: 1 } })
    expect(a).toBe(b)
  })
  it('массивы сохраняют порядок', () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]))
    expect(canonicalJson([1, 2, 3])).toBe(canonicalJson([1, 2, 3]))
  })
})

describe('computeDigest — детерминированность', () => {
  it('тот же snapshot → тот же digest', () => {
    const s1 = buildApprovalSnapshot(baseAction)
    const s2 = buildApprovalSnapshot(baseAction)
    expect(computeDigest(s1)).toBe(computeDigest(s2))
  })
  it('digest начинается с sha256:', () => {
    expect(computeDigest(buildApprovalSnapshot(baseAction))).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('computeDigest — чувствительность к полям (любое изменение → другой digest)', () => {
  const baseDigest = computeDigest(buildApprovalSnapshot(baseAction))

  it('другой browserTaskId → другой digest', () => {
    const d = computeDigest(buildApprovalSnapshot({ ...baseAction, browserTaskId: 'bt-2' }))
    expect(d).not.toBe(baseDigest)
  })
  it('другой runId → другой digest', () => {
    const d = computeDigest(buildApprovalSnapshot({ ...baseAction, runId: 'run-2' }))
    expect(d).not.toBe(baseDigest)
  })
  it('другой observationVersion → другой digest (stale refs invalidation)', () => {
    const d = computeDigest(buildApprovalSnapshot({
      ...baseAction,
      scope: mkScope({ observationVersion: 6 }),
    }))
    expect(d).not.toBe(baseDigest)
  })
  it('другой tenant → другой digest', () => {
    const d = computeDigest(buildApprovalSnapshot({
      ...baseAction,
      scope: mkScope({ tenant: 'acct-y' }),
    }))
    expect(d).not.toBe(baseDigest)
  })
  it('другой origin → другой digest', () => {
    const d = computeDigest(buildApprovalSnapshot({
      ...baseAction,
      scope: mkScope({ origin: 'evil.com' }),
    }))
    expect(d).not.toBe(baseDigest)
  })
  it('другой elementRef → другой digest', () => {
    const d = computeDigest(buildApprovalSnapshot({
      ...baseAction,
      scope: mkScope({ elementRef: 'btn-different' }),
    }))
    expect(d).not.toBe(baseDigest)
  })
  it('другой actionType → другой digest', () => {
    const d = computeDigest(buildApprovalSnapshot({ ...baseAction, actionType: 'type_text' }))
    expect(d).not.toBe(baseDigest)
  })
  it('другой payload → другой digest', () => {
    const d = computeDigest(buildApprovalSnapshot({
      ...baseAction,
      payload: { elementRef: 'btn-submit', action: 'save' },
    }))
    expect(d).not.toBe(baseDigest)
  })
  it('другой risk → другой digest', () => {
    const d = computeDigest(buildApprovalSnapshot({ ...baseAction, risk: 'R2' }))
    expect(d).not.toBe(baseDigest)
  })
  it('изменение expectedPostcondition → другой digest', () => {
    const d = computeDigest(buildApprovalSnapshot({
      ...baseAction,
      expectedPostcondition: { urlContains: '/report/other' },
    }))
    expect(d).not.toBe(baseDigest)
  })
})

describe('verifyDigest — cross-scope rejection (BR-017 п.6, §10.5)', () => {
  const baseDigest = computeDigest(buildApprovalSnapshot(baseAction))

  it('matching snapshot → ok', () => {
    expect(verifyDigest(buildApprovalSnapshot(baseAction), baseDigest)).toBe(true)
  })
  it('scope клиента A не подходит к approval клиента B (clientId mismatch)', () => {
    const otherClientSnapshot = buildApprovalSnapshot({ ...baseAction, clientId: 'client-B' })
    expect(verifyDigest(otherClientSnapshot, baseDigest)).toBe(false)
  })
  it('старая observation version отклоняется', () => {
    const staleSnapshot = buildApprovalSnapshot({
      ...baseAction,
      scope: mkScope({ observationVersion: 99 }),
    })
    expect(verifyDigest(staleSnapshot, baseDigest)).toBe(false)
  })
})

describe('checkPreconditions — stale scope rejection', () => {
  it('expectedOrigin совпадает → ok', () => {
    const r = checkPreconditions(
      { expectedOrigin: 'calltouch.com' },
      { origin: 'calltouch.com' }
    )
    expect(r.ok).toBe(true)
  })
  it('expectedOrigin не совпадает → fail (origin drift)', () => {
    const r = checkPreconditions(
      { expectedOrigin: 'calltouch.com' },
      { origin: 'evil.com' }
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('origin')
  })
  it('observationVersion не совпадает → fail (refs invalidation)', () => {
    const r = checkPreconditions(
      { expectedObservationVersion: 5 },
      { observationVersion: 6 }
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('observationVersion')
  })
  it('tenant сменился → fail', () => {
    const r = checkPreconditions(
      { expectedTenant: 'acct-x' },
      { tenant: 'acct-y' }
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('tenant')
  })
  it('account сменился → fail', () => {
    const r = checkPreconditions(
      { expectedAccount: 'user@x' },
      { account: 'user@y' }
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('account')
  })
  it('expectedUrlPattern не найден в URL → fail', () => {
    const r = checkPreconditions(
      { expectedUrlPattern: '/report' },
      { url: 'https://calltouch.com/dashboard' }
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('URL')
  })
  it('без preconditions → ok', () => {
    const r = checkPreconditions({}, { origin: 'anywhere.com' })
    expect(r.ok).toBe(true)
  })
})

describe('checkScopeAlignment — approval scope vs action scope (BR-017 п.6)', () => {
  const approvalSnapshot = buildApprovalSnapshot(baseAction)

  it('matching scope → ok', () => {
    const r = checkScopeAlignment(
      { browserTaskId: 'bt-1', runId: 'run-1', scope: mkScope() },
      { snapshot: approvalSnapshot }
    )
    expect(r.ok).toBe(true)
  })
  it('другой browserTaskId → fail (cross-task)', () => {
    const r = checkScopeAlignment(
      { browserTaskId: 'bt-2', runId: 'run-1', scope: mkScope({ browserTaskId: 'bt-2' }) },
      { snapshot: approvalSnapshot }
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('browserTaskId')
  })
  it('другой runId → fail (stale run после handoff)', () => {
    const r = checkScopeAlignment(
      { browserTaskId: 'bt-1', runId: 'run-2', scope: mkScope({ runId: 'run-2' }) },
      { snapshot: approvalSnapshot }
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('runId')
  })
  it('другой tenant → fail', () => {
    const r = checkScopeAlignment(
      { browserTaskId: 'bt-1', runId: 'run-1', scope: mkScope({ tenant: 'other' }) },
      { snapshot: approvalSnapshot }
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('tenant')
  })
  it('observationVersion не совпадает → fail (refs stale)', () => {
    const r = checkScopeAlignment(
      { browserTaskId: 'bt-1', runId: 'run-1', scope: mkScope({ observationVersion: 99 }) },
      { snapshot: approvalSnapshot }
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('observationVersion')
  })
})

describe('constantTimeEqual — timing-safe сравнение', () => {
  it('равные строки → true', () => {
    expect(constantTimeEqual('sha256:abc', 'sha256:abc')).toBe(true)
  })
  it('разные строки → false', () => {
    expect(constantTimeEqual('sha256:abc', 'sha256:abd')).toBe(false)
  })
  it('разная длина → false', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
  })
  it('пустые строки → true', () => {
    expect(constantTimeEqual('', '')).toBe(true)
  })
})

describe('buildDigest — полный объект для UI/аудита', () => {
  it('возвращает actionId + digest + snapshot', () => {
    const d = buildDigest(baseAction)
    expect(d.actionId).toBe('a-1')
    expect(d.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(d.snapshot.browserTaskId).toBe('bt-1')
    expect(d.snapshot.actionType).toBe('click')
    expect(d.snapshot.risk).toBe('R3')
  })
})

describe('RED: reused/consumed approval rejection (BR-017 п.7)', () => {
  // Эти свойства контролирует storage-layer consumeApproval; здесь только
  // проверяем что digest стабилен — controller будет сверять его.
  it('повторное использование того же digest для другого actionId не разрешается контроллером', () => {
    const d1 = buildDigest(baseAction)
    const d2 = buildDigest({ ...baseAction, actionId: 'a-2' })
    // actionId НЕ входит в digest (это не «что» мы делаем, это id записи). Но
    // controller при consume сверяет что actionId из approval соответствует
    // actionId из action — это отдельная проверка.
    expect(d1.digest).toBe(d2.digest) // одинаковый контент → одинаковый digest
    // Но controller использует actionId отдельно — он не даст применить digest
    // от a-1 к a-2. См. controller.ts.
  })
})
