#!/usr/bin/env node
/**
 * Чистый вердикт install-smoke-теста: по СОБРАННЫМ сигналам старта установленного
 * приложения (маркер готовности / фатальные события в логах / ранний выход процесса)
 * решает PASS | FAIL | INCONCLUSIVE. Вынесен из smoke-install.mjs, чтобы «умеет ли
 * проверка краснеть» доказывалось юнит-пинами на фикстуре, а не только живым запуском.
 *
 * Проверка, которая никогда не видела мёртвого приложения, краснеть не умеет — поэтому
 * фатальные события заданы явно, и на них есть красные пины (render_process_gone и родня).
 */

// События из <userData>/logs/errors.jsonl, означающие мёртвый старт. render_process_gone
// и db.open.fail пишет сам main (electron/main.ts) — render_process_gone наблюдался у
// установленной 2.4.5 (ACCESS_VIOLATION рендерера). Оба сигнала есть уже в 2.4.6.
const FATAL_EVENTS = [
  'window.render_process_gone',
  'window.unresponsive',
  'window.preload_error',
  'window.did_fail_load',
  'db.open.fail',
]
const FATAL_TEXT = /NODE_MODULE_VERSION|render[_-]?process[_-]?gone|ACCESS_VIOLATION|better_sqlite3\.node/i

// Позитивные маркеры здорового старта. startup.ok (окно + БД) добавлен под smoke
// (electron/main.ts, за VERSTAK_SMOKE); db.open.ok пишется в ЛЮБОЙ сборке при открытии
// БД — поэтому харнесс наблюдает позитив и на 2.4.6, где нового маркера ещё нет.
const POSITIVE_EVENTS = ['startup.ok', 'db.open.ok']

/** Одна разобранная строка jsonl → фатальна ли она. */
function isFatalLogLine(line) {
  if (!line || typeof line !== 'object') return false
  if (line.level === 'error' && typeof line.event === 'string' && FATAL_EVENTS.includes(line.event)) return true
  // Подстраховка по тексту: reason/сообщение краша, даже под незнакомым событием.
  const blob = `${line.event || ''} ${line.reason || ''} ${line.message || ''}`
  return line.level === 'error' && FATAL_TEXT.test(blob)
}

/** Одна разобранная строка jsonl → позитивный ли это маркер готовности. */
function isPositiveLogLine(line) {
  return !!line && typeof line === 'object' && typeof line.event === 'string' && POSITIVE_EVENTS.includes(line.event)
}

/**
 * @param {{sawStartupOk:boolean, fatalEvents:string[], exitedEarly:boolean, exitCode:number|null, waitedMs:number, timeoutMs:number}} s
 * @returns {{verdict:'PASS'|'FAIL'|'INCONCLUSIVE', reason:string}}
 */
function classifyStartup(s) {
  const fatal = s.fatalEvents || []
  // Фатальные события старшинством выше всего: приложение объявило смерть.
  if (fatal.length > 0) return { verdict: 'FAIL', reason: `фатальное событие в логах: ${fatal.join(', ')}` }
  // Ранний выход процесса до маркера готовности — тоже смерть (VERSTAK_SMOKE exit(1) при
  // негодном native-модуле, либо просто краш процесса).
  if (s.exitedEarly && !s.sawStartupOk) {
    return { verdict: 'FAIL', reason: `процесс вышел до готовности (код ${s.exitCode ?? 'n/a'})` }
  }
  // Позитивный маркер: окно показано И БД открыта. Без него «не упало за N сек» ≠ «живо».
  if (s.sawStartupOk) return { verdict: 'PASS', reason: 'позитивный маркер готовности получен (startup.ok/db.open.ok)' }
  // Маркера нет и время вышло — считаем мёртвым (мог зависнуть на модалке/чёрном экране).
  if (s.waitedMs >= s.timeoutMs) {
    return { verdict: 'FAIL', reason: `нет маркера startup.ok за ${s.timeoutMs} мс` }
  }
  return { verdict: 'INCONCLUSIVE', reason: 'ещё ждём' }
}

module.exports = { classifyStartup, isFatalLogLine, isPositiveLogLine, FATAL_EVENTS, POSITIVE_EVENTS }
