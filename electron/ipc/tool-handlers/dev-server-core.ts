// VSK-BROWSER-B2 блок 3: дев-сервер описывается КОНФИГОМ (имя/команда/порт), а не
// произвольной командой с парсингом вывода. Из этого само следует: порт известен
// заранее (реюз уже запущенного), логи сборки читаются отдельно (outputTail реестра).
// Запуск — через существующий gated process-registry (spawn_process применяет те же
// гейты, что run_command: denylist + resolveDecision + confirm + scanText). Новый
// канал не строим. Здесь — ЧИСТАЯ часть (парс/резолв/URL/решение реюза), тестируемая
// без сервера; реальный подъём и проба порта — живой свидетель.

export interface DevServerConfig {
  name: string
  command: string
  port: number
}

/** Разобрать конфиг `.verstak/dev-servers.json` (массив {name,command,port}).
 *  Невалидные записи ОТБРАСЫВАЮТСЯ (не роняем весь конфиг из-за одной опечатки),
 *  но список отброшенного возвращаем — тишины быть не должно. Чистая функция. */
export function parseDevServers(raw: unknown): { servers: DevServerConfig[]; dropped: string[] } {
  const servers: DevServerConfig[] = []
  const dropped: string[] = []
  const arr = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && Array.isArray((raw as { servers?: unknown }).servers) ? (raw as { servers: unknown[] }).servers : [])
  for (const item of arr) {
    const o = item as { name?: unknown; command?: unknown; port?: unknown }
    const name = typeof o?.name === 'string' ? o.name.trim() : ''
    const command = typeof o?.command === 'string' ? o.command.trim() : ''
    const port = typeof o?.port === 'number' ? o.port : Number(o?.port)
    if (name && command && Number.isInteger(port) && port >= 1 && port <= 65535) {
      servers.push({ name, command, port })
    } else {
      dropped.push(name || command || 'без имени')
    }
  }
  return { servers, dropped }
}

export type ResolveResult = { ok: true; config: DevServerConfig } | { ok: false; error: string }

/** Найти конфиг по имени. Не нашли / нет конфигов — ЧЕСТНАЯ ошибка с перечнем
 *  доступных, а не молчание. Чистая функция. */
export function resolveDevServer(servers: DevServerConfig[], name: string): ResolveResult {
  const q = String(name || '').trim()
  if (!q) {
    return { ok: false, error: servers.length
      ? `Укажи имя дев-сервера. Доступные: ${servers.map(s => s.name).join(', ')}.`
      : 'Нет настроенных дев-серверов. Опиши их в .verstak/dev-servers.json ([{name,command,port}]).' }
  }
  const hit = servers.find(s => s.name.toLowerCase() === q.toLowerCase())
  if (!hit) {
    return { ok: false, error: servers.length
      ? `Дев-сервер «${q}» не найден. Доступные: ${servers.map(s => s.name).join(', ')}.`
      : `Дев-сервер «${q}» не найден: нет .verstak/dev-servers.json с описанием серверов.` }
  }
  return { ok: true, config: hit }
}

/** Постоянный локальный URL сервера (порт известен из конфига заранее). */
export function devServerUrl(port: number): string {
  return `http://localhost:${port}`
}

/** Решение: порт уже слушает → ПЕРЕИСПОЛЬЗУЕМ (не поднимаем второй); иначе SPAWN.
 *  Чистая функция от результата пробы порта. */
export function decideDevAction(portAlreadyOpen: boolean): 'reuse' | 'spawn' {
  return portAlreadyOpen ? 'reuse' : 'spawn'
}
