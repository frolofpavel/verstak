// Workflow Scientist: заметить дорогой или проваленный workflow, выдвинуть
// гипотезу с ОДНИМ изменённым фактором, сравнить и дать рекомендацию.
//
// Опасность здесь не в неверном совете, а в самовольстве: система, которая сама
// повышает права, включает скилл или ставит себе зачёт, перестаёт быть
// исследователем. Поэтому запреты проверяются наравне с расчётами.
import { describe, it, expect } from 'vitest'
import {
  detectProblem,
  buildHypothesis,
  compareRuns,
  MIN_SAMPLES,
  type WorkflowSample,
} from '../../shared/contracts/experiment'

const sample = (over: Partial<WorkflowSample> = {}): WorkflowSample => ({
  runId: 'r1',
  providerId: 'verstak-gateway',
  model: 'kimi-k2.7-code',
  taskType: 'bugfix',
  succeeded: true,
  costCents: 10,
  durationMs: 60_000,
  verificationPassed: true,
  ...over,
})

const many = (n: number, over: Partial<WorkflowSample> = {}) =>
  Array.from({ length: n }, (_, i) => sample({ runId: `r${i}`, ...over }))

describe('детектор не срабатывает на пустом месте', () => {
  it('мало наблюдений — вывода нет, даже если всё плохо', () => {
    const few = many(MIN_SAMPLES - 1, { succeeded: false, costCents: 500 })
    expect(detectProblem(few)).toBeNull()
  })

  it('здоровый и дешёвый workflow проблемой не объявляется', () => {
    expect(detectProblem(many(MIN_SAMPLES + 5))).toBeNull()
  })

  // Ключ группы собирается из ДВУХ строк, пришедших извне. Пока он был склейкой
  // через разделитель, пара «класс + модель» могла совпасть у разных групп, и они
  // слились бы молча — вывод был бы про несуществующую смесь.
  it('группы не склеиваются, даже если разделитель встречается в самих значениях', () => {
    const tricky = [
      ...many(MIN_SAMPLES + 5, { taskType: 'fix', model: 'a b', costCents: 900 }),
      ...many(MIN_SAMPLES + 5, { taskType: 'fix a', model: 'b', costCents: 10 }),
    ]
    const problem = detectProblem(tricky)!
    // Слились бы — размер группы стал бы двойным, а средняя цена смешанной.
    expect(problem.sampleSize).toBe(MIN_SAMPLES + 5)
    expect(problem.currentModel).toBe('a b')
  })

  it('разные типы задач не смешиваются в один вывод', () => {
    const mixed = [
      ...many(MIN_SAMPLES, { taskType: 'bugfix' }),
      ...many(MIN_SAMPLES, { taskType: 'review', succeeded: false, costCents: 400 }),
    ]
    const problem = detectProblem(mixed)
    expect(problem?.taskType).toBe('review')
  })
})

describe('детектор называет, ЧТО именно плохо', () => {
  it('низкая доля успеха замечена и названа', () => {
    const bad = many(MIN_SAMPLES + 5, { succeeded: false, verificationPassed: false })
    const problem = detectProblem(bad)!
    expect(problem.currentModel).toBe('kimi-k2.7-code')
    expect(problem.why).toMatch(/успех|провал/i)
    expect(problem.successRate).toBeLessThan(0.5)
  })

  it('дорогой, но успешный workflow замечен по цене, а не по провалам', () => {
    const pricey = many(MIN_SAMPLES + 5, { costCents: 900 })
    const problem = detectProblem(pricey)!
    expect(problem.why).toMatch(/дорог|расход|цен/i)
    expect(problem.successRate).toBe(1)
  })

  // Контроль: тот же объём наблюдений при нормальных цифрах обязан молчать —
  // иначе пины выше зелены и у детектора, который жалуется всегда.
  it('контроль: тот же объём при нормальных цифрах молчит', () => {
    expect(detectProblem(many(MIN_SAMPLES + 5))).toBeNull()
  })
})

