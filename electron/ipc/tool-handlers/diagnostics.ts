// Diagnostics-хендлеры: check_diagnostics / conversation_search / impact_analysis. Вынесено при распиле.
import type { ToolHandler } from './shared'
import { emitActivity } from './shared'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { existsSync } from 'fs'
import { safeRealJoin } from '../../ai/path-policy'
import { createSshBackend, makeSshExec, parseSshProjectPath } from '../../projects/ssh-backend'

const execFileAsync = promisify(execFile)

/**
 * Parse a single line of `tsc --noEmit --pretty false` output.
 * Format: path(line,col): error TSxxxx: message
 * Returns null if the line doesn't match.
 */
function parseTscLine(line: string): { path: string; line: number; col: number; code: string; message: string } | null {
  // Windows paths: C:\...\foo.ts(10,5): error TS2345: ...
  // Unix paths:    src/foo.ts(10,5): error TS2345: ...
  const m = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/.exec(line.trim())
  if (!m) return null
  return { path: m[1], line: parseInt(m[2], 10), col: parseInt(m[3], 10), code: m[4], message: m[5] }
}

export function buildRemoteTscCommand(): string {
  return [
    'if [ ! -f tsconfig.json ]; then',
    'echo __VERSTAK_NO_TSCONFIG__;',
    'elif [ -x ./node_modules/.bin/tsc ]; then',
    './node_modules/.bin/tsc --noEmit --pretty false;',
    'else',
    'npx tsc --noEmit --pretty false;',
    'fi'
  ].join(' ')
}

