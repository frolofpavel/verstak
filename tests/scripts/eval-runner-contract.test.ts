import { describe, expect, it } from 'vitest'
// @ts-expect-error Eval runner is an executable JavaScript module.
import { codexRunner } from '../../scripts/eval/runners/codex.mjs'
// @ts-expect-error Eval runner is an executable JavaScript module.
import { opencodeRunner } from '../../scripts/eval/runners/opencode.mjs'
// @ts-expect-error Eval runner is an executable JavaScript module.
import { assertRunnerAdapter, probeVersion } from '../../scripts/eval/runners/process.mjs'
// @ts-expect-error Eval runner is an executable JavaScript module.
import { verstakArenaRunner } from '../../scripts/eval/runners/arena-verstak.mjs'

describe('Model Gym competitor runner contract', () => {
  it.each([verstakArenaRunner, codexRunner, opencodeRunner])(
    '$id declares comparable non-interactive workspace permissions',
    adapter => {
    expect(assertRunnerAdapter(adapter)).toBe(adapter)
    expect(adapter.automation).toBe('non-interactive')
    expect(adapter.permissionProfile).toBe('isolated-workspace-write')
    expect(adapter.versionArgs.at(-1)).toBe('--version')
    },
  )

  it('Codex sends the task over stdin and uses workspace-write sandbox', () => {
    const invocation = codexRunner.buildInvocation({
      workspace: 'C:/tmp/fixture',
      model: 'provider/model',
      task: 'fix this && never enter a shell',
    })
    expect(invocation.args).toContain('workspace-write')
    expect(invocation.args).toContain('provider/model')
    expect(invocation.args.at(-1)).toBe('-')
    expect(invocation.args).not.toContain('fix this && never enter a shell')
    expect(invocation.input).toBe('fix this && never enter a shell')
  })

  it('OpenCode uses pure non-interactive JSON mode in the isolated workspace', () => {
    const invocation = opencodeRunner.buildInvocation({
      workspace: 'C:/tmp/fixture',
      model: 'provider/model',
      task: 'fix the fixture',
    })
    expect(invocation.args).toEqual([
      'run',
      '--pure',
      '--auto',
      '--format',
      'json',
      '--dir',
      'C:/tmp/fixture',
      '--model',
      'provider/model',
      'fix the fixture',
    ])
  })

  it('probes installed runner versions without exposing credentials', () => {
    const probe = probeVersion(codexRunner, {
      ...process.env,
      VERSTAK_GATEWAY_API_KEY: 'vsk_live_must_not_leak_123456',
    })
    expect(probe.available).toBe(true)
    expect(probe.version).toMatch(/codex/i)
    expect(JSON.stringify(probe)).not.toContain('vsk_live_must_not_leak')
  })
})
