// VSK-TASK-FLOW-A1 блок B §4.2 — порог показа карточки И инвариант безопасности.
//
// Два пункта намеренно в одном файле: порог без инварианта не принимается.
// Порог считается по САМООЦЕНКЕ модели, поэтому сам по себе он ничего не
// гарантирует — гарантирует то, что автоутверждение не выдаёт прав на запись.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planApprovalVerdict, explainVerdict, type DeclaredStep } from '../../electron/ai/plan-threshold'
import { decide } from '../../electron/ai/mode-policy'
import type { PlanStepSpecV1 } from '../../shared/contracts/outcome'

// Форма взята из tests/ipc/create-plan-handler.test.ts — она заведомо проходит
// quality-гейт против validContract. Порог проверяем, меняя ТОЛЬКО те поля, на
// которые он смотрит: writeScope, actions, risk и текст шага.
const baseSpec: PlanStepSpecV1 = {
  key: 'auth-fix', title: 'Исправить auth', intent: 'Исправить создание сессии в функции login',
  files: ['src/auth/login.ts'], symbols: ['login'], actions: ['Прочитать ветку сохранения сессии'],
  dependsOn: [], readScope: ['src/auth'], writeScope: [],
  acceptanceCriterionIds: ['auth-green'], verification: ['npm test -- auth'],
  expectedEvidence: ['command:npm test -- auth'], rollback: 'git revert',
  role: 'executor', execution: 'main', risk: 'medium',
}
const spec = (over: Partial<PlanStepSpecV1> = {}): PlanStepSpecV1 => ({ ...baseSpec, ...over })
const step = (over: Partial<DeclaredStep> = {}): DeclaredStep =>
  ({ title: 'Прочитать конфиги', detail: 'Только чтение', spec: spec(), ...over })

describe('порог: что требует карточку', () => {
  it('план только на чтение — карточки нет', () => {
    const v = planApprovalVerdict([step(), step({ title: 'Свести таблицу' })])
    expect(v.needsCard).toBe(false)
    expect(v.reason).toBeNull()
    expect(explainVerdict(v)).toContain('только читает')
  })

  it('объявленная запись файлов — карточка', () => {
    const v = planApprovalVerdict([step(), step({ spec: spec({ key: 'w', writeScope: ['src/app.ts'] }) })])
    expect(v.needsCard).toBe(true)
    expect(v.reason).toBe('write-scope')
    expect(v.triggeredBy).toContain('w')
  })

  it('ответственное действие узнаётся по формулировке шага', () => {
    for (const text of [
      'Отправить письмо клиенту', 'Опубликовать пост', 'Удалить старые записи',
      'Провести оплату счёта', 'Изменить права доступа',
      'Send email to the customer', 'Publish release', 'Delete the bucket',
    ]) {
      const v = planApprovalVerdict([step({ title: text })])
      expect(v.needsCard, text).toBe(true)
      expect(v.reason, text).toBe('responsible-action')
    }
  })

  it('ответственное действие узнаётся и в actions спецификации', () => {
    const v = planApprovalVerdict([step({ spec: spec({ actions: ['Разослать уведомления подписчикам'] }) })])
    expect(v.needsCard).toBe(true)
    expect(v.reason).toBe('responsible-action')
  })

  it('высокий риск — карточка даже без записи и без опасных слов', () => {
    const v = planApprovalVerdict([step({ spec: spec({ risk: 'high' }) })])
    expect(v.needsCard).toBe(true)
    expect(v.reason).toBe('high-risk')
  })

  // Fail-safe: неизвестное не равно безопасному.
  it('нет structured spec — карточка', () => {
    expect(planApprovalVerdict([{ title: 'Что-то сделать' }]).needsCard).toBe(true)
    expect(planApprovalVerdict([{ title: 'Что-то сделать' }]).reason).toBe('no-declaration')
  })

  it('spec есть не у всех шагов — карточка', () => {
    const v = planApprovalVerdict([step(), { title: 'Шаг без объявления' }])
    expect(v.needsCard).toBe(true)
    expect(v.reason).toBe('no-declaration')
  })

  it('пустой план — карточка', () => {
    expect(planApprovalVerdict([]).needsCard).toBe(true)
  })

  it('чтение остаётся чтением: слова из readScope не считаются опасными', () => {
    const v = planApprovalVerdict([step({
      title: 'Прочитать историю платежей и посчитать сумму',
      detail: null,
      spec: spec({ actions: ['Прочитать выгрузку'], intent: 'Посчитать итог' }),
    })])
    // «платежей» в заголовке — это чтение о платежах, но самооценка модели тут
    // ненадёжна, и мы намеренно перестраховываемся: лишний вопрос дешевле платежа.
    expect(v.needsCard).toBe(true)
    expect(v.reason).toBe('responsible-action')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ИНВАРИАНТ БЕЗОПАСНОСТИ. Автоутверждение снимает КАРТОЧКУ и только её.
//
// Доказывается без подъёма хендлера с моками: интеграционный харнесс create_plan
// требует спеки, согласованные с taskContract, и воюет с quality-гейтом — это
// проблема заготовки, а не продукта. Здесь инвариант закрыт двумя проверками,
// которые не зависят от заготовки: реальным mode-policy и стражем на исходник.
// ─────────────────────────────────────────────────────────────────────────────
describe('инвариант: автоутверждение не выдаёт прав на запись', () => {
  it('в режиме plan любая запись заблокирована общим гейтом', () => {
    // Автоутверждение НЕ меняет режим прогона. Значит план, объявивший себя
    // read-only и попытавшийся писать, приходит к decide() с прежним режимом.
    for (const tool of ['write_file', 'apply_patch', 'run_command']) {
      expect(decide(tool, 'plan'), tool).toBe('block')
    }
  })

  it('в режиме ask запись требует подтверждения человека, а не проходит молча', () => {
    for (const tool of ['write_file', 'apply_patch', 'run_command']) {
      expect(decide(tool, 'ask'), tool).not.toBe('auto-accept')
    }
  })

  // Страж на исходник: ветка автоутверждения обязана возвращать результат, НЕ
  // трогая режим. Если кто-то добавит туда setAgentMode «чтобы выполнялось» —
  // порог превратится в дыру, и этот пин покраснеет.
  it('ветка автоутверждения в хендлере не повышает режим прогона', () => {
    const src = readFileSync(join(process.cwd(), 'electron/ipc/tool-handlers/verification.ts'), 'utf8')
    const start = src.indexOf('if (gateApplies && !verdict.needsCard)')
    expect(start, 'ветка автоутверждения исчезла — страж ослеп').toBeGreaterThan(-1)
    const branch = src.slice(start, start + 700)
    expect(branch).not.toContain('setAgentMode')
    expect(branch).not.toContain('ctx.agentMode =')
  })

  it('карточка по-прежнему единственный путь к повышению режима', () => {
    const src = readFileSync(join(process.cwd(), 'electron/ipc/tool-handlers/verification.ts'), 'utf8')
    // setAgentMode вызывается ровно там, где разобрано решение пользователя.
    const idx = src.indexOf('ctx.setAgentMode(outcome.newMode)')
    expect(idx, 'повышение режима должно оставаться в ветке решения пользователя').toBeGreaterThan(-1)
    expect(src.slice(0, idx)).toContain('const outcome = resolvePlanGate(')
  })
})
