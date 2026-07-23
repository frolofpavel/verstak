// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { useProject } = await import('../../src/store/projectStore')
const { BrowserActionApproval } = await import('../../src/components/BrowserActionApproval')

const resolveBrowserAction = vi.fn(async () => {})

const pending = () => ({
  callId: 'call-1',
  actionId: 'action-1',
  browserTaskId: 'bt-7',
  runId: 'run-1',
  risk: 'R3' as const,
  approvalDigest: 'digest-1',
  snapshot: {
    browserTaskId: 'bt-7',
    runId: 'run-1',
    scope: { origin: 'calltouch.com' },
    actionType: 'click',
    payload: { selector: '#save' },
    preconditions: { expectedOrigin: 'calltouch.com' },
    expectedPostcondition: null,
    risk: 'R3' as const,
  },
  reason: 'Нужно подтверждение',
  sendId: 42,
})

beforeEach(() => {
  resolveBrowserAction.mockClear()
  vi.stubGlobal('window', Object.assign(globalThis.window, {
    api: { ai: { resolveBrowserAction } },
  }))
  useProject.setState({ pendingBrowserAction: pending() })
})

afterEach(() => cleanup())

describe('BrowserActionApproval — живой widget transport', () => {
  it('видим и reject отправляет ровно одно scoped решение', async () => {
    render(createElement(BrowserActionApproval))
    expect(screen.getByText(/AI хочет выполнить действие/)).toBeTruthy()
    expect(screen.getByText('calltouch.com')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Отклонить' }))
    await waitFor(() => expect(resolveBrowserAction).toHaveBeenCalledTimes(1))
    expect(resolveBrowserAction).toHaveBeenCalledWith('action-1', 'digest-1', 'bt-7', 'run-1', false, 42)
  })

  it('approve отправляет ровно одно scoped решение', async () => {
    render(createElement(BrowserActionApproval))
    fireEvent.click(screen.getByRole('button', { name: /Выполнить один раз/ }))
    await waitFor(() => expect(resolveBrowserAction).toHaveBeenCalledTimes(1))
    expect(resolveBrowserAction).toHaveBeenCalledWith('action-1', 'digest-1', 'bt-7', 'run-1', true, 42)
  })
})
