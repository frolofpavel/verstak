import { describe, it, expect, beforeEach, vi } from 'vitest'

// Стабим window.api.pipeline ДО импорта стора (как project-store-routing).
const getActive = vi.fn(async () => null as unknown)
const advance = vi.fn(async () => null as unknown)
const cancel = vi.fn(async () => undefined)
const windowStub = { api: { pipeline: { getActive, advance, cancel }, chats: { append: vi.fn() } } }
vi.stubGlobal('window', windowStub)

import { useProject } from '../../src/store/projectStore'
import type { PipelineRun } from '../../src/types/api'

function run(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 1, projectPath: 'C:/proj', chatId: null, agentRunId: null, mode: 'dev',
    workflowId: null, step: 'plan', brief: { goal: 'g', constraints: '', dod: 'd' },
    planId: null, verifyAttempts: 0, createdAt: 1, updatedAt: 1, ...over,
  }
}

beforeEach(() => {
  vi.stubGlobal('window', windowStub)
  useProject.setState({ path: 'C:/proj', activePipeline: null }, false)
  getActive.mockReset(); advance.mockReset(); cancel.mockReset()
})

describe('projectStore — Pipeline state', () => {
  it('startPipeline делает прогон активным', () => {
    useProject.getState().startPipeline(run({ id: 7 }))
    expect(useProject.getState().activePipeline?.id).toBe(7)
  })

  it('loadActivePipeline подтягивает активный прогон из БД', async () => {
    getActive.mockResolvedValueOnce(run({ id: 5, step: 'execute' }))
    await useProject.getState().loadActivePipeline('C:/proj')
    expect(getActive).toHaveBeenCalledWith('C:/proj')
    expect(useProject.getState().activePipeline?.step).toBe('execute')
  })

  it('loadActivePipeline игнорит результат если проект сменился (анти-stale)', async () => {
    getActive.mockImplementationOnce(async () => { useProject.setState({ path: 'C:/other' }, false); return run({ id: 9 }) })
    await useProject.getState().loadActivePipeline('C:/proj')
    expect(useProject.getState().activePipeline).toBeNull()
  })

  it('advancePipeline зовёт advance(id, patch) и обновляет стейт', async () => {
    useProject.getState().startPipeline(run({ id: 3 }))
    advance.mockResolvedValueOnce(run({ id: 3, step: 'verify', planId: 11 }))
    await useProject.getState().advancePipeline({ step: 'verify', planId: 11 })
    expect(advance).toHaveBeenCalledWith(3, { step: 'verify', planId: 11 })
    expect(useProject.getState().activePipeline?.step).toBe('verify')
    expect(useProject.getState().activePipeline?.planId).toBe(11)
  })

  it('advancePipeline без активного прогона — no-op', async () => {
    await useProject.getState().advancePipeline({ step: 'verify' })
    expect(advance).not.toHaveBeenCalled()
  })

  it('cancelPipeline очищает стейт и зовёт cancel(id)', async () => {
    useProject.getState().startPipeline(run({ id: 4 }))
    await useProject.getState().cancelPipeline()
    expect(cancel).toHaveBeenCalledWith(4)
    expect(useProject.getState().activePipeline).toBeNull()
  })
})
