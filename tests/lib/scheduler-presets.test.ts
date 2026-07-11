import { describe, it, expect } from 'vitest'
import { SCHEDULER_PRESETS, findSchedulerPreset, buildScheduledFixPrompt } from '../../src/lib/scheduler-presets'

/**
 * Хиро-пресеты «AI-дежурного» (1.9.9). Тест лочит их как РЕАЛЬНЫЙ curated-набор,
 * а не пустышку, и — критично — что КАЖДЫЙ пресет несёт read-only дисциплину
 * (дозор наблюдает, не меняет). Регрессия, добавившая пресет с «запусти/почини/
 * измени», обязана здесь падать: фоновый прогон физически read-only.
 */
describe('scheduler-presets', () => {
  it('непустой curated-набор с уникальными id', () => {
    expect(SCHEDULER_PRESETS.length).toBeGreaterThanOrEqual(3)
    const ids = SCHEDULER_PRESETS.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('каждый пресет полностью заполнен (icon/label/hint/nl/prompt)', () => {
    for (const p of SCHEDULER_PRESETS) {
      expect(p.icon.trim()).not.toBe('')
      expect(p.label.trim()).not.toBe('')
      expect(p.hint.trim()).not.toBe('')
      expect(p.nl.trim()).not.toBe('')
      expect(p.prompt.trim().length).toBeGreaterThan(40)
    }
  })

  it('каждый prompt несёт read-only дисциплину (не меняй / не выполняй команд)', () => {
    for (const p of SCHEDULER_PRESETS) {
      expect(p.prompt.toLowerCase()).toContain('ничего не меняй')
    }
  })

  it('ни один prompt не обещает мутаций (write/run) — фон read-only', () => {
    const forbidden = /\b(запусти сборку|запусти тесты|почини|исправь файл|измени файл|напиши файл|выполни команд)/i
    for (const p of SCHEDULER_PRESETS) {
      expect(p.prompt).not.toMatch(forbidden)
    }
  })

  it('findSchedulerPreset: находит по id, null для неизвестного', () => {
    expect(findSchedulerPreset(SCHEDULER_PRESETS[0].id)?.id).toBe(SCHEDULER_PRESETS[0].id)
    expect(findSchedulerPreset('нет-такого')).toBeNull()
  })
})

describe('buildScheduledFixPrompt — мост дозор→контролируемый фикс', () => {
  const base = { prompt: 'Дозор интеграций Ozon', human: 'каждое утро в 9', cron: '0 9 * * *' }

  it('включает находку прогона и задачу дозора', () => {
    const out = buildScheduledFixPrompt({ ...base, last_result: 'Ozon: 401 при запросе заказов' })
    expect(out).toContain('Ozon: 401 при запросе заказов')
    expect(out).toContain('Дозор интеграций Ozon')
    expect(out).toContain('каждое утро в 9')
  })

  it('требует контроль: сначала план, не писать/выполнять сразу', () => {
    const out = buildScheduledFixPrompt({ ...base, last_result: 'что-то' })
    expect(out.toLowerCase()).toContain('сначала покажи план')
    expect(out).toMatch(/НЕ пиши файлы и не выполняй/i)
  })

  it('пустой/нулевой результат не роняет промпт', () => {
    expect(buildScheduledFixPrompt({ ...base, last_result: null })).toContain('результат прогона пуст')
    expect(buildScheduledFixPrompt({ ...base, last_result: '   ' })).toContain('результат прогона пуст')
  })

  it('фоллбэк на cron когда human пуст', () => {
    const out = buildScheduledFixPrompt({ prompt: 'x', human: null, cron: '0 8 * * 1-5', last_result: 'y' })
    expect(out).toContain('0 8 * * 1-5')
  })
})
