import { describe, it, expect } from 'vitest'
import { assembleProofPack, renderProofPackHtml, type ProofPackInput } from '../../electron/ai/proof-pack'

function baseInput(): ProofPackInput {
  return {
    generatedAt: 1_700_000_000_000,
    run: {
      runId: 'run-abcdef1234', title: 'Починить авторизацию', providerId: 'claude', model: 'claude-opus-4-8',
      status: 'completed', agentMode: 'ask', startedAt: 1_700_000_000_000, endedAt: 1_700_000_030_000,
      toolCount: 5, filesCount: 2, agentsCount: 1, costCents: 137, turnIndex: 3, error: null
    },
    changedFiles: [
      { path: 'src/auth.ts', added: 12, removed: 4, status: 'M' },
      { path: 'src/new.ts', added: 30, removed: 0, status: 'A' }
    ],
    verification: { overall: 'passed', checksTotal: 5, checksPassed: 5, taskSummary: 'тесты + typecheck' },
    events: [
      { kind: 'session_start', label: null, detail: null, status: null, createdAt: 1 },
      { kind: 'tool_call', label: 'write_file', detail: 'src/auth.ts', status: 'ok', createdAt: 2 },
      { kind: 'verify', label: 'DoD', detail: '5/5', status: 'passed', createdAt: 3 },
      { kind: 'assistant_msg', label: null, detail: 'Готово: починил guard в auth.ts', status: 'completed', createdAt: 4 }
    ],
    audit: [
      { action: 'session_start', detail: '{}', timestamp: 1 },
      { action: 'devtask-commit-override', detail: 'task=3 reason="срочно" checks=tsc:fail', timestamp: 5 }
    ]
  }
}

describe('assembleProofPack', () => {
  it('маппит прогон, считает длительность и стоимость', () => {
    const p = assembleProofPack(baseInput())
    expect(p.run.provider).toBe('claude')
    expect(p.run.durationMs).toBe(30_000)
    expect(p.run.costUsd).toBe(1.37) // 137 центов
    expect(p.changedFiles).toHaveLength(2)
  })

  it('извлекает override-решения из audit', () => {
    const p = assembleProofPack(baseInput())
    expect(p.decisions).toHaveLength(1)
    expect(p.decisions[0].action).toBe('devtask-commit-override')
    // обычный session_start не попадает в решения
    expect(p.decisions.some(d => d.action === 'session_start')).toBe(false)
  })

  it('берёт результат из последнего assistant_msg и фильтрует таймлайн', () => {
    const p = assembleProofPack(baseInput())
    expect(p.result).toBe('Готово: починил guard в auth.ts')
    // session_start/tool_call/verify/assistant_msg — все значимые
    expect(p.timeline.map(e => e.kind)).toEqual(['session_start', 'tool_call', 'verify', 'assistant_msg'])
  })

  it('endedAt=null → durationMs=null', () => {
    const inp = baseInput()
    inp.run.endedAt = null
    expect(assembleProofPack(inp).run.durationMs).toBeNull()
  })
})

describe('renderProofPackHtml', () => {
  it('рендерит DoD-бейдж «ДОКАЗАНО N/M» при passed', () => {
    const html = renderProofPackHtml(assembleProofPack(baseInput()))
    expect(html).toContain('ДОКАЗАНО · 5/5 проверок')
    expect(html).toContain('src/auth.ts')
    expect(html).toContain('$1.37')
    expect(html).toContain('Готово: починил guard')
  })

  it('экранирует HTML в данных (XSS-защита)', () => {
    const inp = baseInput()
    inp.run.title = '<script>alert(1)</script>'
    const html = renderProofPackHtml(assembleProofPack(inp))
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('&lt;script&gt;')
  })

  it('без verification → бейдж «НЕ ПРОВЕРЕНО»', () => {
    const inp = baseInput()
    inp.verification = null
    const html = renderProofPackHtml(assembleProofPack(inp))
    expect(html).toContain('НЕ ПРОВЕРЕНО')
  })

  it('failed verification → бейдж «НЕ ПРОЙДЕНО»', () => {
    const inp = baseInput()
    inp.verification = { overall: 'failed', checksTotal: 5, checksPassed: 2, taskSummary: null }
    const html = renderProofPackHtml(assembleProofPack(inp))
    expect(html).toContain('НЕ ПРОЙДЕНО · 2/5')
  })
})
