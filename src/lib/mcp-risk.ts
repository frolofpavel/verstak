// MCP risk classifier — pure logic (no React, no IPC).
// Назначает каждому MCP-инструменту scope (что он умеет) и risk (насколько опасен),
// чтобы пользователь мог отревьюить сервер ДО того как доверит ему «руки» агента.

import { keywordScopeAndRisk, type McpRisk, type McpScope } from '../../shared/contracts/mcp-scope'

export type { McpRisk, McpScope }

export interface ToolClassification {
  scope: McpScope
  risk: McpRisk
}

export interface ServerClassification {
  risk: McpRisk
  scopes: Record<McpScope, number>
  toolCount: number
}

/**
 * Классифицирует один инструмент по name + description.
 *
 * Таблица ключевых слов и правило совпадения живут в
 * `shared/contracts/mcp-scope.ts` — ОДНИ на ярлык (здесь) и на боевой гейт
 * (`electron/ai/mcp-policy.ts`). До 13.08 таблица была продублирована, и правка
 * в одной копии молча развела бы то, что человек читает, и то, что решается.
 */
function keywordClassify(tool: { name: string; description?: string }): ToolClassification {
  return keywordScopeAndRisk(tool.name, tool.description)
}

export function classifyTool(tool: { name: string; description?: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }): ToolClassification {
  // Согласовано с electron-гейтом mcp-policy.ts: destructiveHint → command первым;
  // readOnlyHint:true НЕ даунгрейдит keyword-write/command (сервер недоверенный).
  const a = tool.annotations
  if (a?.destructiveHint === true) return { scope: 'command', risk: 'high' }
  const kw = keywordClassify(tool)
  if (a?.readOnlyHint === true) return (kw.scope === 'read' || kw.scope === 'unknown') ? { scope: 'read', risk: 'low' } : kw
  if (a?.readOnlyHint === false) return (kw.scope === 'command' || kw.scope === 'network') ? kw : { scope: 'write', risk: 'medium' }
  return kw
}

/**
 * P8 шаг 2 «видно, что сервер дал»: требует ли инструмент подтверждения.
 * 'auto' — выполняется сразу (read), 'confirm' — в режимах ask/accept-edits
 * встанет пауза подтверждения. Согласовано с mcpDecision (electron/ai/mcp-policy.ts);
 * пара закреплена анти-дрейф-тестом tests/lib/mcp-confirm-visibility.test.ts.
 */
export function confirmRequirement(scope: McpScope): 'auto' | 'confirm' {
  return scope === 'read' ? 'auto' : 'confirm'
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
