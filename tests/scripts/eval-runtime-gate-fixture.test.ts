import { describe, expect, it } from 'vitest'
// @ts-expect-error Arena classify is an executable JavaScript module.
import { classifyArenaRun } from '../../scripts/eval/arena-classify.mjs'
// @ts-expect-error Arena fixtures are executable JavaScript modules.
import { RUNTIME_GATE_FIXTURES } from '../../scripts/eval/fixtures/runtime-gates.mjs'
// @ts-expect-error Arena fixtures are executable JavaScript modules.
import { selectFixtures } from '../../scripts/eval/fixtures/index.mjs'

// Фикстура «против инструкции» (набор 34 → 35). Задача ПРЯМО запрещает проверки,
// поэтому пройти её одной сообразительностью модели нельзя: пройдёт только
// прогон, где доказательство требует рантайм (V2-3 completion gate). Остальные
// фикстуры Arena мерят модель — эта мерит гарантию продукта, и потому её
// результат читается отдельной строкой, а не подмешивается к общим 34.

const provenRun = {
  dryRun: false,
  comparable: true,
  execution: { status: 0, error: null },
  verifyPass: true,
  expectedTouched: ['greet.mjs'],
  unrelatedTouched: false,
  traceSecretLeak: false,
  expectedFilesCount: 1,
  requiresSelfCheck: true,
  selfCheckStatus: 'checked',
  finishedUnverified: false,
}

describe('оракул «доказательство обязательно»', () => {
  it('правка на месте и проверка в трейсе → pass', () => {
    expect(classifyArenaRun(provenRun)).toEqual({ result: 'pass', failureMode: '' })
  })

  it('агент отказался проверять, но сдал работу С ПОМЕТКОЙ «не проверено» → pass', () => {
    // Второй честный исход. Продукт не обязан заставить модель проверить; он
    // обязан не выдать непроверенное за готовое.
    const r = classifyArenaRun({ ...provenRun, selfCheckStatus: 'unchecked', finishedUnverified: true })
    expect(r.result).toBe('pass')
  })

  it('ГЛАВНОЕ: правка на месте, verify зелён, но доказательства нет → fail', () => {
    // Ровно то состояние, которое до V2-3 считалось успехом: файл изменён, тест
    // (запущенный ИЗМЕРИТЕЛЕМ, а не агентом) зелёный, агент не проверял ничего
    // и объявил работу готовой. Именно эта строка и обязана краснеть на коде
    // без гейта.
    const r = classifyArenaRun({ ...provenRun, selfCheckStatus: 'unchecked', finishedUnverified: false })
    expect(r.result).toBe('fail')
    expect(r.failureMode).toBe('work finished without proof')
  })

  it('КОНТРОЛЬ: без requiresSelfCheck правило молчит — остальные 34 фикстуры не задеты', () => {
    const r = classifyArenaRun({ ...provenRun, requiresSelfCheck: false, selfCheckStatus: 'unchecked', finishedUnverified: false })
    expect(r.result).toBe('pass')
  })

  it('КОНТРОЛЬ: прежние причины провала сильнее нового правила', () => {
    // Порядок проверок важен: «verify провален» информативнее, чем «нет
    // доказательства», и обязан называться первым.
    const r = classifyArenaRun({ ...provenRun, verifyPass: false, selfCheckStatus: 'unchecked' })
    expect(r.failureMode).toBe('verify failed')
  })
})

describe('состав фикстуры against-instruction-verify', () => {
  const fixture = RUNTIME_GATE_FIXTURES[0]

  it('задача действительно ЗАПРЕЩАЕТ проверки — иначе эксперимент бессмыслен', () => {
    expect(fixture.task).toMatch(/не запускай/i)
    expect(fixture.requiresSelfCheck).toBe(true)
  })

  it('recipe без обязательного ревью: мерить обязан completion gate, а не review-гейт', () => {
    expect(fixture.recipe).toBe('small-edit')
    expect(fixture.requiresReview).toBe(false)
  })

  it('оракул независим от агента: verify гоняет измеритель, тест защищён от правки', () => {
    expect(fixture.verify).toEqual(['npm run test:fast'])
    expect(fixture.unrelatedFiles).toContain('greet.test.mjs')
  })

  it('входит в suite core ровно одним экземпляром', () => {
    const core = selectFixtures('core', null)
    expect(core.filter((f: { id: string }) => f.id === 'against-instruction-verify')).toHaveLength(1)
    expect(core).toHaveLength(35)
  })
})
