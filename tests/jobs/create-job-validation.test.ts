// Предохранители на входе создания постоянной задачи.
//
// Это самая ценная часть фонового работника: задача, заведённая без предела или
// с интервалом в минуту, тратит деньги и трогает файлы без человека рядом.
// Проверяются напрямую, а не через мок ipcMain, — потому и вынесены в чистую
// функцию.
import { describe, it, expect } from 'vitest'
import { validateCreateJob } from '../../electron/ipc/persistent-jobs'
import { MAX_RUNS_CAP, MIN_WAKE_INTERVAL_MS } from '../../shared/contracts/persistent-job'

const ROOTS = ['C:/Users/Pavel/clients/acme']
const MIN_MINUTES = Math.round(MIN_WAKE_INTERVAL_MS / 60_000)

const good = (over = {}) => ({
  projectPath: ROOTS[0],
  title: 'Утренняя сводка',
  goal: 'Проверить активные задачи и подготовить краткую сводку',
  everyMinutes: 60,
  maxRuns: 10,
  ...over,
})

describe('законная задача создаётся', () => {
  it('полный корректный вход принимается', () => {
    const r = validateCreateJob(good(), ROOTS)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.everyMinutes).toBe(60)
      expect(r.maxRuns).toBe(10)
    }
  })

  it('название и цель обрезаются от пробелов', () => {
    const r = validateCreateJob(good({ title: '  Сводка  ', goal: '  Цель  ' }), ROOTS)
    expect(r.ok && r.title).toBe('Сводка')
  })
})

describe('предохранители отказывают поимённо', () => {
  it('без названия или цели не создаётся', () => {
    expect(validateCreateJob(good({ title: '   ' }), ROOTS)).toMatchObject({ ok: false })
    expect(validateCreateJob(good({ goal: '' }), ROOTS)).toMatchObject({ ok: false })
  })

  // Задача вне зарегистрированных проектов работала бы в чужой папке без ведома
  // человека — тот же класс, что проверка корней у расписаний.
  it('проект вне известных корней отклоняется', () => {
    const r = validateCreateJob(good({ projectPath: 'C:/Windows/System32' }), ROOTS)
    expect(r).toMatchObject({ ok: false })
    if (!r.ok) expect(r.error).toMatch(/не зарегистрирован/i)
  })

  it('интервал чаще минимального отклоняется', () => {
    const r = validateCreateJob(good({ everyMinutes: MIN_MINUTES - 1 }), ROOTS)
    expect(r).toMatchObject({ ok: false })
    if (!r.ok) expect(r.error).toMatch(/интервал/i)
  })

  it('предел запусков обязателен и ограничен сверху', () => {
    for (const maxRuns of [0, -1, MAX_RUNS_CAP + 1, 2.5, Number.NaN]) {
      const r = validateCreateJob(good({ maxRuns }), ROOTS)
      expect(r, `maxRuns=${maxRuns}`).toMatchObject({ ok: false })
    }
  })

  it('нечисловой интервал отклоняется, а не приводится к нулю', () => {
    expect(validateCreateJob(good({ everyMinutes: 'каждый час' as unknown as number }), ROOTS)).toMatchObject({ ok: false })
  })

  it('пустой вход не роняет проверку', () => {
    expect(validateCreateJob(undefined, ROOTS)).toMatchObject({ ok: false })
  })

  // Контроль ко всей группе: граничные ЗАКОННЫЕ значения обязаны проходить —
  // иначе пины выше зелены и у проверки, которая отклоняет вообще всё.
  it('контроль: границы допустимого принимаются', () => {
    expect(validateCreateJob(good({ everyMinutes: MIN_MINUTES }), ROOTS).ok).toBe(true)
    expect(validateCreateJob(good({ maxRuns: 1 }), ROOTS).ok).toBe(true)
    expect(validateCreateJob(good({ maxRuns: MAX_RUNS_CAP }), ROOTS).ok).toBe(true)
  })
})
