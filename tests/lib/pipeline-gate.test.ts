import { describe, it, expect } from 'vitest'
import { decidePipelineGate, MAX_VERIFY_ATTEMPTS } from '../../src/lib/pipeline-gate'

describe('decidePipelineGate — verify-gate ядра надёжности (v3 Шаг A)', () => {
  it('verify прошёл → к proof', () => {
    expect(decidePipelineGate('pass', 1)).toEqual({ action: 'proof' })
    expect(decidePipelineGate('pass', 5)).toEqual({ action: 'proof' }) // даже на поздней попытке
  })

  it('провал на первой попытке → авто-возврат на execute (само-починка, «без извини»)', () => {
    expect(decidePipelineGate('fail', 1)).toEqual({ action: 'retry', nextAttempt: 2 })
  })

  it('провал после исчерпания попыток → честный стоп blocked, НЕ completed', () => {
    const d = decidePipelineGate('fail', MAX_VERIFY_ATTEMPTS)
    expect(d.action).toBe('blocked')
    if (d.action === 'blocked') expect(d.reason).toMatch(/не прошла/)
  })

  it('лимит попыток настраиваемый', () => {
    expect(decidePipelineGate('fail', 1, 3)).toEqual({ action: 'retry', nextAttempt: 2 })
    expect(decidePipelineGate('fail', 2, 3)).toEqual({ action: 'retry', nextAttempt: 3 })
    expect(decidePipelineGate('fail', 3, 3).action).toBe('blocked')
  })

  it('нет проверки в проекте (unknown) → не гейтим, к proof (прежний UX)', () => {
    expect(decidePipelineGate('unknown', 1)).toEqual({ action: 'proof' })
  })

  it('КЛЮЧЕВОЕ: провал НИКОГДА не ведёт в proof', () => {
    for (let a = 1; a <= 10; a++) {
      expect(decidePipelineGate('fail', a).action).not.toBe('proof')
    }
  })
})
