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

  // ПИН ПЕРЕПИСАН (долг ревью 28.07, пункт 5) — объявляю прямо. Прежняя
  // формулировка «spec есть не у всех шагов — карточка» стерегла ОТМЕНЁННЫЙ
  // контракт: после живого порога §4.2 неполнота spec сама по себе карточку не
  // требует — шаг без объявления судится по тексту. Зелёным пин оставался по
  // СЛУЧАЙНОСТИ фикстуры: «Шаг без объявления» не содержит ни признака записи,
  // ни признака чтения, то есть неопределим и даёт карточку по другой причине.
  // Проверяем теперь именно это правило, и обе его стороны.
  it('шаг без spec судится по тексту: неопределимый — карточка, пишущий — карточка', () => {
    const undecidable = planApprovalVerdict([step(), { title: 'Шаг без объявления' }])
    expect(undecidable.needsCard).toBe(true)
    expect(undecidable.reason).toBe('no-declaration')

    const writing = planApprovalVerdict([step(), { title: 'Записать отчёт в out.csv' }])
    expect(writing.needsCard).toBe(true)
    expect(writing.reason, 'пишущий шаг без spec обязан давать write-scope').toBe('write-scope')
  })

  it('шаг без spec, но явно читающий, карточки НЕ требует', () => {
    const v = planApprovalVerdict([step(), { title: 'Прочитать логи и объяснить причину' }])
    expect(v.needsCard, 'неполнота spec сама по себе больше не повод для карточки').toBe(false)
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

  // ПИН ПЕРЕПИСАН (позиция 1 ревью 28.07), и это объявлено прямо: прежнее
  // утверждение — «ветка автоутверждения НЕ трогает режим» — стерегло ОТМЕНЁННЫЙ
  // контракт. Именно оно делало дыру легальной: в режиме accept-edits правки
  // проходят автоматически, поэтому «не тронуть режим» означало отдать запись
  // без единого клика по плану, который никто не утверждал. Теперь ветка обязана
  // ПОНИЖАТЬ права, а не оставлять их. Инвариант «хендлер не повышает режим»
  // не ослаб — он ниже, отдельным пином, и стал строже.
  //
  // Поведенческое доказательство запрета живёт в
  // tests/ipc/plan-autoapprove-write-gate.test.ts: там настоящий writeFileHandler
  // и проверка по файловой системе. Здесь — только форма реализации.
  it('ветка автоутверждения ПОНИЖАЕТ права прогона', () => {
    const src = readFileSync(join(process.cwd(), 'electron/ipc/tool-handlers/verification.ts'), 'utf8')
    const start = src.indexOf('if (gateApplies && !verdict.needsCard)')
    expect(start, 'ветка автоутверждения исчезла — страж ослеп').toBeGreaterThan(-1)
    const branch = src.slice(start, start + 900)
    expect(branch, 'без понижения прав автоутверждение отдаёт запись без клика').toContain("lowerRunMode(ctx, 'ask')")
  })

  // ПИН ПЕРЕПИСАН при переносе ожидания наружу прогона (§10). Раньше он держал
  // «повышение режима живёт в ветке решения пользователя» — но решение больше не
  // принимается внутри хендлера, и той ветки в файле нет. Инвариант от этого не
  // ослаб, а усилился: хендлер теперь НЕ УМЕЕТ повышать режим вообще, ни в одной
  // ветке. Единственный setAgentMode здесь — понижение до 'plan'.
  it('хендлер не умеет повышать режим: смена прав идёт ТОЛЬКО через понижение', () => {
    const src = readFileSync(join(process.cwd(), 'electron/ipc/tool-handlers/verification.ts'), 'utf8')
    // Форма изменилась (позиция 1): вместо двух прямых записей режима — одна
    // функция `lowerRunMode`, которая по построению не повышает (сравнивает
    // строгость и выходит). Утверждение то же и сильнее: прямых назначений
    // режима в файле не осталось вовсе.
    const direct = src.match(/ctx\.setAgentMode\?\?\(|ctx\.agentMode = '(?!plan|ask)/g) ?? []
    expect(direct.length, 'прямое назначение режима мимо lowerRunMode').toBe(0)
    for (const raising of ['accept-edits', 'auto', 'bypass']) {
      expect(src, `режим ${raising} не должен назначаться в create_plan`).not.toContain(`setAgentMode('${raising}')`)
      expect(src, `режим ${raising} не должен назначаться в create_plan`).not.toContain(`lowerRunMode(ctx, '${raising}')`)
    }
    // Понижение возможно ровно в две цели, и обе строже исходной.
    const lowered = src.match(/lowerRunMode\(ctx, '(\w[\w-]*)'\)/g) ?? []
    expect(new Set(lowered)).toEqual(new Set(["lowerRunMode(ctx, 'plan')", "lowerRunMode(ctx, 'ask')"]))
  })
})
