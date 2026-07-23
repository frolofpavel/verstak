// @vitest-environment jsdom
//
// Proof-B: честный requested/actual маршрут прогона в Inspector. buildRun — чистая
// функция (импортируем без рендера → без риска jsdom-подвисания). SSOT маршрута =
// persisted agent_runs (join строго по runId): auditFn замыкает СТАРТОВЫЕ provider/model,
// и рекурсивный fallback продолжает писать их в audit_log — audit НЕ источник фактического
// маршрута. Непустые persisted-поля всегда в приоритете; audit — fallback для null-полей
// и legacy-записей без строки agent_runs.
import { describe, it, expect } from 'vitest'
import type { AgentRun, AuditEntry } from '../../src/types/api'
import { buildRun } from '../../src/components/AgentRunInspector'

const entry = (o: Partial<AuditEntry>): AuditEntry => ({
  id: 0, timestamp: 0, projectPath: '/p', chatId: 1, action: 'x', detail: '',
  providerId: null, model: null, runId: 'r1', ...o,
})

const agentRun = (o: Partial<AgentRun>): AgentRun => ({
  runId: 'r1', projectPath: '/p', chatId: 1, owner: 'main', title: '', status: 'done',
  providerId: null, model: null, requestedProviderId: null, requestedModel: null,
  sendId: null, generation: 0, agentsCount: 0, toolCount: 0, filesCount: 0, costCents: 0,
  error: null, startedAt: 0, endedAt: null, turnIndex: 0, lastToolName: null,
  lastCheckpointId: null, agentMode: null, updatedAt: null, lastEventAt: null, ...o,
})

describe('buildRun — requested/actual маршрут из persisted agent_runs (Proof-B)', () => {
  it('РЕАЛЬНЫЙ fallback: audit весь прогон несёт стартовый маршрут, actual — из persisted', () => {
    // Форма реального fallback: auditFn замкнут на kimi-coding → ВСЕ audit-записи
    // (включая поздние, после handoff) содержат стартовый маршрут. Claude в audit
    // НЕ появляется вообще — только persisted agent_runs знает фактический маршрут.
    const persisted = agentRun({
      // requested_* = null: пользователь не делал route-override (дефолт чата).
      providerId: 'claude',             // updateActual после smart-fallback
      model: 'claude-opus-4-8',
    })
    const run = buildRun([
      entry({ timestamp: 1, providerId: 'kimi-coding', model: 'kimi-for-coding', action: 'session_start' }),
      entry({ timestamp: 2, providerId: 'kimi-coding', model: 'kimi-for-coding', action: 'error' }),
      entry({ timestamp: 3, providerId: 'kimi-coding', model: 'kimi-for-coding', action: 'provider_switch' }),
      entry({ timestamp: 4, providerId: 'kimi-coding', model: 'kimi-for-coding', action: 'session_end' }),
    ], 'k', persisted)
    expect(run.requestedProvider).toBe('kimi-coding')     // что запросили (старт из audit)
    expect(run.requestedModel).toBe('kimi-for-coding')
    expect(run.providerId).toBe('claude')                 // кто фактически завершил (persisted)
    expect(run.model).toBe('claude-opus-4-8')
  })

  it('persisted requested в приоритете над вводящим в заблуждение audit', () => {
    // audit врёт про старт (grok), но agent_runs знает и запрошенный, и фактический маршрут.
    const persisted = agentRun({
      requestedProviderId: 'kimi-coding',
      requestedModel: 'kimi-for-coding',
      providerId: 'claude',
      model: 'claude-opus-4-8',
    })
    const run = buildRun([
      entry({ timestamp: 1, providerId: 'grok-api', model: 'grok-4.5' }),
      entry({ timestamp: 2, providerId: 'grok-api', model: 'grok-4.5' }),
    ], 'k', persisted)
    expect(run.requestedProvider).toBe('kimi-coding')     // persisted, НЕ audit
    expect(run.requestedModel).toBe('kimi-for-coding')
    expect(run.providerId).toBe('claude')
    expect(run.model).toBe('claude-opus-4-8')
  })

  it('без fallback: persisted actual совпадает с requested → requested == actual', () => {
    const persisted = agentRun({ providerId: 'gemini-api', model: 'gemini-3-flash' })
    const run = buildRun([
      entry({ timestamp: 1, providerId: null, model: null, action: 'session_start' }),
      entry({ timestamp: 2, providerId: 'gemini-api', model: 'gemini-3-flash' }),
      entry({ timestamp: 3, providerId: 'gemini-api', model: 'gemini-3-flash' }),
    ], 'k', persisted)
    expect(run.providerId).toBe('gemini-api')
    expect(run.model).toBe('gemini-3-flash')
    expect(run.requestedProvider).toBe('gemini-api')
    expect(run.requestedModel).toBe('gemini-3-flash')
  })

  it('legacy без agent_runs: старая audit-эвристика продолжает работать', () => {
    const run = buildRun([
      entry({ timestamp: 1, providerId: 'kimi-coding', model: 'kimi-for-coding' }),
      entry({ timestamp: 2, providerId: 'claude', model: 'claude-opus-4-8' }),
    ], 'k')
    expect(run.requestedProvider).toBe('kimi-coding')     // первый ненулевой
    expect(run.requestedModel).toBe('kimi-for-coding')
    expect(run.providerId).toBe('claude')                 // последний ненулевой
    expect(run.model).toBe('claude-opus-4-8')
  })

  it('сменилась только модель (провайдер тот же): различие сохраняется', () => {
    const persisted = agentRun({
      requestedModel: 'grok-4.5',       // persisted requested (override модели)
      providerId: 'grok-api',
      model: 'grok-composer-2.5-fast',
    })
    const run = buildRun([
      entry({ timestamp: 1, providerId: 'grok-api', model: 'grok-4.5' }),
      entry({ timestamp: 2, providerId: 'grok-api', model: 'grok-composer-2.5-fast' }),
    ], 'k', persisted)
    expect(run.requestedProvider).toBe('grok-api')
    expect(run.requestedModel).toBe('grok-4.5')
    expect(run.providerId).toBe('grok-api')
    expect(run.model).toBe('grok-composer-2.5-fast')
    expect(run.requestedModel).not.toBe(run.model)        // UI может показать «⇄ запрошен …»
  })
})
