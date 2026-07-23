import { describe, expect, it, vi } from 'vitest'
import { submitTaskContractHandler } from '../../electron/ipc/tool-handlers/outcome'
import { validContract } from '../contracts/outcome-contract.test'

function call(over: Record<string, unknown> = {}) {
  const { rawRequest: _raw, revision: _revision, schemaVersion: _schema, ...args } = validContract
  return { id: 'tc1', name: 'submit_task_contract', args: { ...args, ...over } } as never
}

function ctx(over: Record<string, unknown> = {}) {
  const pipeline = {
    id: 7, projectPath: '/project', brief: { goal: 'сырая задача' }, contractRevision: 0,
  }
  return {
    projectPath: '/project',
    sendId: 1,
    outcome: { pipelineId: 7, phase: 'refine' },
    sender: { send: vi.fn() },
    pipelineRuns: {
      get: vi.fn(() => pipeline),
      saveContract: vi.fn((_id, contract) => ({ ...pipeline, contractRevision: contract.revision })),
    },
    ...over,
  }
}

describe('submit_task_contract', () => {
  it('берёт pipelineId и rawRequest только из server context', async () => {
    const c = ctx()
    const result = await submitTaskContractHandler.handle(call({ pipelineId: 999, rawRequest: 'подмена' }), c as never)
    expect(result.error).toBeUndefined()
    expect(c.pipelineRuns.saveContract).toHaveBeenCalledWith(7, expect.objectContaining({ rawRequest: 'сырая задача', revision: 1 }))
    expect(c.sender.send).toHaveBeenCalledWith('ai:event', expect.objectContaining({
      event: expect.objectContaining({ type: 'task-contract-created', pipelineId: 7 }),
    }))
  })

  it('вне refine возвращает typed error и ничего не пишет', async () => {
    const c = ctx({ outcome: { pipelineId: 7, phase: 'plan' } })
    const result = await submitTaskContractHandler.handle(call(), c as never)
    expect(result.error).toContain('OUTCOME_PHASE_REQUIRED')
    expect(c.pipelineRuns.saveContract).not.toHaveBeenCalled()
  })

  it('пустые criteria и секрет блокируют persistence', async () => {
    const empty = ctx()
    expect((await submitTaskContractHandler.handle(call({ successCriteria: [] }), empty as never)).error).toContain('TASK_CONTRACT_INVALID')
    expect(empty.pipelineRuns.saveContract).not.toHaveBeenCalled()

    const secret = ctx()
    expect((await submitTaskContractHandler.handle(call({ goal: `Сохранить ${'sk-' + 'a'.repeat(24)}` }), secret as never)).error).toContain('SECRET_BLOCKED')
    expect(secret.pipelineRuns.saveContract).not.toHaveBeenCalled()
  })
})
