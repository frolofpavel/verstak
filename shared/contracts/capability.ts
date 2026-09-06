/**
 * Паспорт возможности — общий словарь для четырёх видов того, что агент может
 * пустить в дело: скилл, MCP-сервер, коннектор и роль агента.
 *
 * ПОЧЕМУ ПРОЕКЦИЯ, А НЕ ПЯТОЕ ХРАНИЛИЩЕ. Имя, описание и признак включённости
 * живут в своих источниках: скиллы — в файлах frontmatter, MCP — в mcp_servers,
 * коннекторы — в BUILTINS, роли — в agent-model-policy.json. Копия этих полей в
 * общей таблице однажды разойдётся с источником и начнёт врать молча — ровно тот
 * отказ, который CLAUDE.md §3.1 разбирает шестью случаями. Поэтому Capability
 * СОБИРАЕТСЯ из живых источников на каждом чтении, а в БД ложится только то, у
 * чего своего дома нет: доверие, оценка, отметка проверки и закреплённая версия.
 *
 * Словарь риска НЕ заводится заново: берётся McpRisk, уже работающий на MCP.
 */
import type { McpRisk } from './mcp-scope'

export type CapabilityType = 'agent' | 'skill' | 'mcp' | 'connector'

export const CAPABILITY_TYPES: readonly CapabilityType[] = ['agent', 'skill', 'mcp', 'connector']

/** Риск возможности — тот же словарь, что у MCP-инструментов. */
export type CapabilityRisk = McpRisk

/**
 * Уровень автономности. Отдельная ось от режима агента (ask/accept-edits/plan/
 * auto/bypass): режим выбирает человек на прогон, доверие зарабатывается
 * возможностью по фактам её работы. Слой доверия умеет только УЖЕСТОЧАТЬ решение
 * режима — см. шаг «губернатор доверия».
 */
export type TrustLevel = 'T0' | 'T1' | 'T2' | 'T3' | 'T4'

export const TRUST_LEVELS: readonly TrustLevel[] = ['T0', 'T1', 'T2', 'T3', 'T4']

/** Пол доверия: только песочница. Сюда падают после подмены версии и нарушений. */
export const TRUST_FLOOR: TrustLevel = 'T0'

/**
 * Доверие новой возможности. T1 = только чтение: свежий скилл или сервер НЕ
 * получает права записи авансом, их надо заработать.
 */
export const TRUST_DEFAULT: TrustLevel = 'T1'

/** Отрицательное — a слабее b, 0 — равны, положительное — a сильнее. */
export function compareTrust(a: TrustLevel, b: TrustLevel): number {
  return TRUST_LEVELS.indexOf(a) - TRUST_LEVELS.indexOf(b)
}

export function isTrustAtLeast(actual: TrustLevel, required: TrustLevel): boolean {
  return compareTrust(actual, required) >= 0
}

/** Разделитель ключа. Нативные id приходят из чужих файлов и сами могут его содержать. */
const ID_SEP = ':'

/**
 * Ключ возможности. Тип обязателен в ключе: в этом продукте `github` — И скилл,
 * И коннектор. Без типа общий реестр склеил бы их в одну запись и выдал бы
 * агенту чужие права.
 */
export function capabilityId(type: CapabilityType, nativeId: string): string {
  return `${type}${ID_SEP}${nativeId}`
}

/** Разбор ключа. Неизвестный тип или пустая часть — null, а не догадка. */
export function parseCapabilityId(id: string): { type: CapabilityType; nativeId: string } | null {
  const at = id.indexOf(ID_SEP)
  if (at <= 0) return null
  const type = id.slice(0, at)
  // Нативный id может содержать двоеточие (`vendor:server:v2`) — режем по ПЕРВОМУ.
  const nativeId = id.slice(at + ID_SEP.length)
  if (!nativeId) return null
  if (!CAPABILITY_TYPES.includes(type as CapabilityType)) return null
  return { type: type as CapabilityType, nativeId }
}

/**
 * Доверие после смены версии. Требование постановки: обновление возможности не
 * повышает ни доверие, ни права. Здесь сильнее: подмена содержимого СБРАСЫВАЕТ
 * заработанное — доверие принадлежит проверенному содержимому, а не имени.
 *
 * Первая регистрация обновлением не является: прежней версии нет, понижать нечего.
 */
export function trustAfterVersionChange(
  previous: TrustLevel,
  previousVersion: string | null,
  nextVersion: string
): TrustLevel {
  if (previousVersion === null) return previous
  return previousVersion === nextVersion ? previous : TRUST_FLOOR
}

/** Готовность возможности к работе — читается из источника, не хранится. */
export type CapabilityStatus = 'ready' | 'needs-config' | 'error' | 'disabled'

/**
 * Собранный паспорт. Поля делятся на два происхождения, и это важно читать:
 *  - из ИСТОЧНИКА (имя, описание, владелец, версия, включённость, инструменты) —
 *    свежие на каждом чтении;
 *  - из ОВЕРЛЕЯ в БД (доверие, оценка, отметка проверки, ручные ограничения) —
 *    того, чего в источниках нет.
 *
 * `allowedPaths`/`allowedDomains` намеренно nullable: сегодня НИ ОДИН источник их
 * не объявляет. null здесь честно значит «не ограничено этим слоем», и это не то
 * же самое, что пустой список. Выдумывать ограничение, которого нет, опаснее, чем
 * признать его отсутствие: следующий читатель принял бы фикцию за защиту.
 */
export interface Capability {
  id: string
  type: CapabilityType
  nativeId: string
  name: string
  description: string
  owner: string
  version: string
  source: string
  enabled: boolean
  status: CapabilityStatus
  allowedTools: string[] | null
  allowedPaths: string[] | null
  allowedDomains: string[] | null
  dependencies: string[]
  riskTier: CapabilityRisk
  trustLevel: TrustLevel
  evalScore: number | null
  lastVerifiedAt: number | null
}
