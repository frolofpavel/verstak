import { describe, expect, it } from 'vitest'
import {
  decideAgentJobTransition,
  type AgentJobV1,
} from '../../shared/contracts/agent-job'

function job(status: AgentJobV1['status'], writeScope: string[] = []): Pick<AgentJobV1, 'status' | 'writeScope'> {
  return { status, writeScope }
}

describe('Agent Job state machine 2.1.2', () => {
  it('queued становится ready только после succeeded dependencies', () => {
    expect(decideAgentJobTransition(job('queued'), 'ready')).toMatchObject({
      allowed: false,
      code: 'dependencies-pending',
    })
    expect(decideAgentJobTransition(job('queued'), 'ready', { dependenciesSucceeded: true })).toEqual({ allowed: true })
  })

  it('running может назначить только scheduler', () => {
    expect(decideAgentJobTransition(job('ready'), 'running')).toMatchObject({
      allowed: false,
      code: 'scheduler-required',
    })
    expect(decideAgentJobTransition(job('ready'), 'running', { scheduler: true })).toEqual({ allowed: true })
  })

  it('interrupted writer требует явного approve, reader можно вернуть', () => {
    expect(decideAgentJobTransition(job('interrupted', ['src/a.ts']), 'ready')).toMatchObject({
      allowed: false,
      code: 'writer-resume-approval-required',
    })
    expect(decideAgentJobTransition(job('interrupted', ['src/a.ts']), 'ready', { userApprovedResume: true })).toEqual({ allowed: true })
    expect(decideAgentJobTransition(job('interrupted'), 'ready')).toEqual({ allowed: true })
  })

  it('terminal job не переходит никуда', () => {
    for (const status of ['succeeded', 'failed', 'blocked', 'cancelled'] as const) {
      expect(decideAgentJobTransition(job(status), 'ready')).toMatchObject({ allowed: false, code: 'terminal' })
    }
  })

  it('queued может стать blocked при проваленной зависимости', () => {
    expect(decideAgentJobTransition(job('queued'), 'blocked')).toEqual({ allowed: true })
  })
})
