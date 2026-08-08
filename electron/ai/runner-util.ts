// Мелкие чистые хелперы runner'ов (распил ai.ts, 1.9.8 #1, срез 3).
// Вынесено из ipc/ai.ts БЕЗ изменения логики.

const CONNECTOR_PSEUDO_NAMES = new Set([
  'yandex_wordstat', 'yandex_direct', 'yandex_metrika', 'yandex_disk',
  'yandex_webmaster', 'yandex_tracker', 'ywordstat', 'yandex_wordstat_api',
  'bitrix24', 'gsheets', 'telegram', 'ozon', 'wildberries',
])

const READ_PSEUDO_NAMES = new Set(['files', 'read_project', 'read_skill'])

export interface ToolsAllowResolution {
  /** Разрешённые ИМЕНА инструментов. null = ограничения нет: либо tools_allow пуст/не
   *  задан, либо fail-open (ни одно имя не совпало — сломанный скилл не кирпичит сессию). */
  allowed: Set<string> | null
  /** true ТОЛЬКО в fail-open: tools_allow задан, но не совпал ни с одним инструментом.
   *  Вызывающий ОБЯЗАН оставить видимый след (штаб): тихий fail-open прячет снятие защиты. */
  unmatchedFailOpen: boolean
  /** Псевдо-имена, которые раскрывались (files/shell/коннекторы) — для warn вызывающего. */
  pseudoNames: string[]
}

/**
 * ЕДИНЫЙ предикат `tools_allow` → набор разрешённых имён инструментов. ОДИН источник
 * и для фильтра предлагаемого набора (selectAllowedToolDefs), и для гейта диспетчера
 * (runner-tool-turn dispatchToolTurn): список инструментов — это МЕНЮ для модели, а не
 * граница; enforcement обязан жить и на исполнении. Две независимые копии этой логики
 * неизбежно разъедутся — инструмент, который фильтр не показал, гейт бы пропустил. Здесь
 * чисто (без console.warn/журнала) — след оставляет вызывающий, у которого есть контекст.
 * Псевдо-имена (files/shell/коннекторы) раскрываются в реальные. Fail-open, если совпадений нет.
 */
export function resolveToolsAllowSet(
  toolsAllow: string[] | null | undefined,
  baseNames: readonly string[],
  mcpNames: readonly string[]
): ToolsAllowResolution {
  const allowList = Array.isArray(toolsAllow) && toolsAllow.length > 0 ? toolsAllow : null
  if (!allowList) return { allowed: null, unmatchedFailOpen: false, pseudoNames: [] }
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
  // Совпало ли ХОТЬ ОДНО раскрытое имя с реальным инструментом (base или mcp)? Иначе
  // весь tools_allow — опечатки → fail-open (как раньше base.length===0 && mcp.length===0).
  const universe = new Set<string>([...baseNames, ...mcpNames])
  let matched = false
  for (const n of expanded) { if (universe.has(n)) { matched = true; break } }
  if (!matched) return { allowed: null, unmatchedFailOpen: true, pseudoNames: pseudo }
  return { allowed: expanded, unmatchedFailOpen: false, pseudoNames: pseudo }
}

/**
 * Отфильтровать доступные инструменты по skill `tools_allow` (M4 enforcement).
 * Пусто/нет allow → все base+mcp. Есть allow → только совпавшие по имени.
 * Fail-open + warn, если НИ ОДНО имя не совпало (broken-скилл не должен стать
 * молчаливым кирпичом). Если совпали только mcp — валидное mcp-only ограничение.
 * Allow-набор считает resolveToolsAllowSet — ТОТ ЖЕ, что гейт диспетчера (без дрейфа).
 */
export function selectAllowedToolDefs<T extends { name: string }>(
  baseDefs: readonly T[],
  mcpDefs: readonly T[],
  toolsAllow?: string[] | null
): T[] {
  const { allowed, unmatchedFailOpen, pseudoNames } = resolveToolsAllowSet(
    toolsAllow, baseDefs.map(d => d.name), mcpDefs.map(d => d.name)
  )
  if (pseudoNames.length > 0) {
    console.warn(
      `[agent] tools_allow содержит псевдо-имена [${pseudoNames.join(', ')}] ` +
      '— они безопасно раскрыты в реальные tool-имена'
    )
  }
  if (!allowed) {
    if (unmatchedFailOpen) {
      console.warn(`[agent] tools_allow=[${(toolsAllow ?? []).join(', ')}] не совпал ни с одним инструментом — ограничение пропущено (проверь имена в скилле)`)
    }
    return mcpDefs.length > 0 ? [...baseDefs, ...mcpDefs] : [...baseDefs]
  }
  const base = baseDefs.filter(t => allowed.has(t.name))
  const mcp = mcpDefs.filter(t => allowed.has(t.name))
  return mcp.length > 0 ? [...base, ...mcp] : [...base]
}

/** Событие провайдера типа 'error' → Error (для fallback/retry), иначе null. */
export function retriableErrorEvent(ev: { type?: string; message?: unknown }): Error | null {
  return ev && ev.type === 'error' ? new Error(String(ev.message ?? '')) : null
}
