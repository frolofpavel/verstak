import { describe, expect, it } from 'vitest'
import {
  SkillInstallBlockedError,
  assertSafeSkillArchiveEntry,
  validateSkillInstallPlan
} from '../../electron/ai/skills/install-guard'

const root = 'C:/Users/Pavel/.verstak/skills'

describe('skill install guard', () => {
  it('blocks targetDir traversal outside the skill root', async () => {
    await expect(validateSkillInstallPlan({
      skillRoot: root,
      targetDir: '../../etc',
      entries: [{ name: 'SKILL.md' }]
    })).rejects.toMatchObject({ code: 'target-outside-root' })
  })

  it('blocks zip-slip archive entries', () => {
    expect(() => assertSafeSkillArchiveEntry({ name: '../escape.md' }))
      .toThrow(SkillInstallBlockedError)
    expect(() => assertSafeSkillArchiveEntry({ name: 'safe/../../escape.md' }))
      .toThrow(SkillInstallBlockedError)
  })

  it('blocks absolute archive entries', () => {
    expect(() => assertSafeSkillArchiveEntry({ name: '/etc/passwd' }))
      .toThrow(SkillInstallBlockedError)
    expect(() => assertSafeSkillArchiveEntry({ name: 'C:/Users/Pavel/.ssh/id_ed25519' }))
      .toThrow(SkillInstallBlockedError)
  })

  it('fails closed when the archive scanner throws', async () => {
    await expect(validateSkillInstallPlan({
      skillRoot: root,
      targetDir: 'safe-skill',
      entries: [{ name: 'SKILL.md' }],
      scanEntry: () => { throw new Error('scanner unavailable') }
    })).rejects.toMatchObject({ code: 'scan-failed' })
  })

  it('blocks executable payloads inside imported skills', () => {
    for (const name of ['setup.sh', 'bin/helper.exe', 'scripts/install.ps1', 'payload.mjs']) {
      expect(() => assertSafeSkillArchiveEntry({ name })).toThrow(SkillInstallBlockedError)
    }
  })

  it('blocks hidden runtime hook paths', () => {
    for (const name of ['hooks/pre-run.md', '.hooks/on-approve.md', 'postinstall/README.md']) {
      expect(() => assertSafeSkillArchiveEntry({ name })).toThrow(SkillInstallBlockedError)
    }
  })

  it('allows plain markdown/json/assets in a safe target', async () => {
    const safe = await validateSkillInstallPlan({
      skillRoot: root,
      targetDir: 'safe-skill',
      entries: [
        { name: 'SKILL.md' },
        { name: 'README.md' },
        { name: 'metadata.json' },
        { name: 'assets/icon.png' }
      ],
      scanEntry: () => undefined
    })

    expect(safe.targetDirAbs.replace(/\\/g, '/')).toContain('/safe-skill')
    expect(safe.entries).toHaveLength(4)
  })
})
