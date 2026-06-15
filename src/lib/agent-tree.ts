import type { SubSession } from '../types/api'

/** Узел развёрстанного дерева делегирования. */
export interface TreeNode {
  sub: SubSession
  level: number
  /** Есть ли дочерние суб-агенты — для toggle сворачивания. */
  hasChildren: boolean
  /** id родительского узла (sub.id) — для скрытия под свёрнутым предком. */
  parentId: number | null
}

/**
 * Дерево делегирования (Фаза 4, Идея 3): раскладывает плоский список суб-сессий
 * в иерархию main → суб → под-суб по связи callId ↔ parentCallId. Возвращает
 * упорядоченный pre-order список с уровнем отступа на каждый узел. Узлы без
 * родителя (parentCallId == null) или с неизвестным родителем — корни (дети
 * главного агента). Защита от циклов: посещённые callId не разворачиваются дважды.
 *
 * Вынесено из AgentsPanel.tsx в отдельный модуль — переиспользуется панелью
 * Agents и будущей панелью Задач (Multi-agent Manager).
 */
export function buildAgentTree(subs: SubSession[]): TreeNode[] {
  const byParent = new Map<string, SubSession[]>()
  const knownCallIds = new Set(subs.map(s => s.callId).filter(Boolean) as string[])
  const roots: SubSession[] = []
  for (const s of subs) {
    const parent = s.parentCallId
    if (parent && knownCallIds.has(parent)) {
      const arr = byParent.get(parent) ?? []
      arr.push(s)
      byParent.set(parent, arr)
    } else {
      roots.push(s)
    }
  }
  const out: TreeNode[] = []
  const visited = new Set<number>()
  const walk = (s: SubSession, level: number, parentId: number | null) => {
    if (visited.has(s.id)) return  // защита от циклов
    visited.add(s.id)
    const children = s.callId ? byParent.get(s.callId) ?? [] : []
    out.push({ sub: s, level, hasChildren: children.length > 0, parentId })
    for (const c of children) walk(c, level + 1, s.id)
  }
  for (const r of roots) walk(r, 0, null)
  // На случай орфанов из цикла — добавим непосещённые в конец как корни.
  for (const s of subs) if (!visited.has(s.id)) walk(s, 0, null)
  return out
}
