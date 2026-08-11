/**
 * MCP Client — подключает внешние MCP-серверы и вызывает их инструменты.
 *
 * Протокол: JSON-RPC 2.0 через stdio (newline-delimited JSON).
 * Каждый сервер — отдельный дочерний процесс.
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { scanText } from '../ai/secret-scanner'
import { treeKill } from '../ai/child-kill'

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** Стандартные MCP tool annotations — для надёжного гейтинга вместо угадайки по имени. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}

export interface McpServerConfig {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface McpConnection {
  config: McpServerConfig
  process: ChildProcess
  tools: McpTool[]
  requestId: number
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>
  buffer: string
  /** P8 шаг 3: хвост stderr — единственный источник причины, когда сервер умирает на старте. */
  stderrTail: string[]
}

const STDERR_TAIL_LINES = 12
const STDERR_TAIL_CHARS = 1500

/** Хвост stderr для строки причины: последние строки, секреты отредактированы. */
function stderrTailText(conn: McpConnection): string {
  const joined = conn.stderrTail.join('\n').trim()
  if (!joined) return ''
  return scanText(joined.slice(-STDERR_TAIL_CHARS)).redacted
}

const TOOL_CALL_TIMEOUT_MS = 30_000
// P8: холодный первый запуск npx/uvx КАЧАЕТ пакет сервера — на 15s «один шаг»
// из каталога падал бы таймаутом на любой свежей машине. Подключение — редкое
// явное действие с «Подключаю…» в UI, длинное ожидание здесь честнее отказа.
const INIT_TIMEOUT_MS = 90_000

/**
 * Allowlist переменных окружения, которые прокидываем в дочерний MCP-процесс.
 * Раньше мы лили весь process.env (включая API-ключи провайдеров, OAuth-токены,
 * креды коннекторов) в произвольный сторонний сервер — это утечка. Прокидываем
 * только то, что нужно процессу запуститься (PATH, временные папки, локаль),
 * а конкретные секреты сервер получает явно через config.env.
 */
const MCP_ENV_ALLOWLIST = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir',
  'TEMP', 'TMP', 'ComSpec',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData',
  'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'LANG', 'LC_ALL', 'TZ',
  'NODE_OPTIONS', 'NPM_CONFIG_PREFIX'
]

/** Собрать env для дочернего MCP-процесса: allowlisted process.env + config.env сверху. */
function buildMcpEnv(configEnv?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of MCP_ENV_ALLOWLIST) {
    const v = process.env[key]
    if (v != null) env[key] = v
  }
  return { ...env, ...(configEnv ?? {}) }
}

/**
 * P8: на Windows голое имя команды ('npx', 'uvx') spawn'ом без shell не
 * запускается — npm-шимы это .cmd, а spawn ищет только .exe. Резолвим реальный
 * путь через where (паттерн cli-detect.ts) и включаем shell для .cmd/.bat/.ps1
 * (как claude-cli.ts). Без резолва каталог серверов на Windows мёртв целиком.
 */
