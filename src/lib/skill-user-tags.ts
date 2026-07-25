import type { Skill } from '../types/api'

const STORAGE_KEY = 'verstak.skillUserTags.v1'

type SkillTagsMap = Record<string, string[]>

export function normalizeSkillUserTags(tags: readonly string[] | string | null | undefined): string[] {
  const raw = Array.isArray(tags)
    ? tags
    : typeof tags === 'string'
      ? tags.split(/[,\n]/)
      : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    const clean = item.trim().replace(/\s+/g, ' ')
    const key = clean.toLowerCase()
    if (!clean || seen.has(key)) continue
    seen.add(key)
    out.push(clean)
  }
  return out.slice(0, 24)
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

export function readSkillUserTagsMap(): SkillTagsMap {
  if (!canUseStorage()) return {}
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: SkillTagsMap = {}
    for (const [id, tags] of Object.entries(parsed as Record<string, unknown>)) {
      const normalized = normalizeSkillUserTags(Array.isArray(tags) ? tags.map(String) : [])
      if (normalized.length) out[id] = normalized
    }
    return out
  } catch {
    return {}
  }
}

export function writeSkillUserTags(skillId: string, tags: readonly string[]): string[] {
  const normalized = normalizeSkillUserTags(tags)
  if (!canUseStorage()) return normalized
  const map = readSkillUserTagsMap()
  if (normalized.length) map[skillId] = normalized
  else delete map[skillId]
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  return normalized
}

export function withSkillsUserTags<T extends Skill>(skills: T[]): T[] {
  const tagsMap = readSkillUserTagsMap()
  return skills.map(skill => ({ ...skill, user_tags: tagsMap[skill.id] ?? [] }))
}
