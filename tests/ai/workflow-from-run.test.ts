import { describe, it, expect } from 'vitest'
import { planToWorkflowSteps, buildUserWorkflowFromRun } from '../../electron/ai/workflows/from-run'

// Задача 7A: workflow = сохранённый повторяемый прогон. Шаги берутся из плана прогона
// (plan_steps). Чистая логика маппинга — пинуется здесь.
describe('planToWorkflowSteps — шаги плана → шаги workflow', () => {
  it('title + detail → instruction (detail), стабильные id', () => {
    const out = planToWorkflowSteps([
      { title: 'Собрать метрики', detail: 'Открой Я.Метрику и выгрузи конверсии' },
      { title: 'Свести отчёт', detail: null },
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ id: 's1', title: 'Собрать метрики', instruction: 'Открой Я.Метрику и выгрузи конверсии' })
    // detail пуст → instruction падает на title
    expect(out[1]).toEqual({ id: 's2', title: 'Свести отчёт', instruction: 'Свести отчёт' })
  })
})

describe('buildUserWorkflowFromRun — прогон + план → черновик workflow', () => {
  it('есть title и шаги → черновик с именем прогона и шагами', () => {
    const r = buildUserWorkflowFromRun({ title: 'Аудит Директа клиента' }, [{ title: 'Шаг', detail: 'делай' }])
    expect('error' in r).toBe(false)
    if (!('error' in r)) {
      expect(r.name).toBe('Аудит Директа клиента')
      expect(r.steps).toHaveLength(1)
      expect(r.steps[0].instruction).toBe('делай')
    }
  })

  it('нет плана/шагов → честный отказ no-steps (не сохраняем пустышку)', () => {
    const r = buildUserWorkflowFromRun({ title: 'Прогон' }, [])
    expect(r).toEqual({ error: 'no-steps' })
  })

  it('нет title прогона → отказ no-title', () => {
    const r = buildUserWorkflowFromRun({ title: '   ' }, [{ title: 'x' }])
    expect(r).toEqual({ error: 'no-title' })
  })
})
