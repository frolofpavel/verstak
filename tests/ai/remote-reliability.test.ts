import { describe, expect, it } from 'vitest'
import { buildRemoteSearchCommand } from '../../electron/ai/tools'
import { buildRemoteTscCommand } from '../../electron/ipc/tool-handlers'

describe('remote reliability helpers', () => {
  it('buildRemoteSearchCommand prefers rg and excludes heavy directories in grep fallback', () => {
    const cmd = buildRemoteSearchCommand('foo.bar')
    expect(cmd).toContain('command -v rg')
    expect(cmd).toContain('rg -n --color never -i -F')
    expect(cmd).toContain("-g '!node_modules/**'")
    expect(cmd).toContain("-g '!__pycache__/**'")
    expect(cmd).toContain('grep -rniE')
    expect(cmd).toContain("--exclude-dir='node_modules'")
    expect(cmd).toContain("--exclude-dir='__pycache__'")
    expect(cmd).toContain('| head -100')
  })

  it('buildRemoteSearchCommand preserves regex mode when requested', () => {
    const cmd = buildRemoteSearchCommand('foo.*bar', { regex: true, ignoreCase: false })
    expect(cmd).toContain('rg -n --color never')
    expect(cmd).not.toContain(' -F ')
    expect(cmd).toContain('grep -rnE')
  })

  it('buildRemoteTscCommand checks tsconfig and falls back to npx on the remote host', () => {
    const cmd = buildRemoteTscCommand()
    expect(cmd).toContain('[ ! -f tsconfig.json ]')
    expect(cmd).toContain('__VERSTAK_NO_TSCONFIG__')
    expect(cmd).toContain('./node_modules/.bin/tsc --noEmit --pretty false')
    expect(cmd).toContain('npx tsc --noEmit --pretty false')
  })
})
