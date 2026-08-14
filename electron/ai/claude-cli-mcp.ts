/**
 * Проброс MCP-серверов Verstak в дочерний процесс Claude Code (CLI).
 *
 * ПОЧЕМУ ТАК, а не иначе — формат снят с УСТАНОВЛЕННОГО claude 2.1.220 (14.08),
 * не по памяти:
 *   `--mcp-config <configs...>` — «Load MCP servers from JSON files or strings».
 * Инлайн-строка принимается, файл не обязателен. Зондом (сервер-заглушка, который
 * пишет полученный env) дополнительно установлено: `${VAR}` в значениях `env`
 * раскрывается claude'ом из окружения РОДИТЕЛЬСКОГО процесса.
 *
 * Отсюда конструкция, которая закрывает оба требования постановки разом:
 *   · ключи НЕ уходят в argv — там стоит только имя переменной-плейсхолдера
 *     (argv виден в списке процессов любому пользователю машины);
 *   · ключи НЕ пишутся на диск — временного файла нет вовсе, значит нечего
 *     защищать правами и нечего удалять после;
 *   · ключи НЕ логируются — этот модуль ничего не пишет, а claude-cli.ts не
 *     логирует args.
 *
 * ГРАНИЦА ЧЕСТНОСТИ. Инструменты этих серверов исполняет САМ claude, а не наш
 * рантайм: `mcp-policy.ts`/`resolveDecision` к ним неприменимы — там работает
 * permission-механизм claude. Ровно так уже устроен `run_command` у CLI-пути.
 * Единственное, что обязаны удержать мы, — соответствие режима: мост не добавляет
 * ни одного разрешающего флага и не трогает `claudeGuardArgs` (пины в
 * tests/ai/claude-cli-args-mcp.test.ts).
 *
 * `--strict-mcp-config` СОЗНАТЕЛЬНО не передаём: он отключил бы серверы из
 * собственной конфигурации пользователя (`~/.claude.json`, плагины). Наши записи
 * ДОБАВЛЯЮТСЯ к тому, что у человека уже настроено, а не заменяют его.
 */

import type { McpServerConfig } from '../mcp/client'

export interface ClaudeMcpBridge {
  /** Готовый блок аргументов: ['--mcp-config', '<инлайн JSON>']. */
  args: string[]
  /** Переменные окружения дочернего claude: имя плейсхолдера → реальное значение. */
  env: Record<string, string>
}

/** Ключ сервера в JSON — им claude именует инструменты: mcp__<ключ>__<tool>. */
function serverKey(name: string, index: number, taken: Set<string>): string {
  const base = name
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    || `server_${index + 1}`
  let key = base
  let n = 2
  while (taken.has(key)) key = `${base}_${n++}`
  taken.add(key)
  return key
}

/** Имя переменной-плейсхолдера. Индекс сервера разводит одноимённые ключи. */
function placeholderName(index: number, envKey: string): string {
  const safe = envKey.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()
  return `VERSTAK_MCP_${index + 1}_${safe}`
}

/**
 * cmd.exe СРЕЗАЕТ двойные кавычки внутри аргумента, когда spawn идёт с shell:true
 * (npm-установка claude → `claude.cmd`). Замерено 14.08 на шиме, печатающем argv:
 * `{"mcpServers":…}` доезжает как `{mcpServers:…}` — невалидный JSON, и настоящий
 * claude отвечает «MCP config file not found: {mcpServers:…}», приняв обломок за
 * путь. Лечение — конвенция cmd: обернуть в кавычки, внутренние удвоить.
 *
 * Экранируем ТОЛЬКО этот аргумент. Deny-специфаеры (`Read(**\/.env)`) тем же
 * замером проходят через cmd целыми — трогать работающее незачем.
 */
function cmdQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/**
 * Собрать блок `--mcp-config` для claude из серверов, подключённых в Verstak.
 * Пустой список → null: флага в командной строке не появляется вовсе.
 *
 * `useShell` обязан совпадать с флагом shell того spawn'а, куда уйдут аргументы
 * (у claude-cli это .cmd/.ps1-шимы): без экранирования JSON туда не доезжает.
 */
export function buildClaudeMcpBridge(servers: McpServerConfig[], useShell = false): ClaudeMcpBridge | null {
  if (!servers.length) return null

  const mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {}
  const env: Record<string, string> = {}
  const taken = new Set<string>()

  servers.forEach((srv, index) => {
    const key = serverKey(srv.name || srv.id, index, taken)
    const entry: { command: string; args: string[]; env?: Record<string, string> } = {
      command: srv.command,
      args: srv.args ?? []
    }
    const pairs = Object.entries(srv.env ?? {})
    if (pairs.length) {
      const placeholders: Record<string, string> = {}
      for (const [envKey, value] of pairs) {
        const varName = placeholderName(index, envKey)
        placeholders[envKey] = `\${${varName}}`
        env[varName] = value
      }
      entry.env = placeholders
    }
    mcpServers[key] = entry
  })

  const json = JSON.stringify({ mcpServers })
  return { args: ['--mcp-config', useShell ? cmdQuote(json) : json], env }
}
