import { create } from 'zustand'
import type { Skill } from '../types/api'

/**
 * Стор скиллов — отделён от projectStore чтобы не раздувать его дальше.
 * Pre-loaded при старте приложения, refresh по запросу пользователя.
 *
 * activeSkillId хранится per-store, не per-chat — V1. Для per-chat overrides
 * (разные скиллы в разных вкладках) добавим в V3.1.
 */
interface SkillState {
  skills: Skill[]
  activeSkillId: string | null
  loading: boolean
  lastRefreshAt: number | null
  serverReachable: boolean
  refresh: () => Promise<void>
  setActiveSkill: (id: string | null) => void
  /** Find skill by either id or slash trigger (без `/`). */
  resolve: (idOrSlash: string) => Skill | null
}

export const useSkills = create<SkillState>((set, get) => ({
  skills: [],
  activeSkillId: null,
  loading: false,
  lastRefreshAt: null,
  serverReachable: false,
  async refresh() {
    if (get().loading) return
    set({ loading: true })
    try {
      const list = await window.api.skills.list()
      const status = await window.api.skills.status()
      set({
        skills: Array.isArray(list) ? list : [],
        loading: false,
        lastRefreshAt: status.lastRefreshAt,
        serverReachable: status.serverReachable
      })
    } catch (err) {
      console.error('[skills] refresh failed:', err)
      set({ loading: false })
    }
  },
  setActiveSkill(id) {
    set({ activeSkillId: id })
    // B2: скилл с default_mode переключает режим агента (sticky). agent_mode —
    // глобальная настройка; useAgentMode (UI) и ai.ts (исполнение) читают её из
    // settings. Раньше default_mode парсился, но нигде не применялся — скилл,
    // заявляющий plan, не активировал заявленную безопасность.
    if (id) {
      const skill = get().skills.find(s => s.id === id)
      if (skill?.default_mode) void window.api.settings.setKey('agent_mode', skill.default_mode)
    }
  },
  resolve(idOrSlash) {
    const s = get().skills
    return s.find(x => x.id === idOrSlash || x.slash === idOrSlash) ?? null
  }
}))
