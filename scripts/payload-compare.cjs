#!/usr/bin/env node
/**
 * Пофайловая сверка пейлоада установщика с эталоном release/win-unpacked.
 *
 * Зачем: установщик кладёт пользователю РОВНО то, что лежит в app-payload.7z
 * (engine.ts копирует без фильтров), а сам пейлоад строится копией win-unpacked
 * с фильтром в build-setup.cjs. Потерянный на этом шаге каталог молча уезжает
 * КАЖДОМУ пользователю Setup-артефакта — так три версии подряд (2.4.5–2.4.7)
 * ставились без locales, и рендер падал access violation в серое окно.
 * Smoke-тест на win-unpacked этого класса не видит ПО ПОСТРОЕНИЮ: он проверяет
 * эталон, а не то, что реально ставится.
 *
 * Сверка по списку файлов + размерам (не хешам — осознанно: класс дефекта
 * «файл потерян/обрезан», а побайтовое расхождение при равной длине ловит
 * провенанс сборки; хеш ~800 МБ дерева стоил бы гейту десятки секунд).
 */
const fs = require('fs')
const path = require('path')

// В эталоне win-unpacked игнорируется вложенный app-payload прошлой сборки —
// единственное, что сборщик пейлоада вправе отсечь (см. PAYLOAD_SKIP).
const UNPACKED_IGNORE = new Set(['app-payload'])
// В пейлоаде допускаются служебные файлы установщика, которых нет в эталоне.
const PAYLOAD_EXTRA_ALLOW = new Set(['payload-manifest.json'])

/** Рекурсивный список файлов: rel (posix) → размер. */
function listFilesWithSize(root, ignoreTopLevel = new Set()) {
  const out = new Map()
  const walk = (dir, relBase) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (relBase === '' && ignoreTopLevel.has(entry.name)) continue
      const abs = path.join(dir, entry.name)
      const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`
      if (entry.isDirectory()) walk(abs, rel)
      else if (entry.isFile()) out.set(rel, fs.statSync(abs).size)
    }
  }
  walk(root, '')
  return out
}

/**
 * @returns {{ok: boolean, missing: string[], sizeMismatch: Array<{rel: string, expected: number, actual: number}>, extra: string[], comparedCount: number}}
 */
function comparePayloadTrees(unpackedDir, payloadDir) {
  const expected = listFilesWithSize(unpackedDir, UNPACKED_IGNORE)
  const actual = listFilesWithSize(payloadDir)

  const missing = []
  const sizeMismatch = []
  for (const [rel, size] of expected) {
    if (!actual.has(rel)) missing.push(rel)
    else if (actual.get(rel) !== size) {
      sizeMismatch.push({ rel, expected: size, actual: actual.get(rel) })
    }
  }
  // Лишний неизвестный файл тоже роняет: пейлоад, куда попало что-то мимо
  // эталона, собран не тем сборщиком, что мы думаем. Новый служебный файл
  // добавляется в PAYLOAD_EXTRA_ALLOW осознанной правкой.
  const extra = [...actual.keys()].filter(
    rel => !expected.has(rel) && !PAYLOAD_EXTRA_ALLOW.has(rel),
  )

  missing.sort()
  extra.sort()
  return {
    ok: missing.length === 0 && sizeMismatch.length === 0 && extra.length === 0,
    missing,
    sizeMismatch,
    extra,
    comparedCount: expected.size,
  }
}

/** Короткая человекочитаемая причина для строки гейта. */
function describeCompareResult(r) {
  if (r.ok) return `${r.comparedCount} файлов совпали`
  const parts = []
  if (r.missing.length) parts.push(`потеряно ${r.missing.length}: ${r.missing.slice(0, 5).join(', ')}${r.missing.length > 5 ? '…' : ''}`)
  if (r.sizeMismatch.length) parts.push(`размер расходится у ${r.sizeMismatch.length}: ${r.sizeMismatch.slice(0, 3).map(m => m.rel).join(', ')}${r.sizeMismatch.length > 3 ? '…' : ''}`)
  if (r.extra.length) parts.push(`лишние ${r.extra.length}: ${r.extra.slice(0, 5).join(', ')}${r.extra.length > 5 ? '…' : ''}`)
  return parts.join('; ')
}

module.exports = { comparePayloadTrees, describeCompareResult, PAYLOAD_EXTRA_ALLOW, UNPACKED_IGNORE }
