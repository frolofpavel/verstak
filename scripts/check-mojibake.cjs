#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const TARGETS = ['src', 'electron', 'scripts', 'docs']
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.md'])
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'out',
  'release',
  'dist',
  'coverage',
  '.vite',
  '.turbo'
])
const SKIP_FILES = new Set([
  'scripts/check-mojibake.cjs',
  'docs/PROJECT_SETTINGS_ENCODING_FIX_PLAN.md',
  'electron/storage/journal.ts'
])

const PATTERNS = [
  '\u0420\u045F\u0420',
  '\u0420\u045F\u0421',
  '\u0420\u040E\u0420',
  '\u0420\u040E\u0421',
  '\u0420\u0459\u0420',
  '\u0420\u0459\u0421',
  '\u0420\u0405\u0420',
  '\u0420\u0405\u0421',
  '\u0420\u0401\u0420',
  '\u0420\u0401\u0421',
  '\u0420\u201D\u0420',
  '\u0420\u201D\u0421',
  '\u0420\u0406\u0420',
  '\u0420\u0406\u0421',
  '\u0421\u040A\u0420',
  '\u0421\u040A\u0421',
  '\u0421\u040B\u0420',
  '\u0421\u040B\u0421',
  '\u0421\u040C\u0420',
  '\u0421\u040C\u0421',
  '\u0421\u0452\u0420',
  '\u0421\u0452\u0421',
  '\u0421\u2039\u0420',
  '\u0421\u2039\u0421'
].map((value) => JSON.parse('"' + value + '"'))

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, files)
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full)
    }
  }
  return files
}

function snippet(line, pattern) {
  const index = line.indexOf(pattern)
  const start = Math.max(0, index - 36)
  const end = Math.min(line.length, index + pattern.length + 36)
  return line.slice(start, end).trim()
}

const findings = []
for (const target of TARGETS) {
  for (const file of walk(path.join(ROOT, target))) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    if (SKIP_FILES.has(rel)) continue
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split(/\r?\n/)
    lines.forEach((line, index) => {
      for (const pattern of PATTERNS) {
        if (line.includes(pattern)) {
          findings.push({
            file: rel,
            line: index + 1,
            pattern,
            snippet: snippet(line, pattern)
          })
          break
        }
      }
    })
  }
}

if (findings.length > 0) {
  console.error('[check-mojibake] Possible broken UTF-8/Windows-1251 text found:')
  for (const item of findings.slice(0, 80)) {
    console.error(item.file + ':' + item.line + ' ' + item.snippet)
  }
  if (findings.length > 80) {
    console.error('[check-mojibake] ...and ' + (findings.length - 80) + ' more matches')
  }
  process.exit(1)
}

console.log('[check-mojibake] OK')
