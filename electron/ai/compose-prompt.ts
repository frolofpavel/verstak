import { SYSTEM_LAYER_PROMPT, SYSTEM_LAYER_VERSION } from './system-layer'
import type { UserLayer } from './user-layer'

/**
 * Маркер границы кэша между СТАБИЛЬНЫМ префиксом (system-layer + user-layer +
 * skill + preflight — не меняется между ходами сессии) и ИЗМЕНЧИВЫМ хвостом
 * (context-pack: git-status, недавние правки, память — меняется каждый ход).
 *
 * Prompt caching префиксный: изменчивый байт в середине инвалидирует весь кэш
 * после него. Поэтому мы кладём стабильное ПЕРВЫМ, ставим маркер, изменчивое —
 * ПОСЛЕ. claude.ts режет по маркеру и вешает cache_control на стабильный блок
 * (Anthropic explicit caching). Остальные провайдеры получают строку со снятым
 * маркером (systemForProvider) — стабильный префикс идёт первым → авто-кэш
 * OpenAI/DeepSeek/Gemini implicit попадает сам. См. token-audit 01.07.
 */
export const CACHE_BREAKPOINT = '<<VERSTAK_CACHE_BP>>'

/** Снять маркер кэша (для провайдеров без explicit caching + для debug-снапшота). */
export function stripCacheBreakpoint(system: string): string {
  return system.split(CACHE_BREAKPOINT).join('')
}

/** Система для конкретного провайдера: Anthropic ('claude') получает маркер
 *  (сам режет и кэширует), все прочие — снятый (авто-кэш по стабильному префиксу). */
export function systemForProvider(system: string, providerId: string): string {
  return providerId === 'claude' ? system : stripCacheBreakpoint(system)
}

export interface ComposedPrompt {
  /** Final string to put in the API's `system` field (or system message). */
  system: string
  /** Metadata for telemetry / UI. */
  meta: {
    systemLayerVersion: string
    userLayerPath: string | null
    userLayerBytes: number
    contextPackBytes: number
  }
}

/**
 * Экранирует XML-чувствительные символы в НЕДОВЕРЕННОМ контенте user-layer
 * (AGENTS.md/CLAUDE.md клонированного/удалённого репо), чтобы он не мог закрыть
 * тег <user_layer> и подсунуть инъекционные инструкции/теги (prompt-injection).
 * context-pack НЕ экранируем — там код проекта, экранирование сломало бы
 * читаемость. Security (ревью 23.06 #2, паритет с OpenClaw/Hermes).
 */
function escapeLayerContent(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function composeSystemPrompt(userLayer: UserLayer, contextPack = '', skillPrompt = ''): ComposedPrompt {
  const trimmedUser = userLayer.content.trim()
  const trimmedPack = contextPack.trim()
  const trimmedSkill = skillPrompt.trim()
  const userBlock = trimmedUser
    ? `\n\n<user_layer source="${userLayer.path}">\n${escapeLayerContent(trimmedUser)}\n</user_layer>`
    : ''
  const packBlock = trimmedPack ? `\n\n${trimmedPack}` : ''
  // Слой 4 — специализация активного скилла. Наслаивается ПОВЕРХ базового
  // протокола (system-layer + user-layer + context-pack), не заменяя его:
  // скилл уточняет роль и стиль, но 7-шаговый цикл выполнения остаётся.
  // skillPrompt тоже экранируем: скилл может быть установлен из стороннего/общего
  // источника (как расширение) → потенциально недоверенный инжект в <skill_layer>.
  // Консистентно с user-layer (security-review 23.06).
  const skillBlock = trimmedSkill
    ? `\n\n<skill_layer>\n${escapeLayerContent(trimmedSkill)}\n</skill_layer>`
    : ''
  // Мягкий nudge: перед сложной/многофайловой/деструктивной задачей объявить
  // план через preflight. НЕ для тривиальных одиночных правок — иначе раздражает.
  const preflightHint = '\n\n<preflight_hint>\nПеред сложной, многофайловой или деструктивной задачей сначала вызови preflight (план: затронутые зоны, уровень риска, что проверить после, что вне scope / запреты), затем выполняй. Для тривиальной одиночной правки preflight не нужен.\n</preflight_hint>'
  // Порядок для prompt caching: СТАБИЛЬНОЕ (system-layer + user + skill + preflight)
  // → маркер → ИЗМЕНЧИВОЕ (context-pack). Раньше packBlock стоял в СЕРЕДИНЕ (перед
  // skill) — это ломало бы кэш (изменчивое инвалидирует всё после). context-pack —
  // это данные проекта, порядок после skill-специализации семантически безвреден.
  const stablePrefix = `${SYSTEM_LAYER_PROMPT}${userBlock}${skillBlock}${preflightHint}`
  const system = packBlock
    ? `${stablePrefix}${CACHE_BREAKPOINT}${packBlock}`
    : stablePrefix

  return {
    system,
    meta: {
      systemLayerVersion: SYSTEM_LAYER_VERSION,
      userLayerPath: userLayer.path,
      userLayerBytes: trimmedUser.length,
      contextPackBytes: trimmedPack.length
    }
  }
}
