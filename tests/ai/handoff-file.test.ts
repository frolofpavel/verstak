import { describe, expect, it } from 'vitest'
import { buildHandoffFileName, sanitizeHandoffFilePart } from '../../electron/ai/handoff-file'

describe('handoff file helpers', () => {
  it('builds a Windows-safe Downloads filename', () => {
    expect(sanitizeHandoffFilePart('Claude: Codex / plan? *')).toBe('Claude-Codex-plan')
    expect(buildHandoffFileName({
      sessionId: 42,
      title: 'Claude: Codex / plan? *',
      now: Date.UTC(2026, 5, 6, 12, 0, 0)
    })).toBe('verstak-handoff-42-Claude-Codex-plan-2026-06-06T12-00-00-000Z.md')
  })
})
