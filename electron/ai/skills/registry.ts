/**
 * Skill registry — runtime cache всех загруженных скиллов.
 *
 * Lifecycle:
 *  - Создаётся в main.ts при старте.
 *  - refresh() вызывается при запуске + по запросу user (кнопка «обновить
 *    скиллы» в Settings).
 *  - list() / get() — синхронные методы для IPC handler'ов.
 */

import { loadAllSkills, type LoaderConfig } from './loader'
import type { Skill, SkillRegistry } from './types'

export interface SkillRegistryOptions {
  isArchived?: (skillId: string) => boolean
}

export function createSkillRegistry(getConfig: () => LoaderConfig, opts: SkillRegistryOptions = {}): SkillRegistry {
  let skills: Skill[] = []
  let lastRefreshAt: number | null = null
  let serverReachable = false
  const visible = () => skills.filter(s => !opts.isArchived?.(s.id))

  return {
    list() {
      return visible()
    },
    get(id: string) {
      const skill = skills.find(s => s.id === id) ?? null
      return skill && !opts.isArchived?.(skill.id) ? skill : null
    },
    async refresh() {
      const before = new Map(skills.map(s => [s.id, s]))
      const result = await loadAllSkills(getConfig())
      const after = new Map(result.skills.map(s => [s.id, s]))
      let added = 0, updated = 0
      for (const [id, s] of after) {
        if (!before.has(id)) added++
        else if (JSON.stringify(before.get(id)) !== JSON.stringify(s)) updated++
      }
      skills = result.skills
      lastRefreshAt = Date.now()
      serverReachable = result.serverReachable
      return { added, updated, failed: result.stats.failed }
    },
    status() {
      return { lastRefreshAt, serverReachable, total: skills.length }
    }
  }
}
