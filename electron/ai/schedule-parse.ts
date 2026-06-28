/**
 * NL-cron (флагман next-wave) — разбор расписания на естественном языке (RU/EN) в
 * 5-польный cron + матчер «срабатывает ли cron в данную минуту». Чистая логика без
 * зависимостей и без Date.now() — время приходит снаружи (тестируемо, не плывёт).
 *
 * Поддержанные кадансы (самые частые для unattended-аудитов): каждое утро/вечер/ночь,
 * каждый день в HH:MM, по будням в HH:MM, каждый час, каждые N часов, каждые N минут,
 * еженедельно. Cron — стандартный 5-польный (minute hour dom month dow).
 */

export interface ParsedSchedule {
  cron: string   // стандартный 5-польный: minute hour dom month dow
  human: string  // человекочитаемое описание для UI
}

/** Минуты в сутках для текущего момента (для матчинга). */
export interface TimeParts {
  minute: number  // 0-59
  hour: number    // 0-23
  dom: number     // 1-31
  month: number   // 1-12
  dow: number     // 0-6 (0 = воскресенье)
}

function hm(text: string): { h: number; m: number } | null {
  // «в 9», «в 9:30», «at 21:00», «9.30»
  const re = /(?:в|at|к)\s*(\d{1,2})(?:[:.](\d{2}))?/i
  const mt = re.exec(text)
  if (!mt) return null
  const h = Number(mt[1])
  const m = mt[2] ? Number(mt[2]) : 0
  if (h > 23 || m > 59) return null
  return { h, m }
}

/**
 * Разобрать NL-расписание в cron или null (не распознано). Регистронезависимо.
 */
export function parseSchedule(nl: string): ParsedSchedule | null {
  const t = (nl ?? '').toLowerCase().trim()
  if (!t) return null

  // «каждые N минут» / «every N minutes»
  let mt = /кажд\S*\s+(\d{1,2})\s*мин|every\s+(\d{1,2})\s*min/i.exec(t)
  if (mt) {
    const n = Number(mt[1] ?? mt[2])
    if (n >= 1 && n <= 59) return { cron: `*/${n} * * * *`, human: `каждые ${n} мин` }
  }
  // «каждые N часов» / «every N hours»
  mt = /кажд\S*\s+(\d{1,2})\s*час|every\s+(\d{1,2})\s*hour/i.exec(t)
  if (mt) {
    const n = Number(mt[1] ?? mt[2])
    if (n >= 1 && n <= 23) return { cron: `0 */${n} * * *`, human: `каждые ${n} ч` }
  }
  // «каждый час» / «ежечасно» / «hourly»
  if (/кажд\S*\s+час|ежечас|hourly/i.test(t)) return { cron: '0 * * * *', human: 'каждый час' }

  // «по будням» / «every weekday» (+ опц. время, по умолчанию 9:00)
  if (/будн|weekday|рабоч\w+\s+дн/i.test(t)) {
    const time = hm(t) ?? { h: 9, m: 0 }
    return { cron: `${time.m} ${time.h} * * 1-5`, human: `по будням в ${time.h}:${String(time.m).padStart(2, '0')}` }
  }
  // «каждую неделю» / «еженедельно» / «weekly» (понедельник 9:00)
  if (/еженедель|кажд\S*\s+недел|weekly/i.test(t)) {
    const time = hm(t) ?? { h: 9, m: 0 }
    return { cron: `${time.m} ${time.h} * * 1`, human: `еженедельно (пн) в ${time.h}:${String(time.m).padStart(2, '0')}` }
  }

  // «каждое утро» / «по утрам» / «every morning»
  if (/утр\w*|morning/i.test(t)) {
    const time = hm(t) ?? { h: 9, m: 0 }
    return { cron: `${time.m} ${time.h} * * *`, human: `каждое утро в ${time.h}:${String(time.m).padStart(2, '0')}` }
  }
  // «каждый вечер» / «every evening»
  if (/вечер|evening/i.test(t)) {
    const time = hm(t) ?? { h: 21, m: 0 }
    return { cron: `${time.m} ${time.h} * * *`, human: `каждый вечер в ${time.h}:${String(time.m).padStart(2, '0')}` }
  }
  // «каждую ночь» / «every night»
  if (/ноч\w*|night/i.test(t)) {
    const time = hm(t) ?? { h: 3, m: 0 }
    return { cron: `${time.m} ${time.h} * * *`, human: `каждую ночь в ${time.h}:${String(time.m).padStart(2, '0')}` }
  }

  // «каждый день в HH[:MM]» / «ежедневно в HH» / «every day at HH»
  if (/ежедневн|кажд\S*\s+день|daily|every\s+day/i.test(t)) {
    const time = hm(t) ?? { h: 9, m: 0 }
    return { cron: `${time.m} ${time.h} * * *`, human: `каждый день в ${time.h}:${String(time.m).padStart(2, '0')}` }
  }

  return null
}

// Разобрать одно cron-поле и проверить, попадает ли значение. Поддержка: звёздочка,
// шаг (звёздочка-слэш-N), диапазон a-b, списки через запятую.
function fieldMatches(field: string, value: number): boolean {
  for (const part of field.split(',')) {
    if (part === '*') return true
    const step = /^\*\/(\d+)$/.exec(part)
    if (step) { if (value % Number(step[1]) === 0) return true; continue }
    const range = /^(\d+)-(\d+)$/.exec(part)
    if (range) { if (value >= Number(range[1]) && value <= Number(range[2])) return true; continue }
    if (Number(part) === value) return true
  }
  return false
}

/**
 * Срабатывает ли cron в данный момент времени. Сравниваем по minute/hour/dom/month/dow.
 * Невалидный cron (не 5 полей) → false (безопасно: не запускаем).
 */
export function cronMatches(cron: string, now: TimeParts): boolean {
  const f = (cron ?? '').trim().split(/\s+/)
  if (f.length !== 5) return false
  return (
    fieldMatches(f[0], now.minute) &&
    fieldMatches(f[1], now.hour) &&
    fieldMatches(f[2], now.dom) &&
    fieldMatches(f[3], now.month) &&
    fieldMatches(f[4], now.dow)
  )
}
