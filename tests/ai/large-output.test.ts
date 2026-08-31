import { describe, it, expect } from 'vitest'
import { splitLargeOutput, commandOutputFileName, COMMAND_OUTPUT_LIMIT, HEAD_LINES, TAIL_LINES } from '../../electron/ai/large-output'

// ДЕФЕКТ (проверка конкурентного аудита 31.08): вывод run_command уходил модели
// ЦЕЛИКОМ — только через secret-scanner, без ограничения. `npm test` или установка
// зависимостей выдают десятки тысяч символов и съедают окно за один вызов.
//
// ГЛАВНЫЙ ПИН: длинный вывод режется, но НЕ теряет конец — в логах сборки падения,
// стек и итоговая строка всегда внизу. Обрезка «первые N символов» сделала бы функцию
// вредной: модель видела бы, что команда запустилась, и не видела бы, что она упала.

const lines = (n: number, w = 200) => Array.from({ length: n }, (_, i) => `строка ${i} `.padEnd(w, 'x')).join('\n')

describe('вывод команды: режется, но конец сохраняется', () => {
  it('длинный лог оставляет и начало, и КОНЕЦ', () => {
    const text = lines(500)
    const { forModel, truncated } = splitLargeOutput(text, 'C:/p/.verstak/artifacts/2026-08-31/command-output-1.log')
    expect(truncated).toBe(true)
    expect(forModel, 'потеряно начало — непонятно, что запускалось').toContain('строка 0 ')
    expect(forModel, 'потерян КОНЕЦ — не видно падения и итога').toContain('строка 499 ')
    expect(forModel).toContain('пропущено')
    expect(forModel).toContain('command-output-1.log')
  })

  it('одна гигантская строка тоже режется — по символам, а не по строкам', () => {
    // Минифицированный вывод: строк мало, символов много. Резак по строкам не сработал
    // бы вовсе, и «обрезка» не обрезала бы ничего.
    const text = 'y'.repeat(COMMAND_OUTPUT_LIMIT * 3)
    const { forModel, truncated } = splitLargeOutput(text, 'C:/p/f.log')
    expect(truncated).toBe(true)
    expect(forModel.length).toBeLessThan(text.length)
    expect(forModel).toContain('пропущено')
  })

  it('без файла модели сказано, что пропущенного у неё НЕТ', () => {
    const { forModel } = splitLargeOutput(lines(500), null)
    expect(forModel).toMatch(/НЕТ|не удалось/)
  })

  // КОНТРОЛЬНЫЕ КЕЙСЫ: без них всё выше зелено и когда резак сломан и режет всегда —
  // «длинное обрезано» неотличимо от «обрезается любой вывод».
  it('короткий вывод проходит нетронутым', () => {
    const short = 'PASS  tests/a.test.ts\n2 passed\n'
    const { forModel, truncated } = splitLargeOutput(short, 'C:/p/f.log')
    expect(forModel).toBe(short)
    expect(truncated).toBe(false)
  })

  it('пустой вывод не ломает резак и не превращается в подсказку', () => {
    const { forModel, truncated } = splitLargeOutput('', 'C:/p/f.log')
    expect(forModel).toBe('')
    expect(truncated).toBe(false)
  })

  it('вывод ровно на пороге не режется — граница не съезжает на единицу', () => {
    const { truncated } = splitLargeOutput('z'.repeat(COMMAND_OUTPUT_LIMIT), 'C:/p/f.log')
    expect(truncated).toBe(false)
  })

  it('показанных строк не больше, чем объявлено константами', () => {
    const { forModel } = splitLargeOutput(lines(1000), 'C:/p/f.log')
    const shown = forModel.split('\n').filter(l => l.startsWith('строка ')).length
    expect(shown).toBeLessThanOrEqual(HEAD_LINES + TAIL_LINES)
  })
})

describe('имя файла для сохранённого вывода', () => {
  it('узнаваемо и с расширением лога', () => {
    expect(commandOutputFileName(1756600000000)).toMatch(/^command-output-\d+\.log$/)
  })
})
