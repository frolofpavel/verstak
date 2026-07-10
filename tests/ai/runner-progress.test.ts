import { describe, it, expect, vi } from 'vitest'
import { compactProgressText, modelProgressLabel, emitAgentProgress } from '../../electron/ai/runner-progress'

describe('runner-progress — извлечено из ai.ts при распиле (1.9.8 #1)', () => {
  describe('compactProgressText', () => {
    it('схлопывает пробелы, режет по max, заменяет код-блоки', () => {
      expect(compactProgressText('  a   b  ')).toBe('a b')
      expect(compactProgressText('```js\ncode\n```')).toBe('фрагмент кода')
      expect(compactProgressText('`inline`')).toBe('inline')
      expect(compactProgressText('x'.repeat(300), 10)).toBe('xxxxxxxxx...')
    })
    it('не-строка / пусто → undefined', () => {
      expect(compactProgressText(42)).toBeUndefined()
      expect(compactProgressText('   ')).toBeUndefined()
    })
  })

  describe('modelProgressLabel', () => {
    it('провайдер+модель, дефолт «модель»', () => {
      expect(modelProgressLabel(undefined, undefined)).toBe('модель')
      expect(modelProgressLabel('claude', 'opus')).toContain('opus')
    })
  })

  describe('emitAgentProgress', () => {
    it('шлёт agent-progress событие, дефолт status=running, ошибка sender не роняет', () => {
      const sender = { send: vi.fn(), exec: vi.fn() }
      emitAgentProgress(sender as never, 7, { phase: 'model', title: 'T', detail: 'D' })
      expect(sender.send).toHaveBeenCalledWith('ai:event', expect.objectContaining({
        id: 7, event: expect.objectContaining({ type: 'agent-progress', title: 'T', status: 'running' })
      }))
      // Телеметрия не должна ронять поток при ошибке sender.
      const bad = { send: () => { throw new Error('x') }, exec: vi.fn() }
      expect(() => emitAgentProgress(bad as never, 1, { phase: 'final', title: 'x' })).not.toThrow()
    })
  })
})
