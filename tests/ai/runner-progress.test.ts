import { describe, it, expect, vi } from 'vitest'
import { compactProgressText, modelProgressLabel, emitAgentProgress, createModelWaitHeartbeat } from '../../electron/ai/runner-progress'

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
      expect(modelProgressLabel('claude', 'claude-opus-4-5')).toContain('claude-opus-4-5')
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

    it('санитизирует снятые Grok model ids в title и detail', () => {
      const sender = { send: vi.fn(), exec: vi.fn() }
      emitAgentProgress(sender as never, 7, {
        phase: 'model',
        title: 'Grok Build · grok-composer-2.5-fast анализирует запрос',
        detail: 'Запущен grok-composer-2.5-fast',
      })
      const event = sender.send.mock.calls[0]?.[1]?.event
      expect(event.title).toBe('Grok Build · grok-4.5 анализирует запрос')
      expect(event.detail).toBe('Запущен grok-4.5')
    })
  })

  describe('createModelWaitHeartbeat', () => {
    it('не пропускает stale model id в heartbeat', () => {
      const sender = { send: vi.fn(), exec: vi.fn() }
      const heartbeat = createModelWaitHeartbeat(sender as never, 9, {
        id: 'wait',
        label: 'Grok Build · grok-composer-2.5-fast',
      })
      heartbeat.stop()
      const titles = sender.send.mock.calls.map(call => call[1]?.event?.title).filter(Boolean)
      expect(titles).toContain('Grok Build · grok-4.5 анализирует запрос')
    })
  })
})
