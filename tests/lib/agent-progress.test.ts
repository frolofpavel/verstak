import { describe, expect, it } from 'vitest'
import { activateModelProgress, buildInitialAgentProgress, reduceAgentProgress } from '../../src/lib/agent-progress'
import { applySnapshotEvent } from '../../src/store/apply-snapshot-event'
import { freshSnapshot } from '../../src/store/session-snapshot'

describe('agent progress', () => {
  it('keeps progress separate from assistant content', () => {
    const snap = freshSnapshot()
    const next = applySnapshotEvent(snap, {
      type: 'agent-progress',
      phase: 'context',
      title: 'Собираю контекст',
      detail: 'Проверяю историю чата',
      status: 'running'
    })

    expect(next.messages).toEqual([])
    expect(next.agentProgress).toHaveLength(1)
    expect(next.agentProgress[0].title).toBe('Собираю контекст')
  })

  it('maps thought to progress while preserving the existing thinking channel', () => {
    const snap = {
      ...freshSnapshot(),
      messages: [{ role: 'assistant' as const, content: '' }]
    }
    const next = applySnapshotEvent(snap, { type: 'thought', text: 'raw reasoning' })

    expect(next.messages[0].content).toBe('')
    expect(next.messages[0].thinking).toBe('raw reasoning')
    expect(next.agentProgress.some(item => item.title === 'Осмысливаю задачу')).toBe(true)
  })

  it('closes running steps on done', () => {
    const started = buildInitialAgentProgress('Проверь кампанию', 'Grok Build')
    const active = reduceAgentProgress(started, { type: 'text', text: 'ok' })
    const done = reduceAgentProgress(active, { type: 'done' })

    expect(done.some(item => item.status === 'running' || item.status === 'pending')).toBe(false)
    expect(done[done.length - 1].title).toBe('Ответ готов')
  })

  it('keeps a readable task focus for the live progress panel', () => {
    const progress = buildInitialAgentProgress('Проверь рекламу и дай краткий аудит', 'Grok Build')
    expect(progress[0].id).toBe('task-focus')
    expect(progress[0].detail).toContain('Проверь рекламу')

    const next = reduceAgentProgress(progress, {
      type: 'thought',
      text: 'The user is asking me to audit the campaign.'
    })
    const reasoning = next.find(item => item.id === 'reasoning')
    expect(reasoning?.detail).toContain('Проверь рекламу')
  })

  it('не показывает снятые Grok model ids во frontend progress', () => {
    const stale = 'Grok Build · grok-composer-2.5-fast'
    const initial = buildInitialAgentProgress('Проверь модель', stale)
    expect(initial.find(item => item.id === 'model')?.title).toBe('Готовлю запуск Grok Build · grok-4.5')
    const active = activateModelProgress(initial, stale)
    expect(active.find(item => item.id === 'model')?.title).toBe('Grok Build · grok-4.5 начал работу')
  })
})

describe('agent progress stream performance', () => {
  it('не создаёт новое состояние на каждую text-delta после старта финала', () => {
    const initial = buildInitialAgentProgress('ускорить ответ')
    const started = reduceAgentProgress(initial, { type: 'text', text: 'первый' })
    const repeated = reduceAgentProgress(started, { type: 'text', text: 'второй' })

    expect(repeated).toBe(started)
  })

  it('не создаёт новое состояние на каждую thought-delta', () => {
    const initial = buildInitialAgentProgress('ускорить ответ')
    const started = reduceAgentProgress(initial, { type: 'thought', text: 'первый' })
    const repeated = reduceAgentProgress(started, { type: 'thought', text: 'второй' })

    expect(repeated).toBe(started)
  })
})
