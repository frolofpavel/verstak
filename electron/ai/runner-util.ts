// Мелкие чистые хелперы runner'ов (распил ai.ts, 1.9.8 #1, срез 3).
// Вынесено из ipc/ai.ts БЕЗ изменения логики.

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
  const allowSet = Array.isArray(toolsAllow) && toolsAllow.length > 0 ? new Set(toolsAllow) : null
  if (!allowSet) return mcpDefs.length > 0 ? [...baseDefs, ...mcpDefs] : [...baseDefs]
  const base = baseDefs.filter(t => allowSet.has(t.name))
  const mcp = mcpDefs.filter(t => allowSet.has(t.name))
  if (base.length === 0 && mcp.length === 0) {
    console.warn(`[agent] tools_allow=[${toolsAllow!.join(', ')}] не совпал ни с одним инструментом — ограничение пропущено (проверь имена в скилле)`)
    return mcpDefs.length > 0 ? [...baseDefs, ...mcpDefs] : [...baseDefs]
  }
  return mcp.length > 0 ? [...base, ...mcp] : [...base]
}

/** Событие провайдера типа 'error' → Error (для fallback/retry), иначе null. */
export function retriableErrorEvent(ev: { type?: string; message?: unknown }): Error | null {
  return ev && ev.type === 'error' ? new Error(String(ev.message ?? '')) : null
}
