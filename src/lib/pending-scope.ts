import type { SendOwner } from '../store/projectStore'

/**
 * Ключ scope композера (очередь сообщений + дополнения) — срез 2.0.11, дефект №1 карты
 * Chat.tsx (§3.1).
 *
 * ДЕФЕКТ БЫЛ НЕ В ФОРМУЛЕ, А В ИСТОЧНИКЕ ДАННЫХ. Ключ строился ДВАЖДЫ:
 *  · «живой» — прямо в рендере, из реактивного helpChatId → `help:<реальный id>`;
 *  · «в роутере» — внутри замыкания ПЕРВОГО рендера (подписка ai.onEvent ставится один раз,
 *    deps стабильны), где helpChatId навсегда остаётся null → `help:global`.
 * Две формулы совпадали, а значения — нет. Из-за этого для справки очистка чистила
 * НЕСУЩЕСТВУЮЩИЙ scope, а флаш уходил в ветку «чужой scope» и клал элемент обратно в очередь.
 * Очередь справки не отправлялась; спасал только страховочный эффект-флаш.
 *
 * Здесь формула ОДНА и берёт значения аргументами — устаревать нечему. Вызывающий обязан
 * передать свежие данные (в Chat.tsx — через useProject.getState(), как это делает роутер
 * для всего остального).
 */

export function normalizeProjectPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Ключ scope для чата справки. */
export function helpScopeKey(helpChatId: number | null | undefined): string {
  return `help:${helpChatId ?? 'global'}`
}

/** Ключ scope для чата проекта. */
export function projectScopeKey(projectPath: string, chatId: number): string {
  return `project:${normalizeProjectPath(projectPath)}:${chatId}`
}

/** Ключ активного scope (то, что видит человек прямо сейчас). 'none' — некуда класть. */
export function activeScopeKey(args: {
  isHelpChat: boolean
  helpChatId: number | null
  activePath: string | null
  activeChatId: number | null
}): string {
  if (args.isHelpChat) return helpScopeKey(args.helpChatId)
  if (args.activePath && args.activeChatId != null) return projectScopeKey(args.activePath, args.activeChatId)
  return 'none'
}

/**
 * Ключ scope для ВЛАДЕЛЬЦА прогона. null — у владельца нет scope композера (ревью и т.п.).
 *
 * `helpChatId` приходит АРГУМЕНТОМ, а не из замыкания: ровно на этом ломался дефект №1.
 */
export function ownerScopeKey(owner: SendOwner | null, helpChatId: number | null): string | null {
  if (owner?.kind !== 'chat') return null
  if (owner.isHelp) return helpScopeKey(helpChatId)
  if (!owner.projectPath || owner.chatId == null) return null
  return projectScopeKey(owner.projectPath, owner.chatId)
}
