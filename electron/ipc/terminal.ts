import { ipcMain, BrowserWindow } from 'electron'
import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import { existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { resolve, relative, isAbsolute, sep } from 'path'

const sessions = new Map<number, pty.IPty>()

/** Безопасный cwd для терминала: если запрошенный путь существует И лежит
 *  внутри одного из известных корней проектов — используем его; иначе
 *  откатываемся в домашнюю папку (не спавним в произвольной системной директории). */
export function resolveSafeTerminalCwd(requested: string | undefined, knownRoots: string[], home: string = homedir()): string {
  if (!requested) return home
  let abs: string
  try { abs = resolve(requested) } catch { return home }
  try { if (!existsSync(abs) || !statSync(abs).isDirectory()) return home } catch { return home }
  for (const root of knownRoots) {
    if (!root) continue
    const r = relative(resolve(root), abs)
    // внутри корня: r не начинается с .. и не абсолютный (anti drive-bypass)
    if (r === '' || (!r.startsWith('..') && !r.includes('..' + sep) && !isAbsolute(r))) return abs
  }
  return home
}

/**
 * Per-session buffer для error detection. Накапливаем последние ~4KB stdout
 * чтобы паттерны ловили multi-line ошибки (Python traceback с file/line),
 * но не разрастались.
 */
const errBuffers = new Map<number, string>()
const BUFFER_MAX = 4096

/**
 * Паттерны типичных ошибок dev-инструментов. Каждый ловит ошибку и
 * вытаскивает из неё структурную инфу (тип, file, line, message).
 */
interface DetectedError {
  kind: 'typescript' | 'python' | 'npm' | 'eslint' | 'generic'
  file?: string
  line?: number
  message: string
  raw: string
}

function detectErrorInBuffer(buf: string): DetectedError | null {
  // TypeScript: src/file.ts(42,5): error TS2322: ...
  const tsM = buf.match(/([^\s:]+\.ts[x]?)\((\d+),\d+\):\s*error\s+TS\d+:\s*([^\n]+)/)
  if (tsM) return { kind: 'typescript', file: tsM[1], line: parseInt(tsM[2], 10), message: tsM[3].trim(), raw: tsM[0] }

  // Python traceback (последняя строка File "path", line N + следующая)
  const pyM = buf.match(/File\s+"([^"]+)",\s+line\s+(\d+)[\s\S]{0,500}?\n([A-Z]\w+(?:Error|Exception):\s*[^\n]+)/)
  if (pyM) return { kind: 'python', file: pyM[1], line: parseInt(pyM[2], 10), message: pyM[3].trim(), raw: pyM[0] }

  // npm ERR!
  const npmM = buf.match(/npm\s+ERR!\s+([^\n]+)/)
  if (npmM) return { kind: 'npm', message: npmM[1].trim(), raw: npmM[0] }

  // ESLint: src/x.ts:10:5: error ...
  const eslintM = buf.match(/([^\s]+\.[jt]sx?):(\d+):\d+:\s*error\s+([^\n]+)/)
  if (eslintM) return { kind: 'eslint', file: eslintM[1], line: parseInt(eslintM[2], 10), message: eslintM[3].trim(), raw: eslintM[0] }

  // Generic Error: ...
  const genericM = buf.match(/^Error:\s+([^\n]+)/m)
  if (genericM) return { kind: 'generic', message: genericM[1].trim(), raw: genericM[0] }

  return null
}

export function killAllTerminalSessions(): void {
  for (const [id, p] of [...sessions.entries()]) {
    try { p.kill() } catch { /* already dead */ }
    sessions.delete(id)
    errBuffers.delete(id)
  }
}

export function registerTerminalIpc(getKnownRoots: () => string[] = () => []): void {
  ipcMain.handle('term:spawn', (e, cwd: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return -1
    const safeCwd = resolveSafeTerminalCwd(cwd, getKnownRoots())
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash'
    const env = {
      ...(process.env as Record<string, string>),
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    }
    const args = process.platform === 'win32'
      ? [
          '-NoLogo',
          '-NoExit',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new(); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $OutputEncoding=[System.Text.UTF8Encoding]::new(); chcp 65001 > $null"
        ]
      : []
    const p = pty.spawn(shell, args, {
      cwd: safeCwd,
      cols: 100,
      rows: 30,
      env,
      ...(process.platform === 'win32' ? { useConpty: false } : {}),
    })
    const id = p.pid
    sessions.set(id, p)
    errBuffers.set(id, '')

    // Sidecar Terminal Intelligence: накапливаем buffer, дёргаем detector
    // на каждый chunk, эмитим term:error-detected когда находим что-то новое.
    let lastEmittedRaw = ''  // дедупликация — не эмитим одну и ту же ошибку повторно
    p.onData(data => {
      e.sender.send('term:data', { id, data })

      let buf = (errBuffers.get(id) ?? '') + data
      if (buf.length > BUFFER_MAX) buf = buf.slice(-BUFFER_MAX)
      errBuffers.set(id, buf)

      const err = detectErrorInBuffer(buf)
      if (err && err.raw !== lastEmittedRaw) {
        lastEmittedRaw = err.raw
        e.sender.send('term:error-detected', { id, error: err })
      }
    })
    p.onExit(() => {
      sessions.delete(id)
      errBuffers.delete(id)
      e.sender.send('term:exit', { id })
    })
    return id
  })
  ipcMain.handle('term:write', (_e, id: number, data: string) => sessions.get(id)?.write(data))
  ipcMain.handle('term:resize', (_e, id: number, cols: number, rows: number) => sessions.get(id)?.resize(cols, rows))
  ipcMain.handle('term:kill', (_e, id: number) => { sessions.get(id)?.kill(); sessions.delete(id) })
}
