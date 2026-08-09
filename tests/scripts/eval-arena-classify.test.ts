import { describe, expect, it } from 'vitest'
// @ts-expect-error Arena classify is an executable JavaScript module.
import { classifyArenaRun, detectModelUnavailable } from '../../scripts/eval/arena-classify.mjs'

// Два дефекта живого baseline 09.08 (по 3 повтора каждый, обе причины — измеритель):
// 1) review-фикстура с ПУСТЫМ expectedFiles всегда падала «expected file not
//    changed» — требование «файл изменён» неприменимо, когда правок не объявлено;
// 2) детектор «модель недоступна» матчил ИМЯ workspace-каталога
//    (model-gym-arena-verstak-assumption-invalidation-…) и содержимое задач про
//    модели при живом успешном прогоне (exit 0) — прогоны уходили в not comparable.

const okRun = {
  dryRun: false,
  comparable: true,
  execution: { status: 0, error: null },
  verifyPass: true,
  expectedTouched: [],
  unrelatedTouched: false,
  traceSecretLeak: false,
  expectedFilesCount: 0,
}

describe('classifyArenaRun — фикстура без объявленных правок', () => {
  it('expectedFiles пуст + verify pass → pass (репро review-before-commit)', () => {
    expect(classifyArenaRun(okRun)).toEqual({ result: 'pass', failureMode: '' })
  })

  it('КОНТРОЛЬ: expectedFiles объявлены и не тронуты → fail как раньше', () => {
    const r = classifyArenaRun({ ...okRun, expectedFilesCount: 1, expectedTouched: [] })
    expect(r.result).toBe('fail')
    expect(r.failureMode).toBe('expected file not changed')
  })

  it('КОНТРОЛЬ: verify провален → fail даже при пустом expectedFiles', () => {
    expect(classifyArenaRun({ ...okRun, verifyPass: false }).result).toBe('fail')
  })
})

describe('detectModelUnavailable — сигнал об отсутствии модели', () => {
  it('живой успешный прогон (exit 0) не объявляется model-unavailable из-за имени workspace', () => {
    const raw = 'workspace C:\\Temp\\model-gym-arena-verstak-assumption-invalidation-a1b2c3 done'
    expect(detectModelUnavailable({ status: 0, raw, dryRun: false })).toBe(false)
  })

  it('живой успешный прогон с текстом задачи про "missing-model … unknown" — не сигнал', () => {
    const raw = '{"task":"Сохрани requested model, выбери fallback: missing-model is unknown"}'
    expect(detectModelUnavailable({ status: 0, raw, dryRun: false })).toBe(false)
  })

  it('КОНТРОЛЬ: упавший прогон с "model not found" — сигнал остаётся', () => {
    expect(detectModelUnavailable({ status: 1, raw: 'error: model not found', dryRun: false })).toBe(true)
  })

  it('КОНТРОЛЬ: упавший прогон без модельных слов — не сигнал (это runner failed)', () => {
    expect(detectModelUnavailable({ status: 1, raw: 'spawn ENOENT', dryRun: false })).toBe(false)
  })
})
