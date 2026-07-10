import { describe, it, expect } from 'vitest'
import { decideCheckpointSave, cheapHash, type CheckpointThrottleState } from '../../electron/ai/checkpoint-throttle'

describe('checkpoint-throttle — обуздание write-amplification чекпойнтов (1.9.7 #7)', () => {
  it('первый чекпойнт всегда пишется', () => {
    const d = decideCheckpointSave(1, '[{"a":1}]', undefined)
    expect(d.save).toBe(true)
    expect(d.reason).toBe('first')
  })

  it('идентичная история → skip (unchanged)', () => {
    const json = '[{"role":"user","content":"hi"}]'
    const prev: CheckpointThrottleState = { lastHash: cheapHash(json), lastSavedTurn: 3 }
    const d = decideCheckpointSave(4, json, prev)
    expect(d.save).toBe(false)
    expect(d.reason).toBe('unchanged')
  })

  it('короткие сессии (turn <= everyNAfter) пишут каждый изменённый turn', () => {
    let prev: CheckpointThrottleState | undefined
    for (let turn = 1; turn <= 12; turn++) {
      const json = `[${'x'.repeat(turn)}]` // растёт каждый turn
      const d = decideCheckpointSave(turn, json, prev)
      expect(d.save, `turn ${turn}`).toBe(true)
      prev = { lastHash: d.hash, lastSavedTurn: turn }
    }
  })

  it('длинные прогоны троттлятся: не чаще раза в everyN turn после порога', () => {
    // Записали на turn 13. turn 14,15 — throttled; turn 16 (>=13+3) — снова пишем.
    const prev: CheckpointThrottleState = { lastHash: 'old', lastSavedTurn: 13 }
    expect(decideCheckpointSave(14, '[1]', prev).reason).toBe('throttled')
    expect(decideCheckpointSave(15, '[2]', prev).reason).toBe('throttled')
    expect(decideCheckpointSave(16, '[3]', prev).save).toBe(true)
  })

  it('size-cap: блоб больше maxBytes не пишется (backstop)', () => {
    const big = 'x'.repeat(100)
    const d = decideCheckpointSave(1, big, undefined, { maxBytes: 50 })
    expect(d.save).toBe(false)
    expect(d.reason).toBe('too-big')
  })

  it('cheapHash различает разную длину при равной сумме символов', () => {
    expect(cheapHash('ab')).not.toBe(cheapHash('ba')) // порядок
    expect(cheapHash('a')).not.toBe(cheapHash('aa'))   // длина
  })
})