export const checkDiagnosticsHandler: ToolHandler = {
  mode: 'parallel-read',
  async handle(call, ctx) {
    const fileFilter = call.args.file ? String(call.args.file) : null
    const sshTarget = parseSshProjectPath(ctx.projectPath)

    if (sshTarget) {
      let stdout = ''
      let stderr = ''
      let exitCode: number | null = 0

      try {
        const backend = createSshBackend(sshTarget.remoteRoot, makeSshExec(sshTarget, ctx.signal))
        const res = await backend.runCommand(buildRemoteTscCommand())
        stdout = res.stdout
        stderr = res.stderr
        exitCode = res.exitCode
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        emitActivity(ctx, call, 'error', 'check_diagnostics', msg)
        return { id: call.id, name: call.name, result: '', error: `Не удалось выполнить SSH TypeScript diagnostics: ${msg}` }
      }

      if (stdout.includes('__VERSTAK_NO_TSCONFIG__')) {
        emitActivity(ctx, call, 'ok', 'check_diagnostics', 'SSH: нет tsconfig.json')
        return { id: call.id, name: call.name, result: 'SSH-проект: tsconfig.json не найден на удалённой стороне. TypeScript diagnostics пропущена.' }
      }

      const allOutput = (stdout + '\n' + stderr).split('\n')
      const errors = allOutput
        .map(parseTscLine)
        .filter((e): e is NonNullable<typeof e> => e !== null)

      const filtered = fileFilter
        ? errors.filter(e => e.path.replace(/\\/g, '/').includes(fileFilter.replace(/\\/g, '/')))
        : errors

      const raw = (stdout + '\n' + stderr).trim()
      if (filtered.length === 0 && exitCode !== 0) {
        const detail = raw.slice(0, 4000) || `exitCode=${exitCode ?? 'unknown'}`
        emitActivity(ctx, call, 'error', 'check_diagnostics', 'SSH: tsc не выполнен')
        try {
          ctx.recordRunEvent?.('verify', {
            label: 'check_diagnostics',
            detail: 'SSH TypeScript diagnostics не выполнена',
            status: 'fail'
          })
        } catch { /* best-effort */ }
        return { id: call.id, name: call.name, result: `SSH TypeScript diagnostics не выполнена или не дала распознаваемых ошибок:\n\n${detail}` }
      }

      emitActivity(ctx, call, 'ok', 'check_diagnostics', `SSH: ${filtered.length} ошибок${fileFilter ? ` в ${fileFilter}` : ''}`)
      try {
        ctx.recordRunEvent?.('verify', {
          label: 'check_diagnostics',
          detail: `SSH: ${filtered.length} ошибок TypeScript${fileFilter ? ` в ${fileFilter}` : ''}`,
          status: filtered.length === 0 ? 'pass' : 'fail'
        })
      } catch { /* best-effort */ }

      if (filtered.length === 0) {
        return { id: call.id, name: call.name, result: '✅ Нет ошибок TypeScript на SSH-проекте.' }
      }

      const lines = filtered.map(e => `${e.path}:${e.line}:${e.col} — ${e.code}: ${e.message}`)
      const header = `Found ${filtered.length} error${filtered.length === 1 ? '' : 's'}:`
      return { id: call.id, name: call.name, result: `${header}\n\n${lines.join('\n')}` }
    }

    // Проверяем наличие tsconfig.json — если нет, возвращаем понятное сообщение
    const tsconfigPath = join(ctx.projectPath, 'tsconfig.json')
    if (!existsSync(tsconfigPath)) {
      emitActivity(ctx, call, 'ok', 'check_diagnostics', 'нет tsconfig.json')
      return { id: call.id, name: call.name, result: 'tsconfig.json не найден — проект не TypeScript или tsconfig в нестандартном месте.' }
    }

    // Ищем tsc из node_modules проекта, чтобы не требовать глобальной установки
    const localTsc = join(ctx.projectPath, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
    const tscBin = existsSync(localTsc) ? localTsc : 'npx'
    const tscArgs = tscBin === 'npx'
      ? ['tsc', '--noEmit', '--pretty', 'false']
      : ['--noEmit', '--pretty', 'false']

    let stdout = ''
    let stderr = ''
    try {
      const res = await execFileAsync(tscBin, tscArgs, {
        cwd: ctx.projectPath,
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024
      })
      stdout = res.stdout
      stderr = res.stderr
    } catch (err) {
      // tsc exits with non-zero when there are errors — that's expected.
      // We still want to parse the output.
      const e = err as { stdout?: string; stderr?: string; code?: number; message?: string }
      stdout = e.stdout ?? ''
      stderr = e.stderr ?? ''
      // If it's a real spawn error (ENOENT / EACCES), stderr will be empty and message will describe it
      if (!stdout && !stderr && e.message) {
        emitActivity(ctx, call, 'error', 'check_diagnostics', e.message)
        return { id: call.id, name: call.name, result: '', error: `Не удалось запустить tsc: ${e.message}` }
      }
    }

    const allOutput = (stdout + '\n' + stderr).split('\n')
    const errors = allOutput
      .map(parseTscLine)
      .filter((e): e is NonNullable<typeof e> => e !== null)

    const filtered = fileFilter
      ? errors.filter(e => e.path.replace(/\\/g, '/').includes(fileFilter.replace(/\\/g, '/')))
      : errors

    emitActivity(ctx, call, 'ok', 'check_diagnostics', `${filtered.length} ошибок${fileFilter ? ` в ${fileFilter}` : ''}`)
    // Timeline задачи (Фаза 4): check_diagnostics — это верификация. 0 ошибок →
    // pass, иначе fail (waiting_review вычисляется из последнего verify=fail).
    try {
      ctx.recordRunEvent?.('verify', {
        label: 'check_diagnostics',
        detail: `${filtered.length} ошибок TypeScript${fileFilter ? ` в ${fileFilter}` : ''}`,
        status: filtered.length === 0 ? 'pass' : 'fail'
      })
    } catch { /* best-effort */ }

    if (filtered.length === 0) {
      return { id: call.id, name: call.name, result: '✅ Нет ошибок TypeScript.' }
    }

    const lines = filtered.map(e => `${e.path}:${e.line}:${e.col} — ${e.code}: ${e.message}`)
    const header = `Found ${filtered.length} error${filtered.length === 1 ? '' : 's'}:`
    return { id: call.id, name: call.name, result: `${header}\n\n${lines.join('\n')}` }
  }
}

// ============================================================================
// conversation_search — FTS5 search across past chat messages
// ============================================================================

export const conversationSearchHandler: ToolHandler = {
  mode: 'parallel-read',
  async handle(call, ctx) {
    try {
      const query = String(call.args.query ?? '').trim()
      const limit = typeof call.args.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(call.args.limit))) : 10
      const results = ctx.searchConversations(ctx.projectPath, query, limit)
      emitActivity(ctx, call, 'ok', 'conversation_search', `"${query}" · ${results.length} результатов`)
      if (results.length === 0) {
        return { id: call.id, name: call.name, result: 'Ничего не найдено в истории разговоров.' }
      }
      const lines: string[] = [`Found ${results.length} results:\n`]
      for (const r of results) {
        const date = new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 16)
        lines.push(`[Session #${r.session_id}, ${date}] ${r.role}:\n${r.content}\n`)
      }
      return { id: call.id, name: call.name, result: lines.join('\n') }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

// ============================================================================
// convert_file — конвертация не-текстовых форматов в markdown/text
// ============================================================================




// ============================================================================
// impact_analysis — Feature 6: что сломается при изменении файла/символа
// ============================================================================

export const impactAnalysisHandler: ToolHandler = {
  mode: 'parallel-read',
  async handle(call, ctx) {
    try {
      const { getDependencyMap } = await import('../../ai/project-map')
      const { readFile } = await import('fs/promises')
      const { safeRealJoin } = await import('../../ai/path-policy')

      const file = String(call.args.file ?? '').replace(/\\/g, '/')
      if (!file) {
        return { id: call.id, name: call.name, result: '', error: 'impact_analysis: file обязателен' }
      }
      const symbol = call.args.symbol ? String(call.args.symbol) : null

      const depMap = await getDependencyMap(ctx.projectPath)
      const fileInfo = depMap.files[file]
      if (!fileInfo) {
        // Try to find a close match (with/without extension)
        const candidates = Object.keys(depMap.files).filter(k =>
          k === file || k.startsWith(file + '.') || k.startsWith(file + '/index.')
        )
        if (candidates.length === 0) {
          return { id: call.id, name: call.name, result: `Файл "${file}" не найден в dependency map. Убедись что путь корректный (относительно корня проекта).` }
        }
        // Re-run with the first candidate
        call = { ...call, args: { ...call.args, file: candidates[0] } }
        return impactAnalysisHandler.handle(call, ctx)
      }

      const direct = fileInfo.importedBy
      // Transitive level 2 (max depth 3 total)
      const level2: Map<string, string[]> = new Map()  // file → via which direct dep
      for (const d of direct) {
        const dInfo = depMap.files[d]
        if (!dInfo) continue
        for (const d2 of dInfo.importedBy) {
          if (d2 !== file && !direct.includes(d2)) {
            if (!level2.has(d2)) level2.set(d2, [])
            level2.get(d2)!.push(d)
          }
        }
      }
      const level3: Map<string, string[]> = new Map()  // file → via which l2 dep
      for (const [l2file] of level2) {
        const l2Info = depMap.files[l2file]
        if (!l2Info) continue
        for (const d3 of l2Info.importedBy) {
          if (d3 !== file && !direct.includes(d3) && !level2.has(d3)) {
            if (!level3.has(d3)) level3.set(d3, [])
            level3.get(d3)!.push(l2file)
          }
        }
      }

      const lines: string[] = [`📁 ${file}`]
      if (fileInfo.exports.length > 0) {
        lines.push(`\nЭкспорты: ${fileInfo.exports.join(', ')}`)
      }

      if (direct.length === 0 && level2.size === 0) {
        lines.push('\nНет зависимых файлов — файл ни кем не импортируется.')
      } else {
        lines.push(`\nПрямые зависимости (импортируют этот файл):`)
        if (direct.length === 0) {
          lines.push('  (нет)')
        } else {
          for (const d of direct) lines.push(`  → ${d}`)
        }

        if (level2.size > 0) {
          lines.push(`\nТранзитивные (2-й уровень):`)
          for (const [f, vias] of level2) {
            lines.push(`  → ${f} (через ${vias.join(', ')})`)
          }
        }

        if (level3.size > 0) {
          lines.push(`\nТранзитивные (3-й уровень):`)
          for (const [f, vias] of level3) {
            lines.push(`  → ${f} (через ${vias.join(', ')})`)
          }
        }
      }

      // Symbol search — grep for usage in dependent files
      if (symbol) {
        const symbolHits: string[] = []
        const allDeps = [...direct, ...Array.from(level2.keys()), ...Array.from(level3.keys())]
        for (const dep of allDeps) {
          try {
            const abs = await safeRealJoin(ctx.projectPath, dep)
            const content = await readFile(abs, 'utf8')
            const depLines = content.split('\n')
            for (let i = 0; i < depLines.length; i++) {
              if (depLines[i].includes(symbol)) {
                const snippet = depLines[i].trim().slice(0, 120)
                symbolHits.push(`  → ${dep}:${i + 1} — ${snippet}`)
                break  // one hit per file is enough for overview
              }
            }
          } catch { /* skip unreadable files */ }
        }
        if (symbolHits.length > 0) {
          lines.push(`\nИспользуют символ "${symbol}":`)
          lines.push(...symbolHits)
        } else {
          lines.push(`\nСимвол "${symbol}" не найден в зависимых файлах.`)
        }
      }

      emitActivity(ctx, call, 'ok', 'impact_analysis', `${file} · ${direct.length} прямых зависимостей`)
      return { id: call.id, name: call.name, result: lines.join('\n') }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}
