#!/usr/bin/env node
/**
 * Тело GitHub Release берётся из CHANGELOG.md — ЕДИНСТВЕННОГО источника.
 *
 * Почему это отдельный модуль, а не три строки внутри release-publish. До 2.5.0
 * источников было ДВА: люди писали CHANGELOG.md, а публикация читала
 * `docs/RELEASE-v{version}.md` и, не найдя файла, выкладывала заглушку
 * «Verstak {version}». Файлы RELEASE-v* перестали делать после v2.4.2 — и
 * страницы релизов на GitHub стоят пустыми с 2.4.3 по 2.4.9, при том что
 * CHANGELOG всё это время вёлся исправно и даже проверялся релизным гейтом.
 *
 * Класс дефекта — не «забыли файл», а ФОЛБЭК БЕЗ СЛЕДА (CLAUDE.md §3.1):
 * заглушка молча компенсировала отсутствие нот, поэтому семь релизов подряд
 * никто не замечал потери. Поэтому здесь две вещи сразу: один источник и
 * ЧЕСТНЫЙ null вместо выдумывания текста. Решение «публиковать или нет»
 * принимает вызывающий, но принимает его ЗНАЯ.
 */
const { readFileSync } = require('fs')

/** Заголовок секции версии: «## 2.5.0 - 2026-08-10 (человеческий заголовок)». */
const SECTION_RE = /^##\s+(\S+)(.*)$/

/**
 * Достать из текста CHANGELOG секцию конкретной версии.
 *
 * Возвращает `{ title, body }` либо null, если секции нет или её тело пустое.
 * Пустая секция — это тоже отсутствие нот: «## 2.5.0» без строк под ним
 * опубликовало бы пустую страницу, то есть ровно тот дефект, который чинится.
 *
 * @param {string} changelog  содержимое CHANGELOG.md
 * @param {string} version    номер версии без «v», как в package.json
 */
function extractReleaseNotes(changelog, version) {
  const lines = String(changelog ?? '').split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const m = SECTION_RE.exec(lines[i])
    if (m && m[1] === version) { start = i; break }
  }
  if (start === -1) return null

  const title = lines[start].replace(/^##\s+/, '').trim()
  const body = []
  for (let i = start + 1; i < lines.length; i++) {
    if (SECTION_RE.test(lines[i])) break   // следующая версия — конец секции
    body.push(lines[i])
  }
  const text = body.join('\n').trim()
  if (!text) return null
  return { title, body: text }
}

/**
 * Готовое тело для GitHub Release: заголовок секции + текст.
 * null — нот нет, и вызывающий обязан остановиться, а не публиковать заглушку.
 */
function buildReleaseBody(changelogPath, version) {
  let raw
  try { raw = readFileSync(changelogPath, 'utf8') } catch { return null }
  const notes = extractReleaseNotes(raw, version)
  if (!notes) return null
  return `## ${notes.title}\n\n${notes.body}\n`
}

module.exports = { extractReleaseNotes, buildReleaseBody }
