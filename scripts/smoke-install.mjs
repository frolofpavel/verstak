#!/usr/bin/env node
// INSTALL SMOKE-ТЕСТ: доказывает, что установленное приложение не просто РАСПАКОВАНО, а
// ЖИВЁТ. Гейт до этого проверял ФАЙЛЫ (кол-во пакетов, наличие .node) и дважды пропускал
// нежизнеспособную сборку: 31.07 (недоупакованный asar) и 08.08 (серое окно 2.4.5,
// render_process_gone). Харнесс копирует РАБОЧУЮ сборку в temp, при желании ЛОМАЕТ копию
// намеренно, запускает с ИЗОЛИРОВАННЫМ userData (VERSTAK_DEV_USER_DATA_DIR) и наблюдает
// РЕАЛЬНОСТЬ через логи приложения: позитивный маркер старта против фатальных событий.
//
// Установку Павла НЕ трогает: работает на копии, свой userData, teardown в конце.
//
// Запуск:
//   node scripts/smoke-install.mjs --source <dir с Verstak.exe> [--break none|db|renderer]
//                                  [--expect PASS|FAIL] [--timeout 30000] [--keep]
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { classifyStartup, isFatalLogLine, isPositiveLogLine } = require('./smoke-verdict.cjs')

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def
}
const hasFlag = name => process.argv.includes(`--${name}`)

const DEFAULT_SOURCE = join(process.env.LOCALAPPDATA || '', 'Programs', 'Verstak')
const source = arg('source', DEFAULT_SOURCE)
const breakKind = arg('break', 'none') // none | db | renderer
const expect = (arg('expect', '') || '').toUpperCase() // PASS | FAIL | ''
const timeoutMs = Number.parseInt(arg('timeout', '30000'), 10)
const settleMs = Number.parseInt(arg('settle', '3500'), 10) // после позитива ждём фатал
const keep = hasFlag('keep')

function die(msg) {
  console.error(`[smoke] ✗ ${msg}`)
  process.exit(2)
}

if (!existsSync(join(source, 'Verstak.exe'))) die(`нет Verstak.exe в --source: ${source}`)

const SMOKE_PREFIX = 'verstak-smoke-'
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Подметаем хвосты ПРОШЛЫХ прогонов: Windows держит образ .exe ещё несколько секунд после
// выхода процесса, и если предыдущий прогон не успел стереть temp — стираем сейчас. Так
// накопление ограничено даже при неудачном teardown отдельного прогона.
function sweepStale() {
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith(SMOKE_PREFIX)) continue
      try { rmSync(join(tmpdir(), name), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}
sweepStale()

const work = mkdtempSync(join(tmpdir(), SMOKE_PREFIX))
const appDir = join(work, 'app')
const userData = join(work, 'userData')
mkdirSync(userData, { recursive: true })

// Синхронный последний-шанс (process 'exit' не умеет await). Основную уборку с ожиданием
// освобождения хендлов делает cleanupWithRetries().
function cleanup() {
  if (keep) return
  try { rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch { /* best-effort */ }
}

// Windows отпускает образ .exe/.node не мгновенно после killTree — крутим удаление до ~20с.
async function cleanupWithRetries() {
  if (keep) {
    console.log(`[smoke] --keep: оставляю ${work}`)
    return
  }
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); if (!existsSync(work)) return }
    catch { /* ещё держится */ }
    if (!existsSync(work)) return
    await sleep(1000)
  }
  console.warn(`[smoke] ⚠ не смог стереть ${work} за 20с — подметётся следующим прогоном (sweepStale)`)
}

