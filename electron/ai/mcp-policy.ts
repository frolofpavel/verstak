/**
 * MCP runtime policy — гейтинг вызовов внешних MCP-инструментов под agent-mode.
 *
 * Имена MCP-тулзов динамические (приходят от подключённых серверов), поэтому их
 * нельзя перечислить по имени в mode-policy.decide(). Вместо этого классифицируем
 * scope тулза по эвристике (name + description) и маппим scope + mode → решение.
 *
 * Эвристика — реплика src/lib/mcp-risk.ts (renderer-side классификатор). Electron
 * не может импортировать из src/, поэтому таблица ключевых слов продублирована здесь.
 * Если правишь ключевые слова — синхронизируй оба файла.
 */

import type { AgentMode } from './mode-policy'
import type { ToolDecision } from './mode-policy'

export type McpScope = 'read' | 'write' | 'command' | 'network' | 'unknown'

/** Стандартные MCP tool annotations (из tools/list spec) — надёжнее угадайки по имени. */
export interface McpToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
}

// Keyword tables ordered most-dangerous → least. Longest/most-dangerous match wins:
// проходим группы сверху вниз и возвращаем на первом совпадении.
const SCOPE_RULES: ReadonlyArray<{ scope: McpScope; keywords: readonly string[] }> = [
  { scope: 'command', keywords: ['terminal', 'command', 'process', 'spawn', 'shell', 'exec', 'bash', 'kill', 'run', 'sh'] },
  { scope: 'network', keywords: ['download', 'upload', 'request', 'browse', 'crawl', 'fetch', 'http', 'web', 'url', 'api'] },
  { scope: 'write', keywords: ['create', 'update', 'delete', 'remove', 'insert', 'modify', 'rename', 'write', 'edit', 'patch', 'post', 'move', 'send', 'put', 'set'] },
  { scope: 'read', keywords: ['describe', 'search', 'query', 'view', 'show', 'list', 'find', 'read', 'get'] }
]

const VALID_SCOPES: ReadonlySet<string> = new Set(['read', 'write', 'command', 'network'])

/** keyword-эвристика по name+description (фолбэк, выигрывает самое опасное). */
function keywordScope(name: string, description?: string): McpScope {
  const haystack = `${name} ${description ?? ''}`.toLowerCase()
  for (const rule of SCOPE_RULES) {
    if (rule.keywords.some(kw => haystack.includes(kw))) return rule.scope
  }
  return 'unknown'
}

/**
 * Классифицирует scope MCP-инструмента. Приоритет:
 *  1) override — явный per-tool выбор пользователя (Settings) — высший.
 *  2) destructiveHint=true → command (самый опасный сигнал, most-dangerous-wins).
 *  3) keyword-эвристика — БАЗА (нижняя граница доверия). annotations её НЕ ослабляют:
 *     сервер НЕ доверенный (mcp.ts), мог соврать readOnlyHint:true на пишущем тулзе.
 *     readOnlyHint:true → read ТОЛЬКО если keyword тоже read/unknown; иначе keep keyword.
 *     readOnlyHint:false → минимум write (или опаснее по keyword).
 */
export function classifyMcpToolScope(
  name: string,
  description?: string,
  annotations?: McpToolAnnotations,
  override?: string
): McpScope {
  if (override && VALID_SCOPES.has(override)) return override as McpScope
  // destructiveHint первым: противоречивый {readOnly:true, destructive:true} → строже (command).
  if (annotations?.destructiveHint === true) return 'command'
  const kw = keywordScope(name, description)
  if (annotations?.readOnlyHint === true) {
    // НЕ даунгрейдим keyword-write/command/network до read по слову недоверенного сервера.
    return (kw === 'read' || kw === 'unknown') ? 'read' : kw
  }
  if (annotations?.readOnlyHint === false) {
    return (kw === 'command' || kw === 'network') ? kw : 'write'
  }
  return kw
}

/**
 * Парсит настройку mcp_scope_overrides — JSON { "toolName": "read|write|command|network" }.
 * Битый/не-объект → {} (без оверрайдов). Невалидные значения отфильтрованы classifyMcpToolScope.
 */
export function parseMcpScopeOverrides(raw: string | null | undefined): Record<string, string> {
  if (!raw || !raw.trim()) return {}
  try {
    const obj = JSON.parse(raw)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') out[k] = v
      return out
    }
  } catch { /* битый JSON → без оверрайдов */ }
  return {}
}

/**
 * Маппит scope + agentMode в решение, согласованное с семантикой mode-policy.
 *
 * read → авто (чтение всегда разрешено).
 * write / command / network / unknown → трогают внешние системы, поэтому гейтятся
 * как команда: plan → block, ask → confirm, accept-edits → confirm (это НЕ локальные
 * правки файлов, а side-effects на внешних серверах, поэтому даже в accept-edits
 * подтверждаем), auto / bypass → авто-принимаем.
 */
export function mcpDecision(scope: McpScope, mode: AgentMode): ToolDecision {
  if (scope === 'read') return 'auto-accept'

  switch (mode) {
    case 'ask':          return 'confirm'
    case 'accept-edits': return 'confirm'
    case 'plan':         return 'block'
    case 'auto':         return 'auto-accept'
    case 'bypass':       return 'auto-accept'
  }
}

/** Человекочитаемое объяснение для модели, когда MCP-тулз заблокирован режимом. */
export function mcpBlockReason(toolName: string, scope: McpScope, mode: AgentMode): string {
  if (mode === 'plan') {
    return `Активен режим "Режим планирования" — вызов внешнего MCP-инструмента "${toolName}" (scope: ${scope}) запрещён, ` +
           `так как он может менять состояние внешних систем. ` +
           `Сосредоточься на чтении кода (read_file, get_project_map, search_project) и составлении плана через create_plan. ` +
           `Пользователь сам переключит режим когда захочет выполнить вызов MCP-инструмента.`
  }
  return `MCP-инструмент "${toolName}" (scope: ${scope}) заблокирован активным режимом "${mode}".`
}
