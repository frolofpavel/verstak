// Мелкие чистые хелперы runner'ов (распил ai.ts, 1.9.8 #1, срез 3).
// Вынесено из ipc/ai.ts БЕЗ изменения логики.

const CONNECTOR_PSEUDO_NAMES = new Set([
  'yandex_wordstat', 'yandex_direct', 'yandex_metrika', 'yandex_disk',
  'yandex_webmaster', 'yandex_tracker', 'ywordstat', 'yandex_wordstat_api',
  'bitrix24', 'gsheets', 'telegram', 'ozon', 'wildberries',
])

const READ_PSEUDO_NAMES = new Set(['files', 'read_project', 'read_skill'])

/**
 * Отфильтровать доступные инструменты по skill `tools_allow` (M4 enforcement).
 * Пусто/нет allow → все base+mcp. Есть allow → только совпавшие по имени.
 * Fail-open + warn, если НИ ОДНО имя не совпало (broken-скилл не должен стать
 * молчаливым кирпичом). Если совпали только mcp — валидное mcp-only ограничение.
 */
export function selectAllowedToolDefs<T extends { name: string }>(
  baseDefs: readonly T[],
  mcpDefs: readonly T[],
  toolsAllow?: string[] | null
): T[] {
  const allowList = Array.isArray(toolsAllow) && toolsAllow.length > 0 ? toolsAllow : null
  if (!allowList) return mcpDefs.length > 0 ? [...baseDefs, ...mcpDefs] : [...baseDefs]
  const expanded = new Set(allowList)
  const pseudo = allowList.filter(t =>
    CONNECTOR_PSEUDO_NAMES.has(t.trim()) ||
    READ_PSEUDO_NAMES.has(t.trim()) ||
    t.trim() === 'shell'
  )
  for (const name of pseudo) {
    const clean = name.trim()
    expanded.delete(name)
    if (CONNECTOR_PSEUDO_NAMES.has(clean)) {
      expanded.add('list_connectors')
      expanded.add('connector_query')
    } else if (READ_PSEUDO_NAMES.has(clean)) {
      for (const tool of ['read_file', 'list_directory', 'search_project', 'find_files', 'get_project_map']) {
        expanded.add(tool)
      }
    } else if (clean === 'shell') {
      expanded.add('run_command')
    }
  }
  if (pseudo.length > 0) {
    console.warn(
      `[agent] tools_allow содержит псевдо-имена [${pseudo.join(', ')}] ` +
      '— они безопасно раскрыты в реальные tool-имена'
    )
  }
  const allowSet = expanded
  const base = baseDefs.filter(t => allowSet.has(t.name))
  const mcp = mcpDefs.filter(t => allowSet.has(t.name))
  if (base.length === 0 && mcp.length === 0) {
    console.warn(`[agent] tools_allow=[${allowList.join(', ')}] не совпал ни с одним инструментом — ограничение пропущено (проверь имена в скилле)`)
    return mcpDefs.length > 0 ? [...baseDefs, ...mcpDefs] : [...baseDefs]
  }
  return mcp.length > 0 ? [...base, ...mcp] : [...base]
}

/** Событие провайдера типа 'error' → Error (для fallback/retry), иначе null. */
export function retriableErrorEvent(ev: { type?: string; message?: unknown }): Error | null {
  return ev && ev.type === 'error' ? new Error(String(ev.message ?? '')) : null
}
