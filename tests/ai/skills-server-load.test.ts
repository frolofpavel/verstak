import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadAllSkills } from '../../electron/ai/skills/loader'

/**
 * B8: loadFromServer не оборачивал каждый серверный скилл в try/catch (в отличие
 * от loadFromDir) — один битый элемент (например без поля raw) бросал из
 * parseSkillFile и ронял загрузку ВСЕХ серверных скиллов (serverReachable=false).
 */
afterEach(() => { vi.unstubAllGlobals() })

describe('loadAllSkills — серверные скиллы (B8)', () => {
  it('один битый серверный скилл (без raw) не теряет остальные', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        skills: [
          { id: 'good-server-skill', raw: '---\nid: good-server-skill\n---\nтело' },
          { id: 'bad-no-raw' }, // нет raw → parseSkillFile упал бы и снёс всё
        ],
      }),
    })))

    const r = await loadAllSkills({ serverBase: 'https://example.test' })

    expect(r.serverReachable).toBe(true)
    expect(r.skills.some(s => s.id === 'good-server-skill')).toBe(true)
    expect(r.stats.server).toBe(1) // good загружен, bad пропущен — не уронил всё
  })

  // Этап 4: recipe доезжает до Skill.recipe через parseSkillFile (passthrough),
  // а невалидный recipe fail-soft → скилл грузится как обычный (recipe undefined).
  it('recipe passthrough: валидный → Skill.recipe, невалидный → обычный скилл', async () => {
    const withRecipe = `---
id: rec-skill
recipe:
  id: rec-skill
  steps:
    - apply_patch
    - run_verify
  verify:
    commands:
      - npm run type
---
тело рецепта`
    const badRecipe = `---
id: bad-rec
recipe:
  steps:
    - only_unknown_step
---
обычное тело`
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        skills: [
          { id: 'rec-skill', raw: withRecipe },
          { id: 'bad-rec', raw: badRecipe },
        ],
      }),
    })))

    const r = await loadAllSkills({ serverBase: 'https://example.test' })

    const rec = r.skills.find(s => s.id === 'rec-skill')
    expect(rec?.recipe).toBeDefined()
    expect(rec!.recipe!.steps).toEqual(['apply_patch', 'run_verify'])
    expect(rec!.recipe!.verify).toEqual({ commands: ['npm run type'] })

    // Невалидный recipe (нет известных шагов) → скилл цел, recipe отсутствует (fail-soft).
    const bad = r.skills.find(s => s.id === 'bad-rec')
    expect(bad).toBeDefined()
    expect(bad?.recipe).toBeUndefined()
  })
})
