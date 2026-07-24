import { describe, it, expect } from 'vitest'
import { parseSkillFile } from '../../electron/ai/skills/loader'

/**
 * parseSkillFile получал raw не строкой (сервер отдал элемент без поля raw →
 * undefined) и падал на raw.replace — исключение улетало выше. Теперь
 * не-строковый вход честно даёт null (скилл пропускается, а не роняет загрузку).
 */
describe('parseSkillFile — защита от не-строкового raw', () => {
  it('undefined raw → null, без исключения', () => {
    expect(() => parseSkillFile(undefined as unknown as string, 'server:bad', 'server')).not.toThrow()
    expect(parseSkillFile(undefined as unknown as string, 'server:bad', 'server')).toBeNull()
  })

  it('null / number / object raw → null', () => {
    for (const bad of [null, 42, { id: 'x' }] as unknown as string[]) {
      expect(parseSkillFile(bad, 'server:bad', 'server')).toBeNull()
    }
  })

  it('валидный raw по-прежнему парсится (BOM срезается)', () => {
    const skill = parseSkillFile('﻿---\nid: ok-skill\n---\nтело', 'skills/ok-skill.md', 'built-in')
    expect(skill?.id).toBe('ok-skill')
  })
})
