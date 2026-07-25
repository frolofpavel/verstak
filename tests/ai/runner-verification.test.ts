import { describe, expect, it, vi } from 'vitest'
import { buildTurnVerificationHint } from '../../electron/ai/runner-verification'
import type { ToolContext, ToolHandler } from '../../electron/ipc/tool-handlers'

const context = {} as ToolContext

describe('buildTurnVerificationHint', () => {
  it('не запускает verification без принятых writes', async () => {
    const detectVerifyScripts = vi.fn(async () => ['npm test'])
    await expect(
      buildTurnVerificationHint({
        acceptedWrites: 0,
        tsWrites: 0,
        lspWrites: new Map(),
        toolCalls: [],
        projectPath: 'C:\\repo',
        context,
        diagnosticEnabled: true,
        detectVerifyScripts,
      }),
    ).resolves.toBe('')
    expect(detectVerifyScripts).not.toHaveBeenCalled()
  })

  it('TS diagnostics имеют приоритет над script hint', async () => {
    const handle = vi.fn(async () => ({
      id: 'auto-diag',
      name: 'check_diagnostics',
      result: 'src/a.ts(1,1): error TS1005: expected',
    }))
    const detectVerifyScripts = vi.fn(async () => ['npm test'])
    const hint = await buildTurnVerificationHint({
      acceptedWrites: 1,
      tsWrites: 1,
      lspWrites: new Map(),
      toolCalls: [],
      projectPath: 'C:\\repo',
      context,
      diagnosticEnabled: true,
      resolveHandler: () => ({ mode: 'sequential', handle }) as ToolHandler,
      detectVerifyScripts,
    })

    expect(handle).toHaveBeenCalledOnce()
    expect(hint).toContain('TS1005')
    expect(detectVerifyScripts).not.toHaveBeenCalled()
  })

  it('чистая диагностика откатывается к bounded project scripts', async () => {
    const hint = await buildTurnVerificationHint({
      acceptedWrites: 2,
      tsWrites: 0,
      lspWrites: new Map(),
      toolCalls: [],
      projectPath: 'C:\\repo',
      context,
      diagnosticEnabled: false,
      detectVerifyScripts: async () => ['npm test', 'npm run type', 'npm run lint'],
    })

    expect(hint).toContain('2 write(s)')
    expect(hint).toContain('npm test / npm run type')
    expect(hint).not.toContain('npm run lint')
  })
})