describe('гипотеза меняет ровно ОДИН фактор', () => {
  const problem = () => detectProblem(many(MIN_SAMPLES + 5, { costCents: 900 }))!

  it('план объявляет один изменённый фактор и его значения', () => {
    const plan = buildHypothesis(problem(), ['deepseek-chat'])!
    expect(plan.changedFactor).toBe('model')
    expect(plan.baseline).toBe('kimi-k2.7-code')
    expect(plan.candidate).toBe('deepseek-chat')
    expect(plan.hypothesis.length).toBeGreaterThan(10)
  })

  it('кандидат, равный текущему, гипотезой не является', () => {
    expect(buildHypothesis(problem(), ['kimi-k2.7-code'])).toBeNull()
  })

  it('без кандидатов гипотезы нет — выдумывать модель нельзя', () => {
    expect(buildHypothesis(problem(), [])).toBeNull()
  })

  it('план несёт повторы и набор задач: один прогон вердиктом не бывает', () => {
    const plan = buildHypothesis(problem(), ['deepseek-chat'])!
    expect(plan.repeats).toBeGreaterThan(1)
    expect(plan.taskSet).toBe('bugfix')
  })
})

describe('сравнение и рекомендация', () => {
  const before = many(MIN_SAMPLES + 5, { costCents: 900, durationMs: 120_000 })
  const better = many(MIN_SAMPLES + 5, { costCents: 300, durationMs: 90_000, model: 'deepseek-chat' })
  const worse = many(MIN_SAMPLES + 5, { costCents: 1500, durationMs: 200_000, model: 'deepseek-chat', succeeded: false, verificationPassed: false })

  it('кандидат дешевле и не хуже — рекомендация к продвижению', () => {
    const r = compareRuns('модель дешевле', 'model', 'kimi-k2.7-code', 'deepseek-chat', 'bugfix', 3, before, better)
    expect(r.recommendation).toBe('promote')
    expect(r.costAfter).toBeLessThan(r.costBefore)
    expect(r.confidence).toBeGreaterThan(0)
  })

  it('кандидат хуже — рекомендация отклонить, а не «попробовать ещё»', () => {
    const r = compareRuns('модель дешевле', 'model', 'kimi-k2.7-code', 'deepseek-chat', 'bugfix', 3, before, worse)
    expect(r.recommendation).toBe('reject')
  })

  // Цена не перевешивает качество: дешёвый кандидат, который стал чаще ошибаться,
  // продвигать нельзя — иначе «экономия» оплачивается чужой работой по разбору.
  it('дешевле, но с падением качества — не продвигать', () => {
    const cheapButWorse = many(MIN_SAMPLES + 5, { costCents: 100, model: 'deepseek-chat', succeeded: false, verificationPassed: false })
    const r = compareRuns('дешевле', 'model', 'kimi-k2.7-code', 'deepseek-chat', 'bugfix', 3, before, cheapButWorse)
    expect(r.recommendation).not.toBe('promote')
  })

  it('мало наблюдений — вердикта нет, а не слабый вердикт', () => {
    const r = compareRuns('модель дешевле', 'model', 'a', 'b', 'bugfix', 1, before.slice(0, 2), better.slice(0, 2))
    expect(r.recommendation).toBe('insufficient')
  })
})

describe('учёный не имеет права решать сам', () => {
  const before = many(MIN_SAMPLES + 5, { costCents: 900 })
  const after = many(MIN_SAMPLES + 5, { costCents: 200, model: 'deepseek-chat' })
  const result = () => compareRuns('дешевле', 'model', 'kimi-k2.7-code', 'deepseek-chat', 'bugfix', 3, before, after)

  // Прямое требование постановки и главная граница этого слоя.
  it('итог всегда помечен как НЕ применённый автоматически', () => {
    expect(result().autoApplied).toBe(false)
  })

  it('даже рекомендация к продвижению остаётся рекомендацией', () => {
    const r = result()
    expect(r.recommendation).toBe('promote')
    expect(r.autoApplied).toBe(false)
    expect(r.appliedAt).toBeNull()
  })

  // Контроль: поле должно быть настоящим, а не константой в тесте — проверяем,
  // что итог вообще несёт эти поля и они не выдуманы вызывающим.
  it('контроль: итог несёт весь набор полей эксперимента', () => {
    const r = result()
    for (const key of [
      'hypothesis', 'baseline', 'changedFactor', 'candidate', 'taskSet', 'repeats',
      'successRateBefore', 'successRateAfter', 'costBefore', 'costAfter',
      'latencyBefore', 'latencyAfter', 'verificationBefore', 'verificationAfter',
      'recommendation', 'confidence', 'createdAt',
    ]) {
      expect(r, key).toHaveProperty(key)
    }
  })
})
