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

// 2.7.0 шаг 2: ПРОВЕРКА ПЕРЕСТАЁТ БЫТЬ РЕЖИМОМ, который человек включает кнопкой.
//
// Решение Павла 16.08 сняло кнопку «До результата»: «делать надо так, чтобы не
// требовались доказательства и проверки». Кнопка запускала pipeline с verify-гейтом
// (`src/lib/pipeline-gate.ts`), и разницу между ним и обычным путём надо было
// ПЕРЕНЕСТИ, а не строить третью машину рядом.
//
// Разница ровно одна, и она вот в чём. Оба гейта спрашивают «доказана ли работа»,
// но отвечают на разные вопросы: pipeline-гейт смотрит на ИСХОД проверки
// (`pass` / `fail` / `unknown`), а completion-гейт до сих пор смотрел только на её
// ФАКТ — `verifications > 0 → allow`. Прогон, который записал файлы, прогнал
// `npm run test:fast`, получил красное и сказал «готово», проезжал гейт целиком:
// проверка ведь была. Красный прогон доказательством не является — это и есть то,
// ради чего кнопка существовала.
//
// Второе расхождение оставлено сознательно и расхождением не считается: pipeline на
// исчерпании попыток даёт `blocked` (отказ), а чат даёт `finish-unverified` — честную
// пометку. В чате нельзя отказаться отвечать человеку; пометка «сделано, НЕ доказано»
// и есть чатовая форма того же честного стопа. Машина bounded в обоих случаях.
describe('decideCompletionGate — исход проверки, а не её факт (2.7.0)', () => {
  it('проверка была, но УПАЛА → retry: красный прогон доказательством не является', () => {
    expect(decideCompletionGate({ acceptedWrites: 2, verifications: 1, failedVerifications: 1, nudges: 0 })).toBe(
      'retry',
    )
  })

  it('КОНТРОЛЬ: та же форма, но проверка ПРОШЛА → allow (гейт не кричит всегда)', () => {
    expect(decideCompletionGate({ acceptedWrites: 2, verifications: 1, failedVerifications: 0, nudges: 0 })).toBe(
      'allow',
    )
  })

  it('часть проверок упала, но хотя бы одна прошла → allow: доказательство есть', () => {
    expect(decideCompletionGate({ acceptedWrites: 2, verifications: 3, failedVerifications: 2, nudges: 0 })).toBe(
      'allow',
    )
  })

  it('BOUNDED и для красных проверок: попытки исчерпаны → честный финал, а не цикл', () => {
    expect(
      decideCompletionGate({
        acceptedWrites: 1,
        verifications: 1,
        failedVerifications: 1,
        nudges: COMPLETION_GATE_MAX_NUDGES,
      }),
    ).toBe('finish-unverified')
  })

  it('КОНТРОЛЬ: записей не было → красная проверка гейт не включает', () => {
    expect(decideCompletionGate({ acceptedWrites: 0, verifications: 1, failedVerifications: 1, nudges: 0 })).toBe(
      'allow',
    )
  })

  it('СОВМЕСТИМОСТЬ: без поля failedVerifications правило прежнее (поле не обязательно)', () => {
    expect(decideCompletionGate({ acceptedWrites: 2, verifications: 1, nudges: 0 })).toBe('allow')
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

  // 2.7.0: два разных отказа нельзя описывать одним текстом. «Ты ни разу не
  // проверил» — ЛОЖЬ для прогона, который проверил и получил красное; модель на
  // такой упрёк отвечает повторным запуском той же команды, а человек читает
  // «не проверялось» там, где на самом деле «не прошло». Оба текста ветвятся по
  // одному признаку — списку упавших проверок.
  it('nudge при КРАСНОЙ проверке говорит про провал, а не «ты не проверял»', () => {
    const nudge = buildCompletionGateNudge(['npm run test:fast'], ['npm run test:fast'])
    expect(nudge).toMatch(/не прошл|упал/i)
    expect(nudge).toContain('npm run test:fast')
    expect(nudge).not.toMatch(/ни разу не проверил/i)
  })

  it('КОНТРОЛЬ: без упавших проверок nudge прежний — «ни разу не проверил»', () => {
    expect(buildCompletionGateNudge(['npm run test:fast'], [])).toMatch(/ни разу не проверил/i)
  })

  it('финал при красной проверке ЧЕСТЕН: называет, что именно не прошло', () => {
    const note = unverifiedWorkNote(3, ['npm run test:fast'])
    expect(note).toMatch(/не прошл/i)
    expect(note).toContain('npm run test:fast')
    expect(note).not.toMatch(/готово|успешно/i)
  })
})
