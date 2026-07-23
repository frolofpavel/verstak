// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'

const { UsageTab } = await import('../../src/components/settings/UsageTab')

const group = (runs: number, cacheWriteTokens: number, cacheReadTokens: number) => ({
  providerId: 'claude',
  model: 'claude-sonnet-4-6',
  transport: 'API',
  accountId: 7,
  accountLabel: 'Рабочий Claude',
  runs,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens,
  cacheWriteTokens,
  costAmount: 3.75,
  unknownCostRuns: 0,
  cacheHitShare: 0.5,
})

beforeEach(() => {
  let summaryCall = 0
  vi.stubGlobal('window', Object.assign(globalThis.window, {
    api: {
      usage: {
        summary: vi.fn(async () => (++summaryCall % 2 === 1 ? [group(2, 300, 700)] : [group(8, 900, 4_100)])),
        list: vi.fn(async () => [{
          runId: 'r1', providerId: 'claude', model: 'claude-sonnet-4-6', transport: 'API',
          accountId: 7, accountLabel: 'Рабочий Claude', inputTokens: 100, outputTokens: 20,
          cacheReadTokens: 700, cacheWriteTokens: 300, inputAccounting: 'exclusive',
          costAmount: 3.75, currency: 'USD', pricingKnown: 1, cacheDiagnosticCode: 'first-request',
          createdAt: Date.now(),
        }]),
      },
    },
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('UsageTab 2.1.3-E', () => {
  it('одновременно показывает 7/30, cache write/read и аккаунт маршрута', async () => {
    render(createElement(UsageTab))
    await waitFor(() => expect(screen.getAllByText(/Рабочий Claude/).length).toBeGreaterThan(0))
    expect(screen.getByText('7 дней')).toBeTruthy()
    expect(screen.getByText('30 дней')).toBeTruthy()
    expect(screen.getAllByText(/записано/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/прочитано/).length).toBeGreaterThan(0)
    expect(screen.getByText(/кэш ⇧300/)).toBeTruthy()
    expect(screen.getByText(/кэш ⚡700/)).toBeTruthy()
  })
})