// --- Внесение поломки в КОПИЮ (не в оригинал) ---
function breakDb() {
  // Сносим и модуль, и резервную копию, и каталог build — чтобы самопочинка не восстановила.
  const bs = join(appDir, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build')
  const fix = join(appDir, 'resources', 'native-fix')
  rmSync(bs, { recursive: true, force: true })
  rmSync(fix, { recursive: true, force: true })
  console.log('[smoke] поломка db: снесены better-sqlite3/build + native-fix')
}
function breakRenderer() {
  // Сносим preload (распакован через asarUnpack) — окно не может инициализировать рендерер,
  // Electron эмитит preload-error/render-process-gone. Это класс краха установленной 2.4.5.
  const preload = join(appDir, 'resources', 'app.asar.unpacked', 'out', 'preload')
  if (existsSync(preload)) {
    rmSync(preload, { recursive: true, force: true })
    console.log('[smoke] поломка renderer: снесён out/preload')
  } else {
    // Фолбэк: снести локали (mismatch locale → нативный краш рендерера, комментарий deploy-local).
    const locales = join(appDir, 'locales')
    rmSync(locales, { recursive: true, force: true })
    console.log('[smoke] поломка renderer: снесён locales/')
  }
}

// --- Чтение логов приложения ---
function scanLogs() {
  const out = { fatalEvents: [], sawPositive: false }
  for (const [file, level] of [['errors.jsonl', 'error'], ['runtime.jsonl', 'info']]) {
    const p = join(userData, 'logs', file)
    if (!existsSync(p)) continue
    let text = ''
    try { text = readFileSync(p, 'utf8') } catch { continue }
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue
      let line
      try { line = JSON.parse(raw) } catch { continue }
      if (isFatalLogLine(line)) out.fatalEvents.push(line.event)
      if (isPositiveLogLine(line)) out.sawPositive = true
    }
  }
  return out
}

function killTree(pid) {
  if (!pid) return
  try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
}

async function main() {
  console.log(`[smoke] источник: ${source}`)
  console.log(`[smoke] копирую в ${appDir} …`)
  cpSync(source, appDir, { recursive: true })

  if (breakKind === 'db') breakDb()
  else if (breakKind === 'renderer') breakRenderer()
  else if (breakKind !== 'none') die(`неизвестный --break: ${breakKind}`)

  const exe = join(appDir, 'Verstak.exe')
  console.log(`[smoke] запуск (VERSTAK_SMOKE=1, userData=${userData}) …`)
  // --user-data-dir — НАТИВНЫЙ ключ Chromium: Electron применяет его ДО кода приложения,
  // поэтому и singleton-lock, и getPath('userData') уходят в изолированный temp. Именно
  // это, а не dev-only env VERSTAK_DEV_USER_DATA_DIR (main.ts:323, только !isPackaged),
  // изолирует УПАКОВАННУЮ сборку от userData Павла и снимает коллизию single-instance.
  const child = spawn(exe, [`--user-data-dir=${userData}`], {
    env: { ...process.env, VERSTAK_SMOKE: '1', VERSTAK_DEV_USER_DATA_DIR: userData },
    stdio: 'ignore',
    windowsHide: true,
  })
  let exited = false
  let exitCode = null
  child.on('exit', code => { exited = true; exitCode = code })

  const start = Date.now()
  let firstPositiveAt = 0
  let scan = { fatalEvents: [], sawPositive: false }

  // Опрос до вердикта: фатал → сразу; ранний выход → сразу; позитив + settle без фатала → PASS;
  // таймаут → как есть (classifyStartup решит).
  while (Date.now() - start < timeoutMs) {
    await sleep(500)
    scan = scanLogs()
    if (scan.sawPositive && !firstPositiveAt) firstPositiveAt = Date.now()
    if (scan.fatalEvents.length) break
    if (exited) break
    if (firstPositiveAt && Date.now() - firstPositiveAt >= settleMs) break
  }

  const waitedMs = Date.now() - start
  const verdict = classifyStartup({
    sawStartupOk: scan.sawPositive,
    fatalEvents: scan.fatalEvents,
    exitedEarly: exited,
    exitCode,
    waitedMs,
    timeoutMs,
  })

  killTree(child.pid)
  await sleep(1500) // дать ОС отпустить хендлы процесса перед удалением temp
  await cleanupWithRetries()

  const line = `[smoke] break=${breakKind} → ${verdict.verdict} (${verdict.reason})`
  const okExpect = !expect || expect === verdict.verdict
  if (okExpect) console.log(`${line}  ✓ ожидание ${expect || '—'}`)
  else console.error(`${line}  ✗ ОЖИДАЛОСЬ ${expect}`)
  process.exit(okExpect ? 0 : 1)
}

process.on('exit', cleanup)
main().catch(err => { console.error('[smoke] ошибка:', err); cleanup(); process.exit(2) })
