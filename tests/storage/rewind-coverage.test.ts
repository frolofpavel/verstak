import { describe, it, expect } from 'vitest'
import { computeRewindCoverage } from '../../electron/storage/rewind-coverage'

/**
 * Срез 2.0.11-E: покрытие отката (complete / partial / none).
 *
 * Честный ответ на вопрос «если откачу — вернётся ли всё как было?». Три уровня:
 *  · complete — все изменения прогона протрассированы и файлы никто не переписал после;
 *  · partial  — часть откатываема, часть нет (были непротрассированные writers ИЛИ файл
 *               переписан после нашей записи → откат перезатёр бы чужое);
 *  · none     — откатывать нечего.
 *
 * ГЛАВНЫЙ ИНВАРИАНТ карточки: ни один непротрассированный writer НЕ помечается complete.
 * Непротрассированный = прогон менял файлы мимо нашего undo-стека (run_command, CLI-бинарь).
 * Обещать полный откат там, где мы не видели половину правок, — ложь.
 */

describe('computeRewindCoverage (2.0.11-E)', () => {
  it('всё протрассировано, ничего не переписано → complete', () => {
    const r = computeRewindCoverage({ tracedFiles: 3, hasUntracedWriters: false, staleFiles: 0 })
    expect(r.level).toBe('complete')
  })

  // ИНВАРИАНТ: непротрассированные writers → НИКОГДА complete.
  it('были непротрассированные writers → НЕ complete (даже если traced есть)', () => {
    const r = computeRewindCoverage({ tracedFiles: 3, hasUntracedWriters: true, staleFiles: 0 })
    expect(r.level).toBe('partial')
    expect(r.level).not.toBe('complete')
  })

  it('непротрассированные writers и НИ одной traced → none (откатить нечего)', () => {
    const r = computeRewindCoverage({ tracedFiles: 0, hasUntracedWriters: true, staleFiles: 0 })
    expect(r.level).toBe('none')
  })

  // Файл переписан после нашей записи (текущий хеш != after_hash) → откат перезатёр бы чужое.
  it('часть файлов переписана после → partial (небезопасно обещать complete)', () => {
    const r = computeRewindCoverage({ tracedFiles: 3, hasUntracedWriters: false, staleFiles: 1 })
    expect(r.level).toBe('partial')
  })

  it('ВСЕ файлы переписаны после → partial (не none — записи есть, но небезопасны)', () => {
    const r = computeRewindCoverage({ tracedFiles: 2, hasUntracedWriters: false, staleFiles: 2 })
    expect(r.level).toBe('partial')
  })

  it('нечего откатывать (0 traced, без непротрассированных) → none', () => {
    expect(computeRewindCoverage({ tracedFiles: 0, hasUntracedWriters: false, staleFiles: 0 }).level).toBe('none')
  })

  it('возвращает исходные цифры для честного показа в UI', () => {
    const r = computeRewindCoverage({ tracedFiles: 5, hasUntracedWriters: true, staleFiles: 2 })
    expect(r.tracedFiles).toBe(5)
    expect(r.staleFiles).toBe(2)
    expect(r.hasUntracedWriters).toBe(true)
  })

  // Комбинация: и непротрассированные, и переписанные — всё равно partial (не complete).
  it('непротрассированные + переписанные вместе → partial', () => {
    expect(computeRewindCoverage({ tracedFiles: 4, hasUntracedWriters: true, staleFiles: 1 }).level).toBe('partial')
  })
})
