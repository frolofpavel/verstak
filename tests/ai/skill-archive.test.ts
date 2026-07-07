import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { archiveUserSkillFile, archivedSkillsDir, restoreArchivedUserSkillFile } from '../../electron/ai/skills/archive'
import type { Skill } from '../../electron/ai/skills/types'

describe('skill archive helpers', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gg-skill-archive-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('moves local user skill into .archive and restores it back', async () => {
    const sourceRef = join(root, 'custom.md')
    await writeFile(sourceRef, '---\nid: custom\nname: Custom\n---\n\nBody', 'utf8')
    const skill: Skill = {
      id: 'custom',
      name: 'Custom',
      systemPrompt: 'Body',
      source: 'user',
      sourceRef
    }

    const archived = await archiveUserSkillFile(skill, root)
    expect(archived.moved).toBe(true)
    expect(existsSync(sourceRef)).toBe(false)
    expect(existsSync(join(archivedSkillsDir(root), 'custom.md'))).toBe(true)

    const restored = await restoreArchivedUserSkillFile('custom', root)
    expect(restored.moved).toBe(true)
    expect(existsSync(join(root, 'custom.md'))).toBe(true)
  })

  it('does not move built-in or external user skill files', async () => {
    await mkdir(join(root, 'external'), { recursive: true })
    const external = join(root, 'external', 'custom.md')
    await writeFile(external, '---\nid: custom\n---\n\nBody', 'utf8')

    const builtIn = await archiveUserSkillFile({
      id: 'code-review',
      systemPrompt: '',
      source: 'built-in',
      sourceRef: 'built-in:code-review'
    }, root)
    expect(builtIn).toMatchObject({ moved: false, reason: 'not-user-skill' })

    const outside = await archiveUserSkillFile({
      id: 'custom',
      systemPrompt: '',
      source: 'user',
      sourceRef: external
    }, join(root, 'skills'))
    expect(outside).toMatchObject({ moved: false, reason: 'outside-user-skill-root' })
  })
})
