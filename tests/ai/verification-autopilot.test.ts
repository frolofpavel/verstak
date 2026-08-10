// V3 (волна 2.6.0): автопилот проверок.
//
// РАЗБОР ОСТАТКА ПОСЛЕ V5 — он и есть половина этой позиции. После смены дефолта
// на `auto` проверочная рутина (тесты, тайпчек, сборка, диагностика, мутационная
// проверка) в живом пути НЕ спрашивает подтверждения вовсе: `decide` отдаёт
// auto-accept, а гейт ответственного действия к проверкам не относится. Значит
// «без единого клика» закрыто V5, и изобретать здесь нечего — это закреплено
// пинами ниже, чтобы утверждение не осталось словами.
//
// ОСТАТОК, КОТОРЫЙ ПРИШЛОСЬ ДЕЛАТЬ. Итог проверок человек видел только в
// отрицательном случае («сделано, не проверено»). Успешный случай не сообщал
// ничего, и тишина одинаково значила «проверок не было» и «проверки прошли».
// Появилась положительная строка — из ФАКТА прогона, а не из слов модели.
//
// ГРАНИЦА ПОЗИЦИИ (нарушение = брак): пауза на ответственном действии не
// ослабляется ничем. Контрольная пара стоит прямо здесь.
import { describe, it, expect } from 'vitest'
import { resolveDecision } from '../../electron/ai/permission-rules'
import {
  isVerificationToolCall, verifiedWorkNote, unverifiedWorkNote, decideCompletionGate,
} from '../../electron/ai/completion-gate'

describe('V3: проверочная рутина в auto идёт без единого клика', () => {
  const VERIFY_COMMANDS = ['npm test', 'npm run type', 'npm run build', 'npx vitest run', 'npm run lint']

  for (const command of VERIFY_COMMANDS) {
    it(`«${command}» в auto не спрашивает`, () => {
      const d = resolveDecision('run_command', { command }, 'auto', undefined, undefined)
      expect(d.decision, 'проверочная команда требует клика — автопилота нет').toBe('auto-accept')
    })
  }

  it('инструменты-проверки (диагностика, аттестация, мутация) в auto не спрашивают', () => {
    for (const name of ['check_diagnostics', 'attest_verification', 'mutation_check']) {
      expect(resolveDecision(name, {}, 'auto', undefined, undefined).decision).toBe('auto-accept')
    }
  })

  it('ГРАНИЦА: ответственное действие в auto ПО-ПРЕЖНЕМУ останавливает прогон', () => {
    // Нарушение этого кейса = брак позиции, а не «регресс теста».
    const payment = resolveDecision('connector_query', { id: 'yookassa', op: 'payments.create' }, 'auto', undefined, undefined)
    expect(payment.decision).toBe('confirm')
    expect(payment.confirmCause).toBe('responsible-action')

    const publish = resolveDecision('connector_query', { id: 'social-publish', op: 'publish' }, 'auto', undefined, undefined)
    expect(publish.decision).toBe('confirm')
  })

  it('признак «это проверка» — ОДИН на гейт и на плашку (второго определения нет)', () => {
    expect(isVerificationToolCall({ name: 'run_command', args: { command: 'npm test' } })).toBe(true)
    expect(isVerificationToolCall({ name: 'mutation_check', args: {} })).toBe(true)
    expect(isVerificationToolCall({ name: 'run_command', args: { command: 'git push' } })).toBe(false)
  })
})

describe('V3: итог проверок одной строкой', () => {
  it('проверки прошли → строка называет их поимённо и число файлов', () => {
    const note = verifiedWorkNote([
      { label: 'npm test', ok: true },
      { label: 'npm run type', ok: true },
    ], 3)

    expect(note).toContain('Проверено')
    expect(note).toContain('npm test')
    expect(note).toContain('npm run type')
    expect(note).toContain('3')
  })

  it('МУТАЦИЯ ПОСТАНОВКИ: проверок не было → строки НЕТ (плашка не врёт)', () => {
    // Ровно требование приёмки: «плашка появляется только при реально пройденной
    // проверке». Пустой след обязан давать null, а не бодрое «проверено».
    expect(verifiedWorkNote([], 5)).toBeNull()
    expect(verifiedWorkNote(undefined as never, 5)).toBeNull()
  })

  it('проверка упала → строка честно говорит о непрошедших, а не «проверено»', () => {
    const note = verifiedWorkNote([
      { label: 'npm test', ok: false },
      { label: 'npm run type', ok: true },
    ], 1)

    expect(note).not.toContain('✅')
    expect(note).toContain('не прошло 1')
    expect(note).toContain('✗ npm test')
  })

  it('русское число согласовано (1 проверка / 2 проверки / 5 проверок)', () => {
    const of = (n: number) => verifiedWorkNote(Array.from({ length: n }, (_, i) => ({ label: `c${i}`, ok: true })), 0)!
    expect(of(1)).toContain('пройдена 1 проверка')
    expect(of(2)).toContain('пройдены 2 проверки')
    expect(of(5)).toContain('пройдено 5 проверок')
  })

  it('пара половин не пересекается: где нота «не проверено», там плашки нет', () => {
    // Обе строки идут одним каналом, поэтому важно, что решение взаимоисключающее:
    // gate отдаёт finish-unverified ТОЛЬКО когда проверок ноль, а при нуле
    // verifiedWorkNote возвращает null.
    expect(decideCompletionGate({ acceptedWrites: 2, verifications: 0, nudges: 2 })).toBe('finish-unverified')
    expect(verifiedWorkNote([], 2)).toBeNull()
    expect(unverifiedWorkNote(2)).toContain('не проверен')

    // И наоборот: были проверки → гейт пропускает молча, строку даёт плашка.
    expect(decideCompletionGate({ acceptedWrites: 2, verifications: 1, nudges: 0 })).toBe('allow')
    expect(verifiedWorkNote([{ label: 'npm test', ok: true }], 2)).toContain('Проверено')
  })
})
