import { describe, expect, it } from 'vitest'
import {
  COMPLETION_GATE_MAX_NUDGES,
  buildCompletionGateNudge,
  decideCompletionGate,
  isVerificationToolCall,
  unverifiedWorkNote,
} from '../../electron/ai/completion-gate'

// V2-3 (agent-runtime-v2.md §4, ГЛАВНАЯ правка): «написал ≠ сделал» должно стать
// свойством продукта, а не просьбой в промпте. Механизм гейта уже был, но включался
// ТОЛЬКО под recipe (recipe.reviewer.required) — на обычном чат-пути финал выпускался
// после записей без единой проверки. Baseline Arena 09.08 показал мишень: слабые
// классы linked-files-edit (1/3) и self-inflicted-regression (2/3), все провалы —
// работа сдана без доказательства.
//
// Правило: были ПРИНЯТЫЕ записи в файлы и не было ни одной проверки → вернуть ход
// с требованием доказательства. Bounded: после COMPLETION_GATE_MAX_NUDGES попыток
// прогон закрывается ЧЕСТНОЙ формулировкой «сделано, не проверено», видимой человеку.

describe('isVerificationToolCall — что считается проверкой', () => {
  it('run_command с тестом/тайпчеком/сборкой — проверка', () => {
    for (const command of ['npm run test:fast', 'npm run type', 'npx tsc --noEmit', 'npm run build', 'pytest -q']) {
      expect(isVerificationToolCall({ name: 'run_command', args: { command } }), command).toBe(true)
    }
  })

  it('КОНТРОЛЬ: run_command с посторонней командой — НЕ проверка', () => {
    for (const command of ['ls -la', 'git status', 'cat README.md', 'echo hi']) {
      expect(isVerificationToolCall({ name: 'run_command', args: { command } }), command).toBe(false)
    }
  })

  it('check_diagnostics и attest_verification — проверка', () => {
    expect(isVerificationToolCall({ name: 'check_diagnostics', args: {} })).toBe(true)
    expect(isVerificationToolCall({ name: 'attest_verification', args: {} })).toBe(true)
  })

  it('КОНТРОЛЬ: чтение и запись проверкой не являются', () => {
    for (const name of ['read_file', 'write_file', 'apply_patch', 'list_directory', 'search_project']) {
      expect(isVerificationToolCall({ name, args: {} }), name).toBe(false)
    }
  })
})

describe('decideCompletionGate — V2-3', () => {
  it('записи были, проверок не было → retry (финал не выпускаем)', () => {
    expect(decideCompletionGate({ acceptedWrites: 2, verifications: 0, nudges: 0 })).toBe('retry')
  })

  it('КОНТРОЛЬ: записи были И проверка была → allow', () => {
    expect(decideCompletionGate({ acceptedWrites: 2, verifications: 1, nudges: 0 })).toBe('allow')
  })

  it('КОНТРОЛЬ: записей не было (чисто читающий прогон) → allow, гейт не мешает', () => {
    expect(decideCompletionGate({ acceptedWrites: 0, verifications: 0, nudges: 0 })).toBe('allow')
  })

  it('BOUNDED: после исчерпания попыток — не бесконечный цикл, а unverified-финал', () => {
    expect(decideCompletionGate({ acceptedWrites: 1, verifications: 0, nudges: COMPLETION_GATE_MAX_NUDGES })).toBe(
      'finish-unverified',
    )
  })

  it('лимит попыток мал и конечен (1–2 по постановке)', () => {
    expect(COMPLETION_GATE_MAX_NUDGES).toBeGreaterThanOrEqual(1)
    expect(COMPLETION_GATE_MAX_NUDGES).toBeLessThanOrEqual(2)
  })

  it('полный сценарий: retry → retry → finish-unverified, без зацикливания', () => {
    const decisions: string[] = []
    let nudges = 0
    for (let i = 0; i < 5; i++) {
      const d = decideCompletionGate({ acceptedWrites: 1, verifications: 0, nudges })
      decisions.push(d)
      if (d === 'retry') nudges++
      else break
    }
    expect(decisions.filter(d => d === 'retry').length).toBe(COMPLETION_GATE_MAX_NUDGES)
    expect(decisions.at(-1)).toBe('finish-unverified')
  })
})

describe('тексты гейта', () => {
  it('nudge требует ДОКАЗАТЕЛЬСТВА и называет, чем проверить', () => {
    const nudge = buildCompletionGateNudge(['npm run test:fast', 'npm run type'])
    expect(nudge).toContain('npm run test:fast')
    expect(nudge).toContain('npm run type')
  })

  it('nudge без известных команд всё равно требует проверки', () => {
    expect(buildCompletionGateNudge([]).length).toBeGreaterThan(0)
  })

  it('unverified-финал ЧЕСТЕН: не выдаёт работу за проверенную', () => {
    const note = unverifiedWorkNote(3)
    expect(note).toMatch(/не проверен/i)
    expect(note).toContain('3')
    expect(note).not.toMatch(/готово|успешно|проверено успешно/i)
  })
})
