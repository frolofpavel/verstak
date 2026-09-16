import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyResponsibleComputerTarget } from '../../../electron/ai/responsible-action'

function hasMainOwnedSemanticGate(source: string): boolean {
  const gate = source.match(/if\s*\(element\s*&&\s*classifyResponsibleComputerTarget\s*\(\s*\{[\s\S]*?\}\s*\)\.responsible\s*\)[\s\S]*?\n\s*\}/u)?.[0] ?? ''
  return /role:\s*element\.backend\.role/u.test(gate)
    && /label:\s*element\.backend\.label/u.test(gate)
    && /state:\s*element\.backend\.state/u.test(gate)
    && /finalizeBlocked\s*\([^)]*'responsible-action-confirmation-required'/u.test(gate)
    && !/\binput\./u.test(gate)
}

describe('responsible Computer target classifier', () => {
  it.each([
    ['Button', 'Delete', '', 'delete'],
    ['Button', 'Remove permanently', '', 'delete'],
    ['Button', 'Permanent removal', '', 'delete'],
    ['Button', 'Remove for good', '', 'delete'],
    ['Button', 'Удалить безвозвратно', '', 'delete'],
    ['Button', 'Опубликовать', '', 'publish'],
    ['Button', 'Release', '', 'publish'],
    ['Button', 'Выпустить', '', 'publish'],
    ['Button', 'Send', '', 'send'],
    ['Button', 'Submit application', '', 'send'],
    ['Button', 'Share', '', 'send'],
    ['Button', 'Поделиться', '', 'send'],
    ['Button', 'Оплатить', '', 'payment'],
    ['Button', 'Buy now', '', 'payment'],
    ['Button', 'Transfer', '', 'payment'],
    ['Button', 'Перевести', '', 'payment'],
    ['Button', 'Перевод', '', 'payment'],
    ['Button', 'Grant access', '', 'permissions'],
    ['Button', 'Allow permissions', '', 'permissions'],
    ['Button', 'Продолжить', 'Disable protection', 'permissions'],
    ['SelectionItem', 'Public network', 'not-selected', 'permissions'],
    ['SelectionItem', 'Публичная сеть', 'not-selected', 'permissions'],
    ['SelectionItem', 'Anyone with the link', 'not-selected', 'permissions'],
    ['SelectionItem', 'Все, у кого есть ссылка', 'not-selected', 'permissions'],
    ['Toggle', 'Administrator', 'off', 'permissions'],
    ['Toggle', 'Администратор', 'off', 'permissions'],
    ['Toggle', 'Auto-renew', 'off', 'payment'],
    ['Toggle', 'Автопродление', 'off', 'payment'],
  ] as const)('classifies backend semantic fields: %s / %s / %s', (role, label, state, kind) => {
    expect(classifyResponsibleComputerTarget({ role, label, state })).toEqual({
      responsible: true,
      kind,
      why: expect.any(String),
    })
  })

  it.each([
    ['Toggle', 'Grid lines', 'off'],
    ['SelectionItem', 'Compact view', 'selected'],
    ['Toggle', 'Allowance', 'off'],
    ['SelectionItem', 'Granted total', 'not selected'],
    ['Toggle', 'Allowed file types', 'off'],
    ['SelectionItem', 'Grant summary', 'not selected'],
    ['Button', 'Remove filter', 'enabled'],
    ['Button', 'Publisher settings', 'enabled'],
  ])('does not promote harmless UI semantics: %s / %s / %s', (role, label, state) => {
    expect(classifyResponsibleComputerTarget({ role, label, state }))
      .toEqual({ responsible: false })
  })

  it('mutation-pins the main-owned resolved-element gate against model-argument classification', () => {
    const source = readFileSync(join(process.cwd(), 'electron', 'ai', 'computer', 'controller.ts'), 'utf8')
    expect(hasMainOwnedSemanticGate(source)).toBe(true)

    const modelArgumentMutation = source.replace(
      'label: element.backend.label',
      "label: input.text ?? ''",
    )
    expect(modelArgumentMutation).not.toBe(source)
    expect(hasMainOwnedSemanticGate(modelArgumentMutation)).toBe(false)

    const removedGateMutation = source.replace(
      "return finalizeBlocked(actionId, browserTaskId, 'responsible-action-confirmation-required')",
      'return plainResult(actionId, \'verified\', \'bypassed\')',
    )
    expect(removedGateMutation).not.toBe(source)
    expect(hasMainOwnedSemanticGate(removedGateMutation)).toBe(false)
  })
})
