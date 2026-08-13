/**
 * MCP Server registry — хранит конфигурации серверов через Settings (safeStorage).
 * Ключ: 'mcp_servers' → JSON-массив McpServerEntry[].
 *
 * Конфигурации MCP серверов не содержат секретов (API ключи задаются в env поле),
 * поэтому хранятся через обычный settings.getSecret/setSecret.
 */

import { randomUUID } from 'crypto'
import type { Settings } from '../storage/settings'

export interface McpServerEntry {
  id: string
  name: string
  command: string
  /** JSON-строка: string[] */
  args: string
  /** JSON-строка: Record<string,string> — переменные окружения для процесса */
  env: string
  enabled: boolean
  /** P8: слаг записи каталога, из которой сервер добавлен (для «Добавлено» в UI). */
  catalogId?: string
}

const SETTINGS_KEY = 'mcp_servers'

function readServers(settings: Settings): McpServerEntry[] {
  const raw = settings.getSecret(SETTINGS_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as McpServerEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeServers(settings: Settings, servers: McpServerEntry[]): void {
  settings.setSecret(SETTINGS_KEY, JSON.stringify(servers))
}

export function loadMcpServers(settings: Settings): McpServerEntry[] {
  return readServers(settings)
}

export function saveMcpServers(settings: Settings, servers: McpServerEntry[]): void {
  writeServers(settings, servers)
}

export function addMcpServer(settings: Settings, entry: Omit<McpServerEntry, 'id'>): McpServerEntry {
  const servers = readServers(settings)
  const newEntry: McpServerEntry = { id: randomUUID(), ...entry }
  servers.push(newEntry)
  writeServers(settings, servers)
  return newEntry
}

export function removeMcpServer(settings: Settings, id: string): void {
  const servers = readServers(settings).filter(s => s.id !== id)
  writeServers(settings, servers)
}

export function toggleMcpServer(settings: Settings, id: string, enabled: boolean): void {
  const servers = readServers(settings).map(s => s.id === id ? { ...s, enabled } : s)
  writeServers(settings, servers)
}

export function updateMcpServer(settings: Settings, id: string, patch: Partial<Omit<McpServerEntry, 'id'>>): McpServerEntry | null {
  let updated: McpServerEntry | null = null
  const servers = readServers(settings).map(s => {
    if (s.id !== id) return s
    updated = { ...s, ...patch }
    return updated
  })
  writeServers(settings, servers)
  return updated
}

/**
 * Предустановленные популярные MCP-серверы — показываем в UI как быстрый выбор.
 *
 * C5 (13.08): отсюда убраны три шаблона на пакеты, снятые с поддержки —
 * `@modelcontextprotocol/server-github`, `-postgres`, `-puppeteer`. Проверено по
 * живому npm: у всех трёх стоит `deprecated: Package no longer supported`.
 * Заготовка, ведущая на мёртвый пакет, хуже отсутствия заготовки: она выглядит
 * рекомендацией продукта, а даёт человеку отказ на первом же запуске.
 *
 * Браузер закрыт каталогом P8 (`@playwright/mcp`) — дублировать его шаблоном
 * незачем. У GitHub и PostgreSQL проверенной замены в каталоге сегодня НЕТ; они
 * не заменены наспех, а сняты — кандидаты в каталог отдельным движением, где
 * запись проверяется по живому источнику.
 *
 * Остаётся `server-filesystem` — он поддерживается (версия 2026.7.10 на 13.08).
 */
export const POPULAR_MCP_SERVERS: Array<{
  name: string
  command: string
  args: string[]
  envHint?: string
  description: string
}> = [
  {
    name: 'Файлы проекта',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    description: 'Даёт агенту доступ к файлам в выбранной рабочей папке'
  }
]
