import { describe, it, expect } from 'vitest'
import { assembleProofPack, renderProofPackHtml, renderProofPackMarkdown, type ProofPackInput } from '../../electron/ai/proof-pack'

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
      { kind: 'tool_call', label: 'review_before_commit', detail: 'REVIEW GATE: ПРОЙДЕНО · confidence 0.9', status: 'ok', createdAt: 3 },
      { kind: 'assistant_msg', label: null, detail: 'Готово: починил guard в auth.ts', status: 'completed', createdAt: 4 }
    ],
    audit: [
      { action: 'session_start', detail: '{}', timestamp: 1 },
      { action: 'devtask-commit-override', detail: 'task=3 reason="срочно" checks=tsc:fail', timestamp: 5 }
    ],
    // VSK-PROOF-A1: честность стоимости из agent_run_usage. По умолчанию — известная цена
    // (терминальная нога стоила 0.0137; cumulative прогона — run.costCents, число из него).
    usage: { pricingKnown: 1, costAmount: 0.0137 }
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
    expect(p.timeline.map(e => e.kind)).toEqual(['session_start', 'tool_call', 'verify', 'tool_call', 'assistant_msg'])
    expect(p.reviewGate.status).toBe('passed')
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
    expect(html).toContain('Review Gate')
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

  it('renderProofPackMarkdown пишет review gate и файлы', () => {
    const md = renderProofPackMarkdown(assembleProofPack(baseInput()))
    expect(md).toContain('# Proof Pack')
    expect(md).toContain('## Review Gate')
    expect(md).toContain('passed')
    expect(md).toContain('src/auth.ts')
  })

  it('редактирует секреты в result/timeline', () => {
    const inp = baseInput()
    inp.events.push({ kind: 'assistant_msg', label: null, detail: 'token sk-proj-123456789012345678901234567890', status: 'completed', createdAt: 9 })
    const p = assembleProofPack(inp)
    expect(p.result).toContain('[REDACTED:openai-key]')
    expect(JSON.stringify(p)).not.toContain('sk-proj-123456789012345678901234567890')
  })
})

// Proof-A: characterization текущего паспорта — backward-compat lock ПЕРЕД Proof Passport V2.
// ЗАЧЕМ: V2 добавляет честность (unknown-стоимость, legacy-incomplete, полнота scanner), но
// экспорты JSON/HTML/MD обязаны остаться обратно совместимыми. Эти тесты фиксируют ТЕКУЩУЮ
// форму и честные состояния — любое их изменение в V2 станет видимым и осознанным.
describe('Proof Passport — характеризация (backward-compat lock перед V2)', () => {
  it('ФОРМА ProofPack зафиксирована (V2 добавляет поля осознанно, а не ломает)', () => {
    const p = assembleProofPack(baseInput())
    // VSK-PROOF-A1 (V2): осознанно добавлены legacyIncomplete (корень) и costStatus (run);
    // costUsd расширен до number|null. R1 добавил costDataStatus (run) — tri-state источника
    // стоимости: ok (строка прочитана) / missing (строки нет) / unavailable (ошибка чтения).
    // Старые поля не удалены и не переименованы.
    expect(Object.keys(p).sort()).toEqual(
      ['changedFiles', 'decisions', 'generatedAt', 'legacyIncomplete', 'result', 'reviewGate', 'run', 'timeline', 'verification'].sort()
    )
    expect(Object.keys(p.run).sort()).toEqual(
      ['agentMode', 'agentsCount', 'costDataStatus', 'costStatus', 'costUsd', 'durationMs', 'endedAt', 'error', 'filesCount', 'model',
        'provider', 'runId', 'startedAt', 'status', 'title', 'toolCount', 'turnIndex'].sort()
    )
  })

  it('честное состояние partial → «ЧАСТИЧНО», не выдаётся за пройденное', () => {
    const inp = baseInput()
    inp.verification = { overall: 'partial', checksTotal: 5, checksPassed: 3, taskSummary: null }
    expect(renderProofPackHtml(assembleProofPack(inp))).toContain('ЧАСТИЧНО · 3/5')
  })

  it('нет review-события → reviewGate.missing (не «passed» по умолчанию)', () => {
    const inp = baseInput()
    inp.events = inp.events.filter(e => e.label !== 'review_before_commit')
    const p = assembleProofPack(inp)
    expect(p.reviewGate.status).toBe('missing')
    expect(p.reviewGate.at).toBeNull()
  })

  // V2 (VSK-PROOF-A1) РЕАЛИЗОВАЛ разницу ноля: «известный ноль» (CLI/локально, pricing_known=1)
  // остаётся $0.00; «неизвестно» (модель без цен) и legacy — числа не показывают вовсе.
  it('известный ноль (CLI): costCents 0 → costUsd 0 → $0.00, НЕ «неизвестно»', () => {
    const inp = baseInput()
    inp.run.costCents = 0
    inp.usage = { pricingKnown: 1, costAmount: 0 } // CLI/локальный — заведомо бесплатно
    const p = assembleProofPack(inp)
    expect(p.run.costStatus).toBe('known')
    expect(p.run.costUsd).toBe(0)
    expect(p.legacyIncomplete).toBe(false)
    const html = renderProofPackHtml(p)
    expect(html).toContain('$0.00')
    expect(html).not.toContain('неизвестно')
    const md = renderProofPackMarkdown(p)
    expect(md).toContain('$0.00')
    expect(md).not.toContain('неизвестно')
  })

  it('Markdown без verification честно пишет not_run', () => {
    const inp = baseInput()
    inp.verification = null
    expect(renderProofPackMarkdown(assembleProofPack(inp))).toContain('- Status: not_run')
  })
})

