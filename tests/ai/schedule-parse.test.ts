import { describe, it, expect } from 'vitest'
import { parseSchedule, cronMatches, type TimeParts } from '../../electron/ai/schedule-parse'

describe('parseSchedule', () => {
  it('каждое утро → 0 9 * * *', () => {
    expect(parseSchedule('каждое утро проверь Ozon')?.cron).toBe('0 9 * * *')
  })
  it('каждый день в 9:30 → 30 9 * * *', () => {
    expect(parseSchedule('каждый день в 9:30 отчёт')?.cron).toBe('30 9 * * *')
  })
  it('каждую ночь → 0 3 * * * (дефолт ночи)', () => {
    expect(parseSchedule('каждую ночь аудит WB')?.cron).toBe('0 3 * * *')
  })
  it('по будням в 8 → 0 8 * * 1-5', () => {
    expect(parseSchedule('по будням в 8 сводка')?.cron).toBe('0 8 * * 1-5')
  })
  it('каждый час → 0 * * * *', () => {
    expect(parseSchedule('каждый час пинг')?.cron).toBe('0 * * * *')
  })
  it('каждые 15 минут → */15 * * * *', () => {
    expect(parseSchedule('каждые 15 минут')?.cron).toBe('*/15 * * * *')
  })
  it('каждые 4 часа → 0 */4 * * *', () => {
    expect(parseSchedule('каждые 4 часа')?.cron).toBe('0 */4 * * *')
  })
  it('every morning at 7:00 → 0 7 * * *', () => {
    expect(parseSchedule('every morning at 7:00 audit')?.cron).toBe('0 7 * * *')
  })
  it('еженедельно → 0 9 * * 1', () => {
    expect(parseSchedule('еженедельно сводка')?.cron).toBe('0 9 * * 1')
  })
  it('нераспознанное → null', () => {
    expect(parseSchedule('просто текст без расписания')).toBeNull()
    expect(parseSchedule('')).toBeNull()
  })
})

describe('cronMatches', () => {
  const at = (p: Partial<TimeParts>): TimeParts => ({ minute: 0, hour: 0, dom: 1, month: 1, dow: 1, ...p })

  it('0 9 * * * матчит 9:00 любого дня', () => {
    expect(cronMatches('0 9 * * *', at({ minute: 0, hour: 9 }))).toBe(true)
    expect(cronMatches('0 9 * * *', at({ minute: 1, hour: 9 }))).toBe(false)
    expect(cronMatches('0 9 * * *', at({ minute: 0, hour: 10 }))).toBe(false)
  })
  it('*/15 * * * * матчит минуты кратные 15', () => {
    expect(cronMatches('*/15 * * * *', at({ minute: 30 }))).toBe(true)
    expect(cronMatches('*/15 * * * *', at({ minute: 31 }))).toBe(false)
  })
  it('диапазон будней 1-5 матчит пн-пт, не вс', () => {
    expect(cronMatches('0 8 * * 1-5', at({ hour: 8, dow: 3 }))).toBe(true)
    expect(cronMatches('0 8 * * 1-5', at({ hour: 8, dow: 0 }))).toBe(false) // воскресенье
  })
  it('невалидный cron (не 5 полей) → false', () => {
    expect(cronMatches('0 9 * *', at({ hour: 9 }))).toBe(false)
    expect(cronMatches('', at({}))).toBe(false)
  })
  // Ревью LOW: стандартный cron — dow 7≡0 (вс), */N от минимума поля.
  it('dow=7 матчит воскресенье (7 ≡ 0)', () => {
    expect(cronMatches('0 9 * * 7', at({ hour: 9, dow: 0 }))).toBe(true)
    expect(cronMatches('0 9 * * 7', at({ hour: 9, dow: 1 }))).toBe(false)
    expect(cronMatches('0 9 * * 0', at({ hour: 9, dow: 0 }))).toBe(true) // 0 тоже вс
  })
  it('*/2 на day-of-month считается от 1 (нечётные дни 1,3,5), не 2,4,6', () => {
    expect(cronMatches('0 9 */2 * *', at({ hour: 9, dom: 1 }))).toBe(true)
    expect(cronMatches('0 9 */2 * *', at({ hour: 9, dom: 3 }))).toBe(true)
    expect(cronMatches('0 9 */2 * *', at({ hour: 9, dom: 2 }))).toBe(false)
  })
})
