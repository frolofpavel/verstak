#!/usr/bin/env node
// lint:changed — ESLint только по изменённым/staged .ts/.tsx. Гейт: падает на
// errors, warnings пропускает (ratchet, не блокирует на легаси-предупреждениях).
// Используется в precommit и вручную. Никакого autofix, никакого прогона по всему репо.
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { ESLint } from 'eslint'

function changedFiles() {
  const run = (cmd) => {
    try { return execSync(cmd, { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean) }
    catch { return [] }
  }
  // Приоритет — staged (для precommit). Если ничего не застейджено — рабочее дерево vs HEAD.
  let files = run('git diff --cached --name-only --diff-filter=ACMR')
  if (files.length === 0) files = run('git diff --name-only --diff-filter=ACMR HEAD')
  return [...new Set(files)]
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => existsSync(f))
}

const files = changedFiles()
if (files.length === 0) {
  console.log('[lint:changed] нет изменённых .ts/.tsx — пропускаю')
  process.exit(0)
}

const eslint = new ESLint()
// Отсеиваем игнорируемые конфигом файлы, чтобы не сыпать "File ignored" warnings.
const lintable = []
for (const f of files) {
  if (!(await eslint.isPathIgnored(f))) lintable.push(f)
}
if (lintable.length === 0) {
  console.log('[lint:changed] изменённые файлы вне зоны линта — пропускаю')
  process.exit(0)
}

console.log(`[lint:changed] проверяю ${lintable.length} файл(ов):`)
for (const f of lintable) console.log('  ' + f)

const results = await eslint.lintFiles(lintable)
const formatter = await eslint.loadFormatter('stylish')
const output = await formatter.format(results)
if (output.trim()) console.log(output)

const errorCount = results.reduce((a, r) => a + r.errorCount, 0)
const warnCount = results.reduce((a, r) => a + r.warningCount, 0)
console.log(`[lint:changed] errors=${errorCount} warnings=${warnCount}`)
// Гейт валит ТОЛЬКО на errors. Warnings — ratchet, не блокируют.
process.exit(errorCount > 0 ? 1 : 0)
