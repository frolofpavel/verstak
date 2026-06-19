import { describe, it, expect } from 'vitest'
import { TASK_SPEC_CONTRACT } from '../../src/lib/task-spec'

describe('TASK_SPEC_CONTRACT — контракт ТЗ-задачи (v3 Шаг B)', () => {
  it('контракт содержит ключевые требования (пути, критерий, one concern)', () => {
    expect(TASK_SPEC_CONTRACT).toMatch(/файлы\/пути/i)
    expect(TASK_SPEC_CONTRACT).toMatch(/критерий готовности/i)
    expect(TASK_SPEC_CONTRACT).toMatch(/одна задача = одна забота/i)
  })

  it('контракт явно адресован агенту-исполнителю, не человеку', () => {
    expect(TASK_SPEC_CONTRACT).toMatch(/LLM-агент|для агента|агент/i)
  })
})
