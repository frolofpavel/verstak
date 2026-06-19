import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildProfileBlock, safeParseProfile, profileHasContent, EXTRACT_PROFILE_PROMPT,
  loadProjectProfile, PROFILE_REL_PATH,
} from '../../electron/ai/project-profile'

describe('project-profile — Шаг C (machine-readable профиль)', () => {
  it('buildProfileBlock: только непустые поля, с заголовком', () => {
    const block = buildProfileBlock({ summary: 'Десктоп AI-агент', stack: 'Electron + TS', goal: '' })
    expect(block).toContain('## Профиль проекта')
    expect(block).toContain('суть: Десктоп AI-агент')
    expect(block).toContain('стек: Electron + TS')
    expect(block).not.toContain('цель:') // пустое поле опущено
  })

  it('пустой профиль → пустая строка (вызывающий ничего не инжектит)', () => {
    expect(buildProfileBlock({})).toBe('')
    expect(buildProfileBlock(null)).toBe('')
    expect(buildProfileBlock({ summary: '   ' })).toBe('')
  })

  it('profileHasContent', () => {
    expect(profileHasContent({ goal: 'x' })).toBe(true)
    expect(profileHasContent({})).toBe(false)
    expect(profileHasContent(null)).toBe(false)
  })

  it('safeParseProfile: валидный JSON → профиль, мусорные поля отброшены', () => {
    const p = safeParseProfile('{"summary":"S","goal":"G","junk":123,"stack":42}')
    expect(p).toEqual({ summary: 'S', goal: 'G' }) // stack=42 (не строка) отброшен
  })

  it('safeParseProfile: битый JSON / пусто → null', () => {
    expect(safeParseProfile('{не json')).toBeNull()
    expect(safeParseProfile('')).toBeNull()
    expect(safeParseProfile('{}')).toBeNull()
    expect(safeParseProfile('{"summary":"  "}')).toBeNull() // пробелы = пусто
  })

  it('round-trip: parse(stringify(profile)) сохраняет поля', () => {
    const orig = { summary: 'S', stack: 'TS', conventions: 'strict' }
    expect(safeParseProfile(JSON.stringify(orig))).toEqual(orig)
  })

  it('промпт извлечения требует JSON «для агента» + запись в .verstak/profile.json', () => {
    expect(EXTRACT_PROFILE_PROMPT).toMatch(/ДЛЯ АГЕНТА/)
    expect(EXTRACT_PROFILE_PROMPT).toMatch(/валидный JSON/)
    expect(EXTRACT_PROFILE_PROMPT).toContain(PROFILE_REL_PATH)
  })

  it('loadProjectProfile: читает .verstak/profile.json; нет файла → null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gg-profile-'))
    try {
      expect(await loadProjectProfile(dir)).toBeNull() // файла нет
      mkdirSync(join(dir, '.verstak'))
      writeFileSync(join(dir, '.verstak', 'profile.json'), '{"summary":"S","stack":"TS"}')
      expect(await loadProjectProfile(dir)).toEqual({ summary: 'S', stack: 'TS' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
