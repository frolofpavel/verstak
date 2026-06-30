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

  it('валидные ref-символы (точки/слэши/дефисы не-первым) проходят', () => {
    expect(buildDiffCommand({ base: 'feature/x-1.2' })).toEqual({ command: 'git --no-pager diff feature/x-1.2...HEAD' })
    expect(buildDiffCommand({ base: 'v1.2-rc' })).toEqual({ command: 'git --no-pager diff v1.2-rc...HEAD' })
  })

  it('ведущий дефис → ошибка (git-опция-инъекция: commit=--output=/path → запись файла)', () => {
    expect(buildDiffCommand({ commit: '--output=/tmp/x' })).toEqual({ error: expect.stringContaining('Небезопасный commit') })
    expect(buildDiffCommand({ commit: '-O.git/x' })).toEqual({ error: expect.stringContaining('Небезопасный commit') })
    expect(buildDiffCommand({ base: '-R' })).toEqual({ error: expect.stringContaining('Небезопасный base') })
    expect(buildDiffCommand({ base: '--ext-diff' })).toEqual({ error: expect.stringContaining('Небезопасный base') })
  })

  it("'..' в ref → ошибка (обход диапазона/родителя)", () => {
    expect(buildDiffCommand({ commit: '../../../etc/passwd' })).toEqual({ error: expect.stringContaining('Небезопасный commit') })
    expect(buildDiffCommand({ base: 'a..b' })).toEqual({ error: expect.stringContaining('Небезопасный base') })
  })
})
