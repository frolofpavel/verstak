#!/usr/bin/env node
// Code-health baseline report — воспроизводимый статический снимок качества кода.
// Метрики: крупнейшие файлы, длинные функции (>100 / >200 строк), обходы типизации
// (as any / : any / @ts-ignore / eslint-disable), сводка тестов.
//
// Ничего не исполняет из продукта, не читает секреты, не ходит в сеть. Только чтение
// исходников через fs + разбор AST через установленный `typescript`. Вывод — в stdout
// и в docs/CODE_HEALTH_BASELINE.md (секция METRICS перезаписывается целиком).
//
// Запуск: node scripts/code-health-report.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const PROD_ROOTS = ['electron', 'src']
const TEST_ROOTS = ['tests']
const IGNORE_DIRS = new Set(['node_modules', 'out', 'release', 'dist', 'coverage', '.git', '.worktrees'])
const CODE_EXT = new Set(['.ts', '.tsx'])

/** Рекурсивный обход дерева с отсечением служебных папок. */
function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIRS.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, acc)
    else if (CODE_EXT.has(extname(name))) acc.push(full)
  }
  return acc
}

const isTestFile = (p) => /\.(test|spec)\.tsx?$/.test(p)

function collect(roots, { tests }) {
  const files = []
  for (const r of roots) {
    for (const f of walk(join(ROOT, r))) {
      if (tests ? isTestFile(f) : !isTestFile(f)) files.push(f)
    }
  }
  return files
}

/** Длины функций через AST: каждый function-like узел с телом считается отдельно. */
function functionSpans(file, text) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const spans = []
  const visit = (node) => {
    const isFn =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    if (isFn && node.body) {
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
      const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line
      const lines = end - start + 1
      let name = 'anonymous'
      if (node.name && ts.isIdentifier(node.name)) name = node.name.text
      else if (ts.isConstructorDeclaration(node)) name = 'constructor'
      else if (node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) name = node.parent.name.text
      else if (node.parent && ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) name = node.parent.name.text
      spans.push({ name, lines, startLine: start + 1 })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return spans
}

const SUPPRESSIONS = [
  { key: 'as any', re: /\bas\s+any\b/g },
  { key: ': any', re: /:\s*any\b/g },
  { key: '@ts-ignore', re: /@ts-ignore\b/g },
  { key: '@ts-nocheck', re: /@ts-nocheck\b/g },
  { key: 'eslint-disable', re: /eslint-disable\b/g },
]

function analyze(files) {
  const perFile = []
  const supp = Object.fromEntries(SUPPRESSIONS.map((s) => [s.key, 0]))
  const suppHits = Object.fromEntries(SUPPRESSIONS.map((s) => [s.key, []]))
  let totalLines = 0
  const fnOver100 = []
  const fnOver200 = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    const rel = relative(ROOT, f).split(sep).join('/')
    const lineCount = text.split('\n').length
    totalLines += lineCount
    perFile.push({ rel, lineCount })
    for (const s of SUPPRESSIONS) {
      const m = text.match(s.re)
      if (m) { supp[s.key] += m.length; suppHits[s.key].push({ rel, n: m.length }) }
    }
    for (const span of functionSpans(f, text)) {
      if (span.lines > 200) fnOver200.push({ rel, ...span })
      else if (span.lines > 100) fnOver100.push({ rel, ...span })
    }
  }
  return { perFile, supp, suppHits, totalLines, fnOver100, fnOver200 }
}

/** Сводка тестов статически: число тест-файлов + число it()/test() без запуска suite. */
function testSummary(files) {
  let cases = 0
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    const m = text.match(/\b(it|test)\s*(\.\w+)?\s*\(/g)
    if (m) cases += m.length
  }
  return { fileCount: files.length, caseCount: cases }
}

const prodFiles = collect(PROD_ROOTS, { tests: false })
const testFiles = collect(TEST_ROOTS, { tests: true })
const prod = analyze(prodFiles)
const tests = testSummary(testFiles)
const testLines = testFiles.reduce((a, f) => a + readFileSync(f, 'utf8').split('\n').length, 0)

const over200 = prod.fnOver200.sort((a, b) => b.lines - a.lines)
const over100 = prod.fnOver100.sort((a, b) => b.lines - a.lines)
const largest = prod.perFile.sort((a, b) => b.lineCount - a.lineCount).slice(0, 15)

const num = (n) => String(n).padStart(6)
const lines = []
lines.push('## METRICS (авто-генерация: scripts/code-health-report.mjs)')
lines.push('')
lines.push('> Детерминированный статический снимок. Перезапуск на том же коммите даёт те же числа.')
lines.push('')
lines.push('| Показатель | Значение |')
lines.push('|---|---:|')
lines.push(`| Продакшн TS/TSX (electron/ + src/) | ${prodFiles.length} файлов, ${prod.totalLines} строк |`)
lines.push(`| Тестовый TS/TSX (tests/) | ${testFiles.length} файлов, ${testLines} строк |`)
lines.push(`| Тест-кейсов (статически it/test) | ${tests.caseCount} |`)
lines.push(`| Функций > 100 строк | ${over100.length + over200.length} |`)
lines.push(`| Функций > 200 строк | ${over200.length} |`)
for (const s of SUPPRESSIONS) lines.push(`| \`${s.key}\` (prod) | ${prod.supp[s.key]} |`)
lines.push('')

lines.push('### Топ-15 крупнейших prod-файлов')
lines.push('')
lines.push('| Строк | Файл |')
lines.push('|---:|---|')
for (const f of largest) lines.push(`| ${f.lineCount} | \`${f.rel}\` |`)
lines.push('')

lines.push(`### Функции > 200 строк (${over200.length})`)
lines.push('')
lines.push('| Строк | Функция | Файл:строка |')
lines.push('|---:|---|---|')
for (const fn of over200) lines.push(`| ${fn.lines} | \`${fn.name}\` | \`${fn.rel}:${fn.startLine}\` |`)
lines.push('')

lines.push(`### Обходы типизации — где именно`)
lines.push('')
for (const s of SUPPRESSIONS) {
  const hits = prod.suppHits[s.key]
  if (!hits.length) continue
  lines.push(`- \`${s.key}\` (${prod.supp[s.key]}): ` + hits.map((h) => `${h.rel}×${h.n}`).join(', '))
}
lines.push('')

const metricsBlock = lines.join('\n')

// stdout — краткая сводка
console.log(metricsBlock)

// docs — сохраняем полностью в секцию METRICS, шапку baseline не трогаем если есть
const OUT = join(ROOT, 'docs', 'CODE_HEALTH_BASELINE.md')
const header = `# Code Health Baseline — Verstak\n\n**Коммит на момент снимка:** генерируется отдельно (см. git log).\n**Скрипт:** \`node scripts/code-health-report.mjs\`\n\n`
let existing = ''
if (existsSync(OUT)) {
  const cur = readFileSync(OUT, 'utf8')
  const idx = cur.indexOf('## METRICS')
  existing = idx >= 0 ? cur.slice(0, idx) : cur + '\n'
} else {
  existing = header
}
writeFileSync(OUT, existing + metricsBlock + '\n', 'utf8')
console.error(`\n[code-health] записано → ${relative(ROOT, OUT).split(sep).join('/')}`)
