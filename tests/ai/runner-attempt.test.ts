import { describe, expect, it, vi } from 'vitest'
import type { AgentRuns } from '../../electron/storage/agent-runs'
import { createApiFallbackController } from '../../electron/ai/runner-attempt'
import type { FallbackOpts } from '../../electron/ai/runner-shared'
import type { ChatProvider } from '../../electron/ai/types'

function provider(id: string): ChatProvider {
  return {
    id,
    name: id,
    models: ['model'],
    async *send() {
      yield { type: 'done' as const }
    },
  }
}

function fallbackOpts(overrides: Partial<FallbackOpts> = {}): FallbackOpts {
  return {
    getProviderModel: () => 'fallback-model',
    configuredProviders: new Set(['gemini-api', 'claude']),
    triedProviders: new Set(['gemini-api']),
    ...overrides,
  }
}

function createRuns() {
  return {
    updateActual: vi.fn(),
    updateActualAccount: vi.fn(),
  }
}

function controller(overrides: Record<string, unknown> = {}) {
  const runFallbackFrame = vi.fn(async () => {})
  const emitRouteChanged = vi.fn()
  const onHandedOff = vi.fn()
  const createTools = vi.fn(() => ({ kind: 'tools' }))
  const input = {
    providerId: 'gemini-api' as const,
    model: 'gemini-3-flash',
    fallbackOpts: fallbackOpts({
      getNextAttempt: () => ({ provider: provider('claude'), accountId: 42 }),
    }),
    currentMessages: [{ role: 'user' as const, content: 'Продолжай задачу' }],
    createTools,
    getNudgeBudgetUsed: () => 1,
    emitRouteChanged,
    onHandedOff,
    runFallbackFrame,
    ...overrides,
  }
  return {
    api: createApiFallbackController(input),
    runFallbackFrame,
    emitRouteChanged,
    onHandedOff,
    createTools,
  }
}

describe('runner-attempt — provider/account lifecycle', () => {
  it('provider fallback переносит историю, маршрут и account lineage в новый кадр', async () => {
    const runs = createRuns()
    const c = controller({
      agentRuns: runs as unknown as AgentRuns,
      runId: 'run-1',
    })

    const result = c.api.attemptProviderFallback(new Error('503 Service Unavailable'))
    expect(result).not.toBeNull()
    await result

    expect(runs.updateActual).toHaveBeenCalledWith(
      'run-1',
      'claude',
      'fallback-model'
    )
    expect(runs.updateActualAccount).toHaveBeenCalledWith('run-1', 42)
    expect(c.emitRouteChanged).toHaveBeenCalledWith(
      'model-fallback',
      expect.any(Error),
      { providerId: 'claude', model: 'fallback-model' },
      2
    )
    expect(c.onHandedOff).toHaveBeenCalledOnce()
    expect(c.runFallbackFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        isFallbackFrame: true,
        providerId: 'claude',
        model: 'fallback-model',
        nudgeBudgetUsed: 1,
        initialMessages: [{ role: 'user', content: 'Продолжай задачу' }],
      })
    )
  })

  it('legacy getNextProvider не переписывает account lineage', async () => {
    const runs = createRuns()
    const c = controller({
      agentRuns: runs as unknown as AgentRuns,
      runId: 'run-legacy',
      fallbackOpts: fallbackOpts({
        getNextProvider: () => provider('claude'),
      }),
    })

    const result = c.api.attemptProviderFallback(new Error('503 Service Unavailable'))
    expect(result).not.toBeNull()
    await result

    expect(runs.updateActual).toHaveBeenCalled()
    expect(runs.updateActualAccount).not.toHaveBeenCalled()
  })
})

describe('runner-attempt — policy и bounded rotation', () => {
  it('pinned account запрещает и ротацию, и provider fallback', () => {
    const switchAccountOnLimit = vi.fn(() => ({ switched: true }))
    const c = controller({
      fallbackOpts: fallbackOpts({
        pinnedAccount: true,
        switchAccountOnLimit,
      }),
    })

    expect(
      c.api.attemptAccountSwitch(
        new Error('Claude usage limit reached. Try again in 2 hours.')
      )
    ).toBeNull()
    expect(
      c.api.attemptProviderFallback(new Error('503 Service Unavailable'))
    ).toBeNull()
    expect(switchAccountOnLimit).not.toHaveBeenCalled()
    expect(c.runFallbackFrame).not.toHaveBeenCalled()
  })

  it('quota rotation остаётся bounded и пишет новый accountId', async () => {
    const runs = createRuns()
    const opts = fallbackOpts({
      configuredProviders: new Set(['gemini-api']),
      getNextAttempt: () => ({ provider: provider('gemini-api'), accountId: 7 }),
      switchAccountOnLimit: () => ({
        switched: true,
        newAccountId: 7,
        fromLabel: 'A',
        toLabel: 'B',
      }),
    })
    const c = controller({
      fallbackOpts: opts,
      agentRuns: runs as unknown as AgentRuns,
      runId: 'run-quota',
    })

    const result = c.api.attemptAccountSwitch(
      new Error('Claude usage limit reached. Try again in 2 hours.')
    )
    expect(result).not.toBeNull()
    await result

    expect(opts.accountSwitchCount).toBe(1)
    expect(runs.updateActualAccount).toHaveBeenCalledWith('run-quota', 7)
    expect(c.emitRouteChanged).toHaveBeenCalledWith(
      'rotate-account',
      expect.any(Error),
      { providerId: 'gemini-api', model: 'gemini-3-flash' },
      1,
      expect.objectContaining({
        resetAt: expect.any(Number),
        accounts: { fromLabel: 'A', toLabel: 'B' },
      })
    )

    opts.accountSwitchCount = 4
    expect(
      c.api.attemptAccountSwitch(
        new Error('Claude usage limit reached. Try again in 2 hours.')
      )
    ).toBeNull()
    expect(c.runFallbackFrame).toHaveBeenCalledTimes(1)
  })

  it('permanent auth инвалидирует аккаунт без временного cooldown', async () => {
    const switchAccountOnLimit = vi.fn(() => ({ switched: false }))
    const c = controller({
      fallbackOpts: fallbackOpts({ switchAccountOnLimit }),
    })

    expect(
      c.api.attemptAccountSwitch(
        new Error('invalid_grant: refresh token revoked')
      )
    ).toBeNull()
    expect(switchAccountOnLimit).toHaveBeenCalledWith(
      'gemini-api',
      null,
      'auth'
    )
    expect(c.runFallbackFrame).not.toHaveBeenCalled()
  })

  it('обычная ошибка не меняет провайдера без force', async () => {
    const c = controller()

    expect(c.api.attemptProviderFallback(new Error('validation failed'))).toBeNull()
    expect(c.emitRouteChanged).not.toHaveBeenCalled()
    expect(c.runFallbackFrame).not.toHaveBeenCalled()

    const forced = c.api.attemptProviderFallback(
      new Error('tool_calling_unsupported'),
      true
    )
    expect(forced).not.toBeNull()
    await forced
  })
})
