import { create } from 'zustand'
import type { Skill } from '../types/api'
import { withSkillsUserTags } from '../lib/skill-user-tags'

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
  pendingDraftSkillId: string | null
  loading: boolean
  lastRefreshAt: number | null
  serverReachable: boolean
  refresh: () => Promise<void>
  setActiveSkill: (id: string | null) => void
  queueDraftSkill: (id: string | null) => void
  consumeDraftSkill: () => string | null
  /** Find skill by either id or slash trigger (без `/`). */
  resolve: (idOrSlash: string) => Skill | null
}

export const useSkills = create<SkillState>((set, get) => ({
  skills: [],
  activeSkillId: null,
  pendingDraftSkillId: null,
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
        skills: Array.isArray(list) ? withSkillsUserTags(list) : [],
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
    if (id) {
      void window.api.skills.recordUse(id).catch(err => {
        console.warn('[skills] record use failed:', err)
      })
    }
  },
  queueDraftSkill(id) {
    set({ pendingDraftSkillId: id })
    if (id) {
      void window.api.skills.recordUse(id).catch(err => {
        console.warn('[skills] record use failed:', err)
      })
    }
  },
  consumeDraftSkill() {
    const id = get().pendingDraftSkillId
    if (id) set({ pendingDraftSkillId: null })
    return id
  },
  resolve(idOrSlash) {
    const s = get().skills
    return s.find(x => x.id === idOrSlash || x.slash === idOrSlash) ?? null
  }
}))
