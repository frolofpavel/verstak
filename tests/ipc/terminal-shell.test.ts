import { describe, expect, it } from 'vitest'
import { resolveTerminalShell } from '../../electron/ipc/terminal'

describe('resolveTerminalShell', () => {
  it('uses PowerShell on Windows exactly as before', () => {
    expect(resolveTerminalShell('win32', {}, () => false)).toBe('powershell.exe')
  })

  it('prefers the configured absolute shell on macOS', () => {
    expect(resolveTerminalShell('darwin', { SHELL: '/bin/zsh' }, path => path === '/bin/zsh')).toBe('/bin/zsh')
  })

  it('falls back to a deterministic system shell on macOS', () => {
    expect(resolveTerminalShell('darwin', {}, path => path === '/bin/bash')).toBe('/bin/bash')
    expect(resolveTerminalShell('darwin', {}, path => path === '/bin/sh')).toBe('/bin/sh')
  })
})
