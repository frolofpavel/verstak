import { describe, it, expect } from 'vitest'
import { buildDiffCommand } from '../../electron/ipc/tool-handlers/review-diff'

describe('review-diff — buildDiffCommand', () => {
  it('по умолчанию (uncommitted) → diff HEAD', () => {
    const r = buildDiffCommand({})
    expect(r).toEqual({ command: 'git --no-pager diff HEAD' })
  })

  it('uncommitted:true → diff HEAD', () => {
    expect(buildDiffCommand({ uncommitted: true })).toEqual({ command: 'git --no-pager diff HEAD' })
  })

  it('base → three-dot merge-base diff', () => {
    expect(buildDiffCommand({ base: 'main' })).toEqual({ command: 'git --no-pager diff main...HEAD' })
    expect(buildDiffCommand({ base: 'origin/release' })).toEqual({ command: 'git --no-pager diff origin/release...HEAD' })
  })

  it('commit → git show', () => {
    expect(buildDiffCommand({ commit: 'a1b2c3d' })).toEqual({ command: 'git --no-pager show a1b2c3d' })
  })

  it('commit имеет приоритет над base', () => {
    expect(buildDiffCommand({ commit: 'abc', base: 'main' })).toEqual({ command: 'git --no-pager show abc' })
  })

  it('инъекция в base → ошибка (защита от shell-инъекции)', () => {
    expect(buildDiffCommand({ base: 'main; rm -rf /' })).toEqual({ error: expect.stringContaining('Небезопасный base') })
    expect(buildDiffCommand({ base: '$(whoami)' })).toEqual({ error: expect.stringContaining('Небезопасный base') })
    expect(buildDiffCommand({ base: 'a && b' })).toEqual({ error: expect.stringContaining('Небезопасный base') })
  })

  it('инъекция в commit → ошибка', () => {
    expect(buildDiffCommand({ commit: 'abc`id`' })).toEqual({ error: expect.stringContaining('Небезопасный commit') })
  })

  it('валидные ref-символы (точки/слэши/дефисы) проходят', () => {
    expect(buildDiffCommand({ base: 'feature/x-1.2' })).toEqual({ command: 'git --no-pager diff feature/x-1.2...HEAD' })
  })
})
