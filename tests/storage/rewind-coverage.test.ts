import { describe, it, expect } from 'vitest'
import { computeRewindCoverage, assessRewind } from '../../electron/storage/rewind-coverage'
import type { UndoEntry } from '../../electron/storage/undo'

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

/**
 * assessRewind — coverage над РЕАЛЬНЫМИ undo-записями (соединяет E1+E2).
 * Читает провенанс записей + сверяет текущий хеш файла с afterHash (не переписан ли).
 */
const entry = (over: Partial<UndoEntry>): UndoEntry => ({
  id: 1, filePath: 'a.ts', beforeContent: 'b', afterContent: 'a', createdAt: 1,
  runId: 'run-1', chatId: 7, messageId: 4, beforeHash: 'bh', afterHash: 'ah', ...over,
})

describe('assessRewind — покрытие над реальными записями', () => {
  it('все с runId, файлы не переписаны → complete', () => {
    const entries = [entry({ id: 1, filePath: 'a.ts', afterHash: 'ah1' }), entry({ id: 2, filePath: 'b.ts', afterHash: 'ah2' })]
    const r = assessRewind(entries, { currentHash: p => (p.endsWith('a.ts') ? 'ah1' : 'ah2') })
    expect(r.level).toBe('complete')
    expect(r.tracedFiles).toBe(2)
  })

  // Запись без runId = непротрассированный writer → НЕ complete.
  it('запись без runId в наборе → partial (непротрассированный writer)', () => {
    const entries = [entry({ id: 1, filePath: 'a.ts', afterHash: 'ah1' }), entry({ id: 2, filePath: 'x.ts', runId: null, afterHash: 'ah2' })]
    const r = assessRewind(entries, { currentHash: () => 'ah1' })
    expect(r.level).toBe('partial')
    expect(r.hasUntracedWriters).toBe(true)
  })

  // Файл переписан кем-то после нашей записи (текущий хеш != afterHash).
  it('файл переписан после → stale → partial', () => {
    const entries = [entry({ id: 1, filePath: 'a.ts', afterHash: 'ah1' })]
    const r = assessRewind(entries, { currentHash: () => 'ДРУГОЙ-ХЕШ' })
    expect(r.level).toBe('partial')
    expect(r.staleFiles).toBe(1)
  })

  it('пустой набор → none', () => {
    expect(assessRewind([], { currentHash: () => null }).level).toBe('none')
  })

  // Ревью E: bypass-writers (run_command/CLI) НЕ оставляют undo-записи вовсе — assessRewind
  // не увидит их по записям. Потребитель (F) обязан сообщить об этом явно, иначе complete
  // соврёт: прогон менял файлы мимо нас, а мы обещали полный откат.
  it('прогон использовал bypass-writers (run_command/CLI) → НЕ complete, даже если записи чисты', () => {
    const entries = [entry({ id: 1, filePath: 'a.ts', afterHash: 'ah1' })]
    const r = assessRewind(entries, { currentHash: () => 'ah1', hasBypassWriters: true })
    expect(r.level).toBe('partial')
    expect(r.hasUntracedWriters).toBe(true)
  })

  it('без bypass-сигнала и без untraced-записей → complete (как раньше)', () => {
    const entries = [entry({ id: 1, filePath: 'a.ts', afterHash: 'ah1' })]
    expect(assessRewind(entries, { currentHash: () => 'ah1', hasBypassWriters: false }).level).toBe('complete')
  })

  // Один файл — несколько записей (правился много раз): stale считается по файлу, не по записи.
  it('несколько записей одного файла → один traced-файл', () => {
    const entries = [
      entry({ id: 1, filePath: 'a.ts', afterHash: 'v1' }),
      entry({ id: 2, filePath: 'a.ts', afterHash: 'v2' }),
    ]
    const r = assessRewind(entries, { currentHash: () => 'v2' })
    expect(r.tracedFiles).toBe(1) // один файл, не два
  })

  // КЛЮЧЕВОЕ: list() отдаёт DESC (новые первыми). Конечное состояние файла = запись с
  // МАКСИМАЛЬНЫМ id, не «последняя в массиве». При DESC-входе наивное перетирание взяло бы
  // самую СТАРУЮ запись и ложно объявило файл протухшим.
  it('DESC-порядок: конечное состояние берётся по max id, не по позиции', () => {
    const descEntries = [
      entry({ id: 2, filePath: 'a.ts', afterHash: 'v2' }), // новее — первым (как list DESC)
      entry({ id: 1, filePath: 'a.ts', afterHash: 'v1' }),
    ]
    // Текущий файл = v2 (последняя правка). Правильный код → complete; наивное перетирание
    // взяло бы v1 → currentHash v2 != v1 → ложный stale → partial.
    const r = assessRewind(descEntries, { currentHash: () => 'v2' })
    expect(r.level).toBe('complete')
    expect(r.staleFiles).toBe(0)
  })
})
