// MCP risk classifier — pure logic (no React, no IPC).
// Назначает каждому MCP-инструменту scope (что он умеет) и risk (насколько опасен),
// чтобы пользователь мог отревьюить сервер ДО того как доверит ему «руки» агента.

export type McpScope = 'read' | 'write' | 'command' | 'network' | 'unknown'
export type McpRisk = 'low' | 'medium' | 'high'

export interface ToolClassification {
  scope: McpScope
  risk: McpRisk
}

export interface ServerClassification {
  risk: McpRisk
  scopes: Record<McpScope, number>
  toolCount: number
}

// Keyword tables ordered most-dangerous → least. Longest/most-dangerous match wins:
// we walk the groups top-down and return on the first hit.
const SCOPE_RULES: ReadonlyArray<{ scope: McpScope; risk: McpRisk; keywords: readonly string[] }> = [
  { scope: 'command', risk: 'high', keywords: ['terminal', 'command', 'process', 'spawn', 'shell', 'exec', 'bash', 'kill', 'run', 'sh'] },
  { scope: 'network', risk: 'medium', keywords: ['download', 'upload', 'request', 'browse', 'crawl', 'fetch', 'http', 'web', 'url', 'api'] },
  { scope: 'write', risk: 'medium', keywords: ['create', 'update', 'delete', 'remove', 'insert', 'modify', 'rename', 'write', 'edit', 'patch', 'post', 'move', 'send', 'put', 'set'] },
  { scope: 'read', risk: 'low', keywords: ['describe', 'search', 'query', 'view', 'show', 'list', 'find', 'read', 'get'] }
]

/**
 * Классифицирует один инструмент по name + description.
 * Эвристика по lowercased тексту, выигрывает самое опасное совпадение.
 */
export function classifyTool(tool: { name: string; description?: string }): ToolClassification {
  const haystack = `${tool.name} ${tool.description ?? ''}`.toLowerCase()
  for (const rule of SCOPE_RULES) {
    if (rule.keywords.some(kw => haystack.includes(kw))) {
      return { scope: rule.scope, risk: rule.risk }
    }
  }
  return { scope: 'unknown', risk: 'medium' }
}

/**
 * Агрегирует классификацию сервера по списку его инструментов.
 * Риск сервера = максимальный риск среди инструментов; считаем tools по scope.
 */
export function classifyServer(tools: ReadonlyArray<{ name: string; description?: string }>): ServerClassification {
  const scopes: Record<McpScope, number> = { read: 0, write: 0, command: 0, network: 0, unknown: 0 }
  for (const t of tools) {
    const { scope } = classifyTool(t)
    scopes[scope] += 1
  }
  let risk: McpRisk = 'low'
  if (scopes.command > 0) {
    risk = 'high'
  } else if (scopes.write > 0 || scopes.network > 0 || scopes.unknown > 0) {
    risk = 'medium'
  }
  return { risk, scopes, toolCount: tools.length }
}
