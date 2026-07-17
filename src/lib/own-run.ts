import type { SendOwner } from '../store/projectStore'

/**
 * «Какой прогон принадлежит ЭТОМУ чату» — срез 2.0.11, дефект №2 карты Chat.tsx (§3.2).
 *
 * ПРОБЛЕМА. В Chat.tsx «текущий прогон» жил в единственном ref (`currentSendIdRef`) — один
 * слот на ВСЕ чаты, хотя файл поддерживает мульти-чат стримы. Чат A стримит → переключились
 * в B → отправили → ref перезаписан прогоном B. Вернулись в A: его стрим жив, человек
 * дописывает контекст — и дополнение уходит в ЧУЖОЙ прогон. Молча.
 *
 * РЕШЕНИЕ. Отдельный ref не нужен вовсе: стор УЖЕ знает владельца каждого прогона
 * (`sendOwners`: sendId → owner). Единственный слот не просто дублировал этот реестр — он
 * ему противоречил. Спрашиваем реестр, а не память об «одном последнем».
 */

/**
 * sendId живого прогона ЭТОГО чата, или null.
 *
 * Помощь (isHelp) — отдельная лента, в обычный чат не подмешивается: у неё свой owner и свой
 * scope, иначе дополнение из проектного чата уехало бы в справку.
 */
export function findRunForChat(
  sendOwners: Record<number, SendOwner>,
  chatId: number | null,
  opts?: { help?: boolean },
): number | null {
  if (chatId == null) return null
  const wantHelp = opts?.help === true
  const ids = Object.keys(sendOwners)
    .map(Number)
    .filter(id => Number.isFinite(id))
    // Свежий прогон важнее старого: sendId монотонно растёт, поэтому больший — новее.
    .sort((a, b) => b - a)
  for (const id of ids) {
    const o = sendOwners[id]
    if (o?.kind !== 'chat') continue
    if (o.chatId !== chatId) continue
    if (!!o.isHelp !== wantHelp) continue
    return id
  }
  return null
}

/**
 * Принадлежит ли прогон этому чату. Нужен там, где sendId уже на руках и надо решить,
 * наш он или чужой (например прежде чем слать в него дополнение).
 */
export function isRunOfChat(
  sendOwners: Record<number, SendOwner>,
  sendId: number | null,
  chatId: number | null,
): boolean {
  if (sendId == null || chatId == null) return false
  const o = sendOwners[sendId]
  return o?.kind === 'chat' && o.chatId === chatId
}
