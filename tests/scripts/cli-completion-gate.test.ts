import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decideCompletionGate as cliDecide, isVerificationToolCall as cliIsVerification, COMPLETION_GATE_MAX_NUDGES as CLI_MAX } from '../../scripts/agent-completion-gate.mjs'
import {
  COMPLETION_GATE_MAX_NUDGES,
  decideCompletionGate,
  isVerificationToolCall,
} from '../../electron/ai/completion-gate'

const CLI = resolve(__dirname, '../../scripts/verstak-cli.mjs')

// V2-3 на CLI-пути. Измеритель Arena гоняет scripts/verstak-cli.mjs — у него
// СОБСТВЕННЫЙ agent-loop (runAgent), не импортирующий electron/. Правка, внесённая
// только в electron/ai/runner-api.ts, для Arena физически не существует: замер
// «ПОСЛЕ» мерил бы недетерминированность модели, а не эффект. Поэтому правило
// живёт в общем чистом модуле, который зовут ОБА пути, а расхождение стережёт
// анти-дрейф-пин ниже.

describe('CLI completion gate — тот же ФАЙЛ, что у десктопа', () => {
  // Сравнивать поведение двух путей больше нечего: electron/ai/completion-gate.ts
  // ре-экспортирует scripts/agent-completion-gate.mjs, то есть источник ОДИН.
  // Пин «решения совпадают» стал бы тавтологией «копия == копия» — в этом
  // репозитории такой уже снимали (§ история эталона). Стережём то, что реально
  // может сломаться: референсную идентичность и факт вызова гейта в CLI-цикле.
  it('десктопный модуль — тот же объект, а не вторая реализация', () => {
    expect(cliDecide).toBe(decideCompletionGate)
    expect(cliIsVerification).toBe(isVerificationToolCall)
    expect(CLI_MAX).toBe(COMPLETION_GATE_MAX_NUDGES)
  })

  it('verstak-cli.mjs РЕАЛЬНО зовёт гейт, а не просто содержит модуль рядом', () => {
    const source = readFileSync(CLI, 'utf8')
    expect(source).toContain('agent-completion-gate.mjs')
    expect(source).toContain('decideCompletionGate')
    // Контроль ложной зелени: импорт без вызова в цикле ничего не гейтит.
    expect(source).toMatch(/decideCompletionGate\s*\(/)
  })
})