// VSK-PROOF-A1: ноль имеет ТРИ значения — бесплатный CLI / цена неизвестна / legacy без
// строки usage. Честность определяется agent_run_usage (pricingKnown + costAmount), число
// известной стоимости — всегда из agent_runs.costCents (cumulative прогона; cost_amount —
// только терминальная нога после fallback, её нельзя выдавать за полную стоимость).
describe('честная стоимость (VSK-PROOF-A1)', () => {
  it('цена неизвестна (pricingKnown=0): costUsd=null, «неизвестно», НИГДЕ нет $0.00', () => {
    const inp = baseInput()
    inp.run.costCents = 0
    inp.usage = { pricingKnown: 0, costAmount: null }
    const p = assembleProofPack(inp)
    expect(p.run.costStatus).toBe('unknown')
    expect(p.run.costUsd).toBeNull()
    expect(p.legacyIncomplete).toBe(false)
    const html = renderProofPackHtml(p)
    expect(html).toContain('неизвестно')
    expect(html).not.toContain('$0.00')
    const md = renderProofPackMarkdown(p)
    expect(md).toContain('неизвестно')
    expect(md).not.toContain('$0.00')
    // в итоговом JSON нет undefined — поле присутствует как null
    expect(JSON.stringify(p.run)).toContain('"costUsd":null')
  })

  it('legacy без строки usage: costUsd=null, legacyIncomplete=true, честная пометка', () => {
    const inp = baseInput()
    inp.run.costCents = 0
    inp.usage = null
    const p = assembleProofPack(inp)
    expect(p.run.costStatus).toBe('unknown')
    expect(p.run.costUsd).toBeNull()
    expect(p.legacyIncomplete).toBe(true)
    const html = renderProofPackHtml(p)
    expect(html).toContain('неизвестно · неполные legacy-данные')
    expect(html).not.toContain('$0.00')
    const md = renderProofPackMarkdown(p)
    expect(md).toContain('неизвестно · неполные legacy-данные')
    expect(md).not.toContain('$0.00')
  })

  it('известная цена: число берётся из costCents прогона, а не из cost_amount ноги', () => {
    const inp = baseInput()
    inp.run.costCents = 50
    inp.usage = { pricingKnown: 1, costAmount: 0.0007 } // терминальная нога — не вся сумма
    const p = assembleProofPack(inp)
    expect(p.run.costStatus).toBe('known')
    expect(p.run.costUsd).toBe(0.5) // 50 центов cumulative, НЕ 0.0007
    expect(p.run.costDataStatus).toBe('ok') // строка usage прочитана
    expect(renderProofPackHtml(p)).toContain('$0.50')
  })

  it('повреждённая строка (pricingKnown=1, costAmount=null) → unknown, НЕ ноль', () => {
    const inp = baseInput()
    inp.run.costCents = 0
    inp.usage = { pricingKnown: 1, costAmount: null } // противоречивые persisted-данные
    const p = assembleProofPack(inp)
    expect(p.run.costStatus).toBe('unknown')
    expect(p.run.costUsd).toBeNull()
    expect(p.legacyIncomplete).toBe(false)
    expect(renderProofPackHtml(p)).not.toContain('$0.00')
  })

  // VSK-PROOF-A1-R1: современный CLI может НЕ отдавать token telemetry — runner не пишет
  // usage-строку (runner-plain.ts:425). Заведомо бесплатный провайдер ≠ legacy и ≠ unknown.
  it('CLI без usage-строки (нет token telemetry): known $0.00, НЕ legacy', () => {
    const inp = baseInput()
    inp.run.providerId = 'grok-cli'
    inp.run.model = 'grok-code-fast-1'
    inp.run.costCents = 0
    inp.usage = null // runner не написал строку — токены не сообщены
    const p = assembleProofPack(inp)
    expect(p.run.costStatus).toBe('known')
    expect(p.run.costUsd).toBe(0)
    expect(p.run.costDataStatus).toBe('missing') // строки нет — но это НЕ legacy
    expect(p.legacyIncomplete).toBe(false)
    const html = renderProofPackHtml(p)
    expect(html).toContain('$0.00')
    expect(html).not.toContain('неизвестно')
    const md = renderProofPackMarkdown(p)
    expect(md).toContain('$0.00')
    expect(md).not.toContain('неизвестно')
  })

  it('zero-cost провайдер (ollama) без usage-строки: тоже known $0.00, НЕ legacy', () => {
    const inp = baseInput()
    inp.run.providerId = 'ollama'
    inp.run.model = 'llama3.3'
    inp.run.costCents = 0
    inp.usage = null
    const p = assembleProofPack(inp)
    expect(p.run.costStatus).toBe('known')
    expect(p.run.costUsd).toBe(0)
    expect(p.legacyIncomplete).toBe(false)
    expect(renderProofPackHtml(p)).toContain('$0.00')
  })

  it('платный провайдер без usage-строки: по-прежнему legacy unknown (регрессия R1)', () => {
    const inp = baseInput()
    inp.run.providerId = 'claude' // НЕ бесплатный
    inp.run.costCents = 0
    inp.usage = null
    const p = assembleProofPack(inp)
    expect(p.run.costStatus).toBe('unknown')
    expect(p.run.costUsd).toBeNull()
    expect(p.run.costDataStatus).toBe('missing')
    expect(p.legacyIncomplete).toBe(true)
    expect(renderProofPackHtml(p)).toContain('неизвестно · неполные legacy-данные')
  })

  it('ошибка ЧТЕНИЯ usage (не отсутствие строки): unknown + unavailable, НЕ legacy', () => {
    const inp = baseInput()
    inp.run.costCents = 0
    inp.usage = null
    inp.usageError = true
    const p = assembleProofPack(inp)
    expect(p.run.costStatus).toBe('unknown')
    expect(p.run.costUsd).toBeNull()
    expect(p.legacyIncomplete).toBe(false)
    expect(p.run.costDataStatus).toBe('unavailable')
    const html = renderProofPackHtml(p)
    expect(html).toContain('неизвестно · данные usage недоступны')
    expect(html).not.toContain('legacy')
    expect(html).not.toContain('$0.00')
    const md = renderProofPackMarkdown(p)
    expect(md).toContain('неизвестно · данные usage недоступны')
    expect(md).not.toContain('$0.00')
  })
})
