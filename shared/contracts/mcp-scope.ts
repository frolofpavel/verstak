/**
 * Ключевые слова разметки MCP-инструментов — ОДИН источник для обоих слоёв.
 *
 * Таблица жила в двух копиях (`src/lib/mcp-risk.ts` — ярлык в интерфейсе,
 * `electron/ai/mcp-policy.ts` — боевой гейт) с припиской «правишь одну —
 * синхронизируй вторую». Переезд сюда сделан вместе с правкой C4 (13.08) не для
 * красоты: правка совпадения ровно в одной копии молча развела бы ярлык, который
 * человек читает, и решение, которое принимается в бою. CLAUDE.md §5 называет
 * такие дубли кандидатами на переезд — этот переехал первым из MCP-пары.
 *
 * ПОЧЕМУ НЕ `\b` В ЛОБ. Совпадение было подстрочным (`haystack.includes(kw)`), и
 * `sh` находилось внутри `shares`: read-only `get_history` у MOEX размечался как
 * «запускает команды». Но честная граница слова (`\bexec\b`) потеряла бы
 * `execute`, `commands`, `processes` — то есть ослабила бы гейт там, где он прав.
 * Поэтому правило двухчастное: ключевое слово равно токену ИЛИ (при длине ≥3)
 * стоит в НАЧАЛЕ токена. Короткие (`sh`) сравниваются только целиком; всё, что
 * ловилось в начале слова, ловится по-прежнему; исчезают только совпадения в
 * середине чужого слова (`put` в `output`, `api` в `capital`, `run` в `prune`).
 */

export type McpScope = 'read' | 'write' | 'command' | 'network' | 'unknown'
export type McpRisk = 'low' | 'medium' | 'high'

/** Группы «сначала самое опасное»: идём сверху вниз и возвращаем первое совпадение. */
export const MCP_SCOPE_RULES: ReadonlyArray<{ scope: McpScope; risk: McpRisk; keywords: readonly string[] }> = [
  { scope: 'command', risk: 'high', keywords: ['terminal', 'command', 'process', 'spawn', 'shell', 'exec', 'bash', 'kill', 'run', 'sh'] },
  { scope: 'network', risk: 'medium', keywords: ['download', 'upload', 'request', 'browse', 'crawl', 'fetch', 'http', 'web', 'url', 'api'] },
  { scope: 'write', risk: 'medium', keywords: ['create', 'update', 'delete', 'remove', 'insert', 'modify', 'rename', 'write', 'edit', 'patch', 'post', 'move', 'send', 'put', 'set'] },
  { scope: 'read', risk: 'low', keywords: ['describe', 'search', 'query', 'view', 'show', 'list', 'find', 'read', 'get'] }
]

/** Ниже этой длины ключевое слово сравнивается только ЦЕЛИКОМ (иначе `sh` ловит `shares`). */
const MIN_PREFIX_LENGTH = 3

/** Режем на токены по не-буквам/не-цифрам и по camelCase: `listShares` → [list, shares]. */
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function tokenMatches(token: string, keyword: string): boolean {
  if (token === keyword) return true
  return keyword.length >= MIN_PREFIX_LENGTH && token.startsWith(keyword)
}

/**
 * Scope по имени и описанию инструмента. Выигрывает самая опасная группа;
 * ничего не совпало — `unknown` (не `read`: незнакомое не считаем безопасным).
 */
export function keywordScope(name: string, description?: string): McpScope {
  const tokens = tokenize(`${name} ${description ?? ''}`)
  for (const rule of MCP_SCOPE_RULES) {
    if (rule.keywords.some(kw => tokens.some(t => tokenMatches(t, kw)))) return rule.scope
  }
  return 'unknown'
}

/** Тот же разбор, но с риском группы — нужен ярлыку в интерфейсе. */
export function keywordScopeAndRisk(name: string, description?: string): { scope: McpScope; risk: McpRisk } {
  const tokens = tokenize(`${name} ${description ?? ''}`)
  for (const rule of MCP_SCOPE_RULES) {
    if (rule.keywords.some(kw => tokens.some(t => tokenMatches(t, kw)))) return { scope: rule.scope, risk: rule.risk }
  }
  return { scope: 'unknown', risk: 'medium' }
}
