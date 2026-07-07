import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { BUILT_IN_SKILLS } from '../../electron/ai/skills/built-in'
import { renderRecipeProtocol } from '../../electron/ai/skills/recipe'

const CLI = resolve(__dirname, '../../scripts/verstak-cli.mjs')

function runCli(args: string[]) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 30000 })
}

describe('verstak-cli headless recipe contract', () => {
  it('loads a built-in recipe and renders the recipe protocol without provider access', () => {
    const out = runCli([
      'recipe', 'run',
      '--recipe', 'bugfix',
      '--task', 'fix broken sum',
      '--json',
      '--dry-run',
    ])

    expect(out.status).toBe(0)
    const parsed = JSON.parse(out.stdout)
    expect(parsed.command).toBe('recipe run')
    expect(parsed.recipe.id).toBe('bugfix')
    expect(parsed.protocol).toContain('recipe: bugfix')
    expect(parsed.protocol).toContain('review_before_commit')
    expect(parsed.trace.recipeId).toBe('bugfix')
    expect(parsed.trace.reviewGate).toBe('required')
    expect(parsed.trace.lifecycleEvents.map((e: { type: string }) => e.type)).toEqual(['accepted', 'end'])
    expect(parsed.trace.toolCallsCount).toBe(0)
    expect(parsed.trace.turnsUsed).toBe(0)
    expect(parsed.trace.traceSecretLeak).toBe(false)
    expect(parsed.trace.verifyCommands).toEqual(['npm run type', 'npm run test:fast'])
  })

  it('renders the same protocol as the GUI recipe renderer', () => {
    const out = runCli([
      'recipe', 'run',
      '--recipe', 'bugfix',
      '--task', 'fix broken sum',
      '--json',
      '--dry-run',
    ])

    expect(out.status).toBe(0)
    const parsed = JSON.parse(out.stdout)
    const guiRecipe = BUILT_IN_SKILLS.find(skill => skill.id === 'bugfix')?.recipe

    expect(guiRecipe).toBeTruthy()
    expect(parsed.protocol).toBe(renderRecipeProtocol(guiRecipe!))
    expect(parsed.recipe.steps).toEqual(guiRecipe!.steps)
    expect(parsed.recipe.verify).toEqual(guiRecipe!.verify)
    expect(parsed.recipe.reviewer).toEqual(guiRecipe!.reviewer)
  })

  it('fails fast for an unknown recipe id', () => {
    const out = runCli([
      'recipe', 'run',
      '--recipe', 'missing-recipe',
      '--task', 'anything',
      '--dry-run',
    ])

    expect(out.status).toBe(1)
    expect(out.stderr).toContain('неизвестный recipe')
  })

  it('accepts --workspace as an alias for --project', () => {
    const out = runCli([
      'recipe', 'run',
      '--recipe', 'small-edit',
      '--task', 'change title',
      '--workspace', process.cwd(),
      '--json',
      '--dry-run',
    ])

    expect(out.status).toBe(0)
    const parsed = JSON.parse(out.stdout)
    expect(parsed.projectPath).toBe(process.cwd())
    expect(parsed.trace.reviewGate).toBe('not-required')
  })
})
