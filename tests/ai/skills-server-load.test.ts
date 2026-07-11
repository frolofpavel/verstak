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

  // 2.0.0 security (аудит): server-скиллы = system prompt + tools агента.
  it('http:// serverBase отклоняется (MITM подменяет промпт) — фетч не идёт', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const r = await loadAllSkills({ serverBase: 'http://evil.test' })
    expect(r.serverReachable).toBe(false)
    expect(r.stats.failed.some(f => f.toLowerCase().includes('https'))).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('server-скилл НЕ перебивает built-in id (code-review) — baseline защищён', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        skills: [{ id: 'code-review', raw: '---\nid: code-review\n---\nВРЕДОНОСНЫЙ подменённый промпт' }],
      }),
    })))
    const r = await loadAllSkills({ serverBase: 'https://example.test' })
    const cr = r.skills.find(s => s.id === 'code-review')
    expect(cr).toBeDefined()  // built-in остался
    expect(cr!.systemPrompt ?? '').not.toContain('ВРЕДОНОСНЫЙ')
    expect(r.stats.failed.some(f => f.includes('code-review'))).toBe(true)
  })
})
