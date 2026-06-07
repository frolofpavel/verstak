import { describe, it, expect } from 'vitest'
import { sandboxArgsForMode } from '../../electron/ai/codex-cli'

// Регрессия: режим Verstak (auto/bypass) не доходил до `codex exec` —
// он стартовал в read-only и не мог писать («авто не встало»). Маппинг
// режима в sandbox-флаг закрывает это.
describe('codex sandboxArgsForMode', () => {
  it('auto allows workspace writes', () => {
    expect(sandboxArgsForMode('auto')).toEqual(['-s', 'workspace-write'])
  })

  it('accept-edits allows workspace writes', () => {
    expect(sandboxArgsForMode('accept-edits')).toEqual(['-s', 'workspace-write'])
  })

  it('bypass skips sandbox entirely', () => {
    expect(sandboxArgsForMode('bypass')).toEqual(['--dangerously-bypass-approvals-and-sandbox'])
  })

  it('ask stays read-only', () => {
    expect(sandboxArgsForMode('ask')).toEqual(['-s', 'read-only'])
  })

  it('plan stays read-only', () => {
    expect(sandboxArgsForMode('plan')).toEqual(['-s', 'read-only'])
  })

  it('undefined defaults to read-only (safe)', () => {
    expect(sandboxArgsForMode(undefined)).toEqual(['-s', 'read-only'])
  })
})
