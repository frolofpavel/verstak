import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const { toolsForOutcomePhase } = await import('../../electron/ipc/ai')

describe('Outcome phase capability ceiling', () => {
  it('refine allows repository reads and submit_task_contract, but no writes', () => {
    const tools = toolsForOutcomePhase('refine') ?? []
    expect(tools).toContain('read_file')
    expect(tools).toContain('submit_task_contract')
    expect(tools).not.toContain('write_file')
    expect(tools).not.toContain('run_command')
    expect(tools).not.toContain('create_plan')
  })

  it('plan allows read-only delegates and create_plan, but no writes', () => {
    const tools = toolsForOutcomePhase('plan') ?? []
    expect(tools).toContain('delegate_task')
    expect(tools).toContain('delegate_parallel')
    expect(tools).toContain('create_plan')
    expect(tools).not.toContain('write_file')
    expect(tools).not.toContain('apply_patch')
    expect(tools).not.toContain('run_command')
  })

  it('execute-step keeps the normal execution contract', () => {
    expect(toolsForOutcomePhase('execute-step')).toBeUndefined()
  })
})
