import { describe, it, expect } from 'vitest'
import type { AgentRun } from '../../src/types/api'
import { describeRoute } from '../../src/lib/run-route'

// Слияние «Прогоны»+«История работы AI» → «История работы» (задача 1): честная
// видимость маршрута (что запросили vs что реально отработало) переезжает из
// AgentRunInspector во вкладку «Диагностика». Логика берётся напрямую из persisted
// AgentRun (SSOT маршрута), а не из audit — как и buildRun в инспекторе.
const agentRun = (o: Partial<AgentRun>): AgentRun => ({
  runId: 'r1', projectPath: '/p', chatId: 1, owner: 'main', title: '', status: 'done',
  providerId: null, model: null, requestedProviderId: null, requestedModel: null,
  sendId: null, generation: 0, agentsCount: 0, toolCount: 0, filesCount: 0, costCents: 0,
  error: null, startedAt: 0, endedAt: null, turnIndex: 0, lastToolName: null,
  lastCheckpointId: null, agentMode: null, updatedAt: null, lastEventAt: null, ...o,
})

describe('describeRoute — маршрут прогона для вкладки «Диагностика»', () => {
  it('нет override (requested null) → requested == actual, фолбэка нет', () => {
    const r = describeRoute(agentRun({ providerId: 'gemini-api', model: 'gemini-3-flash' }))
    expect(r.actualProvider).toBe('gemini-api')
    expect(r.requestedProvider).toBe('gemini-api')
    expect(r.requestedModel).toBe('gemini-3-flash')
    expect(r.isFallback).toBe(false)
  })

  it('реальный фолбэк провайдера: requested из persisted, actual другой → isFallback', () => {
    const r = describeRoute(agentRun({
      requestedProviderId: 'kimi-coding', requestedModel: 'kimi-for-coding',
      providerId: 'claude', model: 'claude-opus-4-8',
    }))
    expect(r.requestedProvider).toBe('kimi-coding')
    expect(r.actualProvider).toBe('claude')
    expect(r.isFallback).toBe(true)
  })

  it('сменилась только модель (провайдер тот же) → фолбэк виден', () => {
    const r = describeRoute(agentRun({
      requestedModel: 'grok-4.5', providerId: 'grok-api', model: 'grok-composer-2.5-fast',
    }))
    expect(r.requestedProvider).toBe('grok-api')
    expect(r.requestedModel).toBe('grok-4.5')
    expect(r.actualModel).toBe('grok-composer-2.5-fast')
    expect(r.isFallback).toBe(true)
  })

  it('пустой маршрут (всё null) → фолбэка нет, не паникует', () => {
    const r = describeRoute(agentRun({}))
    expect(r.actualProvider).toBeNull()
    expect(r.requestedProvider).toBeNull()
    expect(r.isFallback).toBe(false)
  })
})
