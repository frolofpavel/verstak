#!/usr/bin/env node
// format:check:changed — Prettier --check ТОЛЬКО по изменённым/staged файлам.
// Report-only: печатает файлы, чьё форматирование расходится с .prettierrc, и
// возвращает НЕнулевой код (для явного запуска), но НЕ встроен в precommit как
// блокер — легаси не переформатируется массово (план §1.3: format-only commit
// делается вручную перед рефактором конкретного модуля). Никакого прогона по
// всему репозиторию.
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|css|md)$/

function changed() {
  const run = (cmd) => {
    try { return execSync(cmd, { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean) }
    catch { return [] }
  }
  let files = run('git diff --cached --name-only --diff-filter=ACMR')
  if (files.length === 0) files = run('git diff --name-only --diff-filter=ACMR HEAD')
  return [...new Set(files)].filter((f) => EXT.test(f)).filter((f) => existsSync(f))
}

const files = changed()
if (files.length === 0) {
  console.log('[format:check:changed] нет изменённых файлов под Prettier — пропускаю')
  process.exit(0)
}

try {
  execSync(`npx prettier --check ${files.map((f) => JSON.stringify(f)).join(' ')}`, { stdio: 'inherit' })
  process.exit(0)
} catch {
  console.log('\n[format:check:changed] выше — файлы с расхождением форматирования.')
  console.log('Отформатировать перед рефактором модуля: npx prettier --write <файл>')
  process.exit(1)
}
