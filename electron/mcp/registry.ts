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

/** Предустановленные популярные MCP-серверы — показываем в UI как быстрый выбор. */
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
  },
  {
    name: 'GitHub',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envHint: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    description: 'Работа с репозиториями, issues и pull request через GitHub API'
  },
  {
    name: 'PostgreSQL',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb'],
    description: 'Чтение данных из PostgreSQL по строке подключения'
  },
  {
    name: 'Браузер',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    description: 'Открытие страниц, скриншоты и простые проверки в браузере'
  }
]
