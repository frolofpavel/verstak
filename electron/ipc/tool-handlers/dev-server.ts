// VSK-BROWSER-B2 блок 3: поднять/переиспользовать дев-сервер ПО КОНФИГУ и вернуть URL.
// Сценарий «подними дев-сервер и проверь, что главная открывается» одной фразой:
// dev_server(name) → url, дальше агент сам browser_navigate + browser_console_errors.
//
// Запуск — через ТОТ ЖЕ gated путь, что spawn_process (authorizeProcessCommand:
// denylist + resolveDecision + confirm; вывод редактируется scanText в реестре).
// Новый канал не строим. Порт известен из конфига → уже слушает = переиспользуем.
import { readFileSync } from 'fs'
import { join } from 'path'
import { connect } from 'net'
import type { ToolHandler } from './shared'
import { authorizeProcessCommand, resolveProcessCwd, processRegistryFor } from './process'
import { parseDevServers, resolveDevServer, devServerUrl, decideDevAction } from './dev-server-core'

const READY_BUDGET_MS = 30_000
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Слушает ли кто-то порт (TCP connect). Живая проба, не пин. */
function probePort(port: number, host = '127.0.0.1', timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host })
    let settled = false
    const done = (v: boolean) => { if (settled) return; settled = true; try { sock.destroy() } catch { /* ignore */ } resolve(v) }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

async function waitForPort(port: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await probePort(port)) return true
    await sleep(300)
  }
  return false
}

function loadConfig(projectPath: string): ReturnType<typeof parseDevServers> {
  try {
    const raw = JSON.parse(readFileSync(join(projectPath, '.verstak', 'dev-servers.json'), 'utf8'))
    return parseDevServers(raw)
  } catch {
    return { servers: [], dropped: [] }
  }
}

export const devServerHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    const name = String(call.args.name ?? '')
    const { servers } = loadConfig(ctx.projectPath)
    const resolved = resolveDevServer(servers, name)
    if (!resolved.ok) return { id: call.id, name: call.name, result: '', error: resolved.error }
    const cfg = resolved.config
    const url = devServerUrl(cfg.port)

    // Уже слушает порт → ПЕРЕИСПОЛЬЗУЕМ (не поднимаем второй, порт из конфига).
    if (decideDevAction(await probePort(cfg.port)) === 'reuse') {
      return { id: call.id, name: call.name, result: { url, name: cfg.name, port: cfg.port, reused: true, note: 'сервер уже слушает порт — переиспользован, дальше browser_navigate ' + url } }
    }

    // Иначе поднимаем через ТОТ ЖЕ gated путь, что spawn_process.
    const blocked = await authorizeProcessCommand({ ...call, args: { command: cfg.command } }, ctx, cfg.command)
    if (blocked) return { id: call.id, name: call.name, result: `Команда: ${cfg.command}`, error: blocked }

    let processId: string
    try {
      const cwd = resolveProcessCwd(ctx, undefined)
      const handle = processRegistryFor(ctx).spawn(cfg.command, {
        cwd,
        owner: { sendId: ctx.sendId, runId: ctx.runId ?? null, chatId: ctx.parentChatId ?? null },
      })
      processId = handle.id
      ctx.recordRunEvent?.('tool_call', { label: 'dev_server', detail: `${cfg.name} · ${cfg.command}`, status: 'ok' })
    } catch (e) {
      return { id: call.id, name: call.name, result: '', error: e instanceof Error ? e.message : String(e) }
    }

    // Ждём, пока порт начнёт слушать (не слепая пауза — опрос до бюджета).
    const ready = await waitForPort(cfg.port, READY_BUDGET_MS)
    if (!ready) {
      // Логи сборки — отдельно, из реестра (уже редактированы scanText).
      const log = (processRegistryFor(ctx).get(processId)?.outputTail || '').slice(-2000)
      return {
        id: call.id, name: call.name,
        result: { url, name: cfg.name, port: cfg.port, reused: false, process_id: processId, ready: false, log },
        error: `Дев-сервер «${cfg.name}» не начал слушать порт ${cfg.port} за ${READY_BUDGET_MS / 1000} с. Смотри log (вывод сборки).`,
      }
    }
    return { id: call.id, name: call.name, result: { url, name: cfg.name, port: cfg.port, reused: false, process_id: processId, ready: true, note: 'поднят, дальше browser_navigate ' + url } }
  },
}
