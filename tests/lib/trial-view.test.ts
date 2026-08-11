// P1 шаг 3: чистые хелперы панели состязания (src/lib/trial-view.ts).
//
// Что стерегут пины:
//  · финиш попытки ставит ПАНЕЛЬ: терминальный runStatus при attempt.status
//    'running' даёт патч финиша; живой прогон и уже закрытая попытка — НЕ дают
//    (контрольные кейсы «происходит»/«не происходит» рядом, §3.1);
//  · модель разрешается ЯВНО до запуска: оценка и прогон смотрят на одну и ту же
//    модель, конкурент без модели — честный отказ, не угадайка;
//  · неизвестная цена — СЛОВО «неизвестна», не ноль и не тариф;
//  · допущение объёма оценки показывается рядом с центами (400 тыс. / 30 тыс.).
import { describe, it, expect } from 'vitest'
import {
  attemptFinishPatch,
  resolveTrialCompetitors,
  moneyFactLabel,
  estimateLabel,
  estimateAssumptionLabel,
  attemptOutcomeLabel,
  fmtTrialMinutes,
} from '../../src/lib/trial-view'
import { TRIAL_ESTIMATE_TOKENS } from '../../shared/contracts/trials'

describe('attemptFinishPatch — финиш попытки ставит панель', () => {
  it('running + runStatus done → патч done (контрольный кейс «происходит»)', () => {
    expect(attemptFinishPatch({ status: 'running', runStatus: 'done' })).toEqual({ status: 'done' })
  })

  it.each(['failed', 'stopped', 'timed_out', 'interrupted'] as const)(
    'running + runStatus %s → патч failed с честной причиной', (runStatus) => {
      const patch = attemptFinishPatch({ status: 'running', runStatus })
      expect(patch?.status).toBe('failed')
      expect(patch?.error).toBeTruthy()
    })

  it('живой прогон (running/queued/waiting_review) — патча НЕТ', () => {
    for (const runStatus of ['running', 'queued', 'waiting_review']) {
      expect(attemptFinishPatch({ status: 'running', runStatus })).toBeNull()
    }
  })

  it('suspended — не терминальный (прогон продолжаем), патча нет', () => {
    expect(attemptFinishPatch({ status: 'running', runStatus: 'suspended' })).toBeNull()
  })

  it('уже закрытая попытка (done/failed/accepted/archived) повторно не финишируется', () => {
    for (const status of ['done', 'failed', 'accepted', 'archived'] as const) {
      expect(attemptFinishPatch({ status, runStatus: 'done' })).toBeNull()
    }
  })

  it('попытка без прогона (pending, runStatus null) — патча нет', () => {
    expect(attemptFinishPatch({ status: 'pending', runStatus: null })).toBeNull()
  })
})

describe('resolveTrialCompetitors — модель ЯВНАЯ: оценка и прогон смотрят на одну', () => {
  const providers = [
    { id: 'deepseek', defaultModel: 'deepseek-chat' },
    { id: 'openai', defaultModel: 'gpt-5' },
  ]

  it('выбранная модель уходит как есть, невыбранная — дефолт провайдера ЯВНО', () => {
    const res = resolveTrialCompetitors(
      [{ providerId: 'deepseek', model: 'deepseek-reasoner' }, { providerId: 'openai', model: null }],
      providers,
    )
    expect(res).toEqual({
      competitors: [
        { providerId: 'deepseek', model: 'deepseek-reasoner' },
        { providerId: 'openai', model: 'gpt-5' },
      ],
    })
  })

  it('провайдер вне каталога и без выбранной модели — честный отказ, не угадайка', () => {
    const res = resolveTrialCompetitors([{ providerId: 'no-such', model: null }], providers)
    expect('error' in res && res.error).toMatch(/модель/i)
  })

  it('в резолве нет undefined/null моделей — прогону нечего перетолковывать', () => {
    const res = resolveTrialCompetitors(
      [{ providerId: 'deepseek', model: null }, { providerId: 'openai', model: null }],
      providers,
    )
    if ('error' in res) throw new Error('ожидали competitors')
    for (const c of res.competitors) expect(typeof c.model).toBe('string')
  })
})

describe('деньги: факт и оценка', () => {
  it('известная цена — доллары из центов, тем же путём, что «Итого»', () => {
    expect(moneyFactLabel({ costCents: 42, runStatus: 'done', status: 'done' })).toBe('$0.42')
    expect(moneyFactLabel({ costCents: 0, runStatus: 'done', status: 'done' })).toBe('$0.00')
  })

  it('терминальный прогон без цены — СЛОВО «неизвестна», не ноль', () => {
    expect(moneyFactLabel({ costCents: null, runStatus: 'done', status: 'accepted' })).toBe('неизвестна')
    expect(moneyFactLabel({ costCents: null, runStatus: 'failed', status: 'failed' })).toBe('неизвестна')
  })

  it('прогон ещё живой или не стартовал — «—», не «неизвестна»', () => {
    expect(moneyFactLabel({ costCents: null, runStatus: 'running', status: 'running' })).toBe('—')
    expect(moneyFactLabel({ costCents: null, runStatus: null, status: 'pending' })).toBe('—')
  })

  it('оценка: неизвестная цена модели — «неизвестна»; подписка/эндпойнт — $0 с основанием', () => {
    expect(estimateLabel({ basis: 'unknown', estimateCents: null })).toBe('неизвестна')
    expect(estimateLabel({ basis: 'subscription', estimateCents: 0 })).toContain('$0')
    expect(estimateLabel({ basis: 'zero-cost', estimateCents: 0 })).toContain('$0')
    expect(estimateLabel({ basis: 'price', estimateCents: 123 })).toBe('≈$1.23')
  })

  it('допущение оценки называет оба объёма из shared-константы (400 тыс. / 30 тыс.)', () => {
    const label = estimateAssumptionLabel(TRIAL_ESTIMATE_TOKENS)
    expect(label).toContain('400')
    expect(label).toContain('30')
    // Константа одна на main и renderer — цифры в подписи не захардкожены.
    const custom = estimateAssumptionLabel({ inputTokens: 7_000, outputTokens: 2_000 })
    expect(custom).toContain('7')
    expect(custom).toContain('2')
  })
})

describe('колонки «что вышло» и «минут»', () => {
  it('outcome/error попытки важнее выведенного ярлыка', () => {
    expect(attemptOutcomeLabel({ status: 'done', runStatus: 'done', outcome: 'форма починена', error: null, filesCount: 2 }))
      .toBe('форма починена')
    expect(attemptOutcomeLabel({ status: 'failed', runStatus: 'failed', outcome: null, error: 'нет ключа', filesCount: null }))
      .toBe('нет ключа')
  })

  it('готовой попытке — «готово» с числом файлов, живой — «работает…»', () => {
    expect(attemptOutcomeLabel({ status: 'done', runStatus: 'done', outcome: null, error: null, filesCount: 3 }))
      .toContain('файл')
    expect(attemptOutcomeLabel({ status: 'running', runStatus: 'running', outcome: null, error: null, filesCount: null }))
      .toBe('работает…')
  })

  it('минуты: null → «—», меньше минуты честно, дальше — округление', () => {
    expect(fmtTrialMinutes(null)).toBe('—')
    expect(fmtTrialMinutes(30_000)).toBe('<1 мин')
    expect(fmtTrialMinutes(24 * 60_000)).toBe('24 мин')
  })
})