export function resolveSpawnTarget(command: string): { file: string; useShell: boolean } {
  const isShim = (p: string) => /\.(cmd|bat|ps1)$/i.test(p)
  // shell:true склеивает команду строкой — путь с пробелом («C:\Program Files\
  // nodejs\npx.cmd») без кавычек cmd.exe режет по пробелу. Поймано живой
  // приёмкой P8: «"C:\Program" не является внутренней или внешней командой».
  const shellSafe = (p: string) => /\s/.test(p) ? `"${p}"` : p
  if (process.platform !== 'win32') return { file: command, useShell: false }
  if (/[\\/]/.test(command) || /\.[a-z0-9]{2,4}$/i.test(command)) {
    const useShell = isShim(command)
    return { file: useShell ? shellSafe(command) : command, useShell }
  }
  try {
    const out = spawnSync('where', [command], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    const lines = (out.stdout ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    // where отдаёт все варианты (npx, npx.cmd, npx.ps1) — берём запускаемое:
    // сперва .exe (не нужен shell), затем .cmd/.bat.
    const exe = lines.find(l => /\.exe$/i.test(l))
    if (exe) return { file: exe, useShell: false }
    const shim = lines.find(isShim)
    if (shim) return { file: shellSafe(shim), useShell: true }
  } catch { /* нет where / не нашлось — пусть spawn честно скажет ENOENT */ }
  return { file: command, useShell: false }
}

export class McpClient extends EventEmitter {
  private connections: Map<string, McpConnection> = new Map()

  /**
   * Подключиться к MCP серверу, выполнить handshake, получить список инструментов.
   * Возвращает список доступных tools.
   */
  async connect(config: McpServerConfig): Promise<McpTool[]> {
    // Если уже подключён — переподключаем
    if (this.connections.has(config.id)) {
      await this.disconnect(config.id)
    }

    const target = resolveSpawnTarget(config.command)
    const child = spawn(target.file, config.args, {
      env: buildMcpEnv(config.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // .cmd-шимы (npx и прочие npm-обёртки) запускаются только через shell.
      // Аргументы каталога простые (без пробелов/метасимволов), ручные — на
      // совести добавившего; cmd.exe получает их через join как в claude-cli.
      shell: target.useShell
    })

    const conn: McpConnection = {
      config,
      process: child,
      tools: [],
      requestId: 0,
      pending: new Map(),
      buffer: '',
      stderrTail: []
    }

    // Парсим построчный JSON-RPC из stdout
    child.stdout!.on('data', (chunk: Buffer) => {
      conn.buffer += chunk.toString('utf8')
      const lines = conn.buffer.split('\n')
      conn.buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const msg = JSON.parse(trimmed) as JsonRpcResponse
          if (msg.id !== undefined) {
            const pending = conn.pending.get(msg.id)
            if (pending) {
              conn.pending.delete(msg.id)
              if (msg.error) {
                pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`))
              } else {
                pending.resolve(msg.result)
              }
            }
          }
          // server notifications (no id) — игнорируем
        } catch {
          // non-JSON stderr иногда попадает в stdout у некоторых серверов
        }
      }
    })

    // stderr — дебаг + хвост для честной причины отказа (сервер, умерший на
    // старте, объясняется только здесь: «ключ не подошёл» живёт в его stderr).
    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      console.debug(`[mcp:${config.id}] stderr:`, text.trim())
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (t) conn.stderrTail.push(t)
      }
      if (conn.stderrTail.length > STDERR_TAIL_LINES) {
        conn.stderrTail.splice(0, conn.stderrTail.length - STDERR_TAIL_LINES)
      }
    })

    child.on('error', (err) => {
      console.error(`[mcp:${config.id}] process error:`, err.message)
      // ENOENT — самый частый честный отказ: нет рантайма (npx → Node.js, uvx → uv).
      const friendly = (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? `Не удалось запустить "${config.command}" — команда не найдена. ` +
          (config.command === 'npx' ? 'Нужен установленный Node.js.'
            : config.command === 'uvx' ? 'Нужен Python с установленным uv.'
            : 'Проверь, что программа установлена и видна в PATH.')
        : `Не удалось запустить "${config.command}": ${err.message}`
      this._handleDisconnect(config.id, friendly)
    })

    // 'close', не 'exit': к close потоки дочитаны, и хвост stderr уже собран.
    child.on('close', (code, signal) => {
      const codeStr = signal ? `сигнал ${signal}` : `код ${code}`
      console.warn(`[mcp:${config.id}] process exited: ${codeStr}`)
      const tail = stderrTailText(conn)
      const reason = `сервер завершился (${codeStr})${tail ? `. Вывод сервера:\n${tail}` : ''}`
      this._handleDisconnect(config.id, reason)
    })

    this.connections.set(config.id, conn)

    try {
      // 1. initialize
      await this._request(conn, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'Verstak', version: '1.2.0' }
      }, INIT_TIMEOUT_MS)

      // 2. notifications/initialized (no response expected)
      this._notify(conn, 'notifications/initialized')

      // 3. tools/list
      const result = await this._request(conn, 'tools/list', {}, INIT_TIMEOUT_MS) as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }> }
      const tools: McpTool[] = (result?.tools ?? []).map(t => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? {},
        // Стандартные MCP-хинты (если сервер их прислал) — надёжнее keyword-угадайки.
        ...(t.annotations ? { annotations: { readOnlyHint: t.annotations.readOnlyHint, destructiveHint: t.annotations.destructiveHint } } : {})
      }))
      conn.tools = tools

      console.log(`[mcp:${config.id}] connected, ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`)
      this.emit('connected', config.id, tools)
      return tools
    } catch (err) {
      // Чистим после неудачного подключения
      await this.disconnect(config.id)
      throw err
    }
  }

  /**
   * Вызвать tool на подключённом MCP-сервере.
   */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const conn = this.connections.get(serverId)
    if (!conn) throw new Error(`MCP server "${serverId}" not connected`)

    const result = await this._request(conn, 'tools/call', {
      name: toolName,
      arguments: args
    }, TOOL_CALL_TIMEOUT_MS) as { content?: Array<{ type: string; text?: string }>; isError?: boolean }

    // MCP tool result format: { content: [{type, text}], isError }
    if (result?.isError) {
      const errText = result.content?.map(c => c.text ?? '').join('\n') ?? 'unknown error'
      throw new Error(errText)
    }

    // Возвращаем текстовый контент
    if (Array.isArray(result?.content)) {
      const texts = result.content.filter(c => c.type === 'text').map(c => c.text ?? '')
      if (texts.length === 1) return texts[0]
      if (texts.length > 1) return texts.join('\n')
    }

    return result
  }

  /**
   * Отключить сервер (убить процесс, очистить состояние).
   */
  async disconnect(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId)
    if (!conn) return
    this.connections.delete(serverId)

    // Отклоняем все pending запросы
    for (const [, p] of conn.pending) {
      p.reject(new Error('MCP server disconnected'))
    }
    conn.pending.clear()

    // Убиваем всё дерево: при shell:true kill() снимает только cmd.exe-обёртку,
    // а сам сервер (node.exe под npx) осиротел бы и продолжал жить.
    try {
      treeKill(conn.process)
    } catch { /* уже мёртв */ }

    this.emit('disconnected', serverId)
  }

  getConnectedServers(): McpServerConfig[] {
    return Array.from(this.connections.values()).map(c => c.config)
  }

  getAllTools(): Array<McpTool & { serverId: string }> {
    const result: Array<McpTool & { serverId: string }> = []
    for (const [serverId, conn] of this.connections) {
      for (const tool of conn.tools) {
        result.push({ ...tool, serverId })
      }
    }
    return result
  }

  isConnected(serverId: string): boolean {
    return this.connections.has(serverId)
  }

  disconnectAll(): void {
    for (const id of [...this.connections.keys()]) {
      void this.disconnect(id)
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _handleDisconnect(serverId: string, reason: string): void {
    const conn = this.connections.get(serverId)
    if (!conn) return
    this.connections.delete(serverId)

    for (const [, p] of conn.pending) {
      p.reject(new Error(`MCP server disconnected: ${reason}`))
    }
    conn.pending.clear()

    this.emit('disconnected', serverId, reason)
    // 'error' у EventEmitter особый: без слушателя emit КИДАЕТ и роняет main-процесс.
    // Подписчиков сегодня нет (P8, проверено grep'ом) — эмитим только если появятся.
    if (this.listenerCount('error') > 0) {
      this.emit('error', serverId, new Error(`Server ${serverId} disconnected: ${reason}`))
    }
  }

  private _send(conn: McpConnection, msg: JsonRpcRequest): void {
    const line = JSON.stringify(msg) + '\n'
    conn.process.stdin!.write(line)
  }

  private _notify(conn: McpConnection, method: string, params?: unknown): void {
    this._send(conn, { jsonrpc: '2.0', method, ...(params ? { params } : {}) })
  }

  private _request(conn: McpConnection, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++conn.requestId
      const timer = setTimeout(() => {
        conn.pending.delete(id)
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      conn.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) }
      })

      try {
        this._send(conn, { jsonrpc: '2.0', id, method, params })
      } catch (err) {
        conn.pending.delete(id)
        clearTimeout(timer)
        reject(err)
      }
    })
  }
}

/** Singleton — создаётся в main.ts, используется в ipc/mcp.ts */
export const mcpClient = new McpClient()
