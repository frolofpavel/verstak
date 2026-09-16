// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { seedActive } from '../store/_active-bundle'
import { makeApiMock, type ApiMock, type ApiOverrides } from './helpers/window-api-mock'
import type { ReviewFinding } from '../../src/lib/review-findings'

const { useProject } = await import('../../src/store/projectStore')
const { ReviewPanel } = await import('../../src/components/ReviewPills')

const CHAT_ID = 7
const REVIEW_ID = 19
const MARKER = 'COMPUTER_OBSERVATION_DO_NOT_PERSIST'
const FINDING_FILE = 'private-screen-title.txt'

const FINDING: ReviewFinding = {
  id: 'f-1',
  file: FINDING_FILE,
  line: 12,
  severity: 'P1',
  category: 'security',
  title: `Injected ${MARKER}`,
  detail: `Raw desktop text ${MARKER}`,
  suggestedFix: `Do ${MARKER}`,
}

let mock: ApiMock

function calls(key: string) {
  return mock.calls.get(key)
}

function mount(overrides: ApiOverrides = {}) {
  mock = makeApiMock({
    computerUse: { isChatTainted: async () => false },
    verifications: { latest: async () => null },
    ai: { send: async () => 81 },
    chats: { append: async () => ({ id: 201 }) },
    journal: { append: async () => true },
    plans: { create: async () => ({ id: 91 }) },
    ...overrides,
  })
  Object.assign(window, { api: mock.api })
  vi.spyOn(window, 'alert').mockImplementation(() => {})

  useProject.setState({
    path: '/project',
    activeChatId: CHAT_ID,
    chats: {},
    sendOwners: {},
    reviews: {
      [REVIEW_ID]: {
        reviewChatId: REVIEW_ID,
        parentChatId: CHAT_ID,
        providerId: 'claude',
        model: 'claude-reviewer',
        content: `ЗАМЕЧАНИЙ: 1\n${MARKER}`,
        status: 'done',
        createdAt: 1,
        noteCount: 1,
        findings: [FINDING],
        accepted: [FINDING.id],
      },
    },
    openedReviewId: REVIEW_ID,
  }, false)
  seedActive(useProject, {
    messages: [
      { role: 'user', content: 'исходная задача' },
      { role: 'assistant', content: 'исходный ответ' },
    ],
    isStreaming: false,
  })

  return render(createElement(ReviewPanel))
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ReviewPanel — durable Computer Use taint', () => {
  it('tainted parent: «Учесть» fail-closed до send, messages, chat append и journal', async () => {
    mount({ computerUse: { isChatTainted: async () => true } })
    const before = useProject.getState().chats[CHAT_ID].messages

    fireEvent.click(screen.getByRole('button', { name: /учесть в чате/i }))

    await waitFor(() => expect(calls('computerUse.isChatTainted')).toHaveBeenCalledWith(CHAT_ID))
    expect(window.alert).toHaveBeenCalled()
    expect(calls('ai.send')).toBeUndefined()
    expect(calls('chats.append')).toBeUndefined()
    expect(calls('journal.append')).toBeUndefined()
    expect(useProject.getState().chats[CHAT_ID].messages).toEqual(before)
  })

  it('ошибка taint probe: «Исправить выбранные» тоже fail-closed без durable side effects', async () => {
    mount({
      computerUse: { isChatTainted: async () => { throw new Error('ledger unavailable') } },
    })

    fireEvent.click(screen.getByRole('button', { name: /исправить выбранные/i }))

    await waitFor(() => expect(window.alert).toHaveBeenCalled())
    expect(calls('ai.send')).toBeUndefined()
    expect(calls('chats.append')).toBeUndefined()
    expect(calls('journal.append')).toBeUndefined()
    expect(useProject.getState().chats[CHAT_ID].messages).toHaveLength(2)
  })

  it('tainted parent: «В план» не пишет reviewer-derived finding ни в plan, ни в journal', async () => {
    mount({ computerUse: { isChatTainted: async () => true } })

    fireEvent.click(screen.getByRole('button', { name: /в план/i }))

    expect(await screen.findByText(/computer use/i)).toBeTruthy()
    expect(calls('plans.create')).toBeUndefined()
    expect(calls('journal.append')).toBeUndefined()
  })
})

describe('ReviewPanel — clean control pairs', () => {
  it('clean «Учесть»: main preflight precedes persistence; journal contains metadata only', async () => {
    const order: string[] = []
    mount({
      computerUse: { isChatTainted: async () => { order.push('taint'); return false } },
      ai: { send: async () => { order.push('send'); return 81 } },
      chats: { append: async () => { order.push('append'); return { id: 201 } } },
      journal: { append: async () => { order.push('journal'); return true } },
    })

    fireEvent.click(screen.getByRole('button', { name: /учесть в чате/i }))

    await waitFor(() => expect(calls('journal.append')).toHaveBeenCalledTimes(1))
    expect(order.indexOf('taint')).toBeLessThan(order.indexOf('send'))
    expect(order.indexOf('send')).toBeLessThan(order.indexOf('append'))
    expect(order.indexOf('send')).toBeLessThan(order.indexOf('journal'))
    expect(calls('ai.send')?.mock.calls[0][0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining(MARKER) }),
    ]))
    expect(calls('chats.append')).toHaveBeenCalledWith(
      CHAT_ID, '/project', 'user', expect.stringContaining(MARKER),
    )
    const journalDetail = String(calls('journal.append')?.mock.calls[0][3] ?? '')
    expect(journalDetail).not.toContain(MARKER)
    expect(journalDetail).not.toContain(FINDING_FILE)
    expect(JSON.parse(journalDetail)).toMatchObject({
      reviewChatId: REVIEW_ID,
      providerId: 'claude',
      findingCount: 1,
    })
  })

  it('clean «Исправить выбранные»: sends before persistence and keeps raw prompt out of journal', async () => {
    const order: string[] = []
    mount({
      computerUse: { isChatTainted: async () => false },
      ai: { send: async () => { order.push('send'); return 82 } },
      chats: { append: async () => { order.push('append'); return { id: 202 } } },
      journal: { append: async () => { order.push('journal'); return true } },
    })

    fireEvent.click(screen.getByRole('button', { name: /исправить выбранные/i }))

    await waitFor(() => expect(calls('journal.append')).toHaveBeenCalledTimes(1))
    expect(order.indexOf('send')).toBeLessThan(order.indexOf('append'))
    expect(order.indexOf('send')).toBeLessThan(order.indexOf('journal'))
    expect(calls('chats.append')).toHaveBeenCalledWith(
      CHAT_ID, '/project', 'user', expect.stringContaining(MARKER),
    )
    const journalDetail = String(calls('journal.append')?.mock.calls[0][3] ?? '')
    expect(journalDetail).not.toContain(MARKER)
    expect(journalDetail).not.toContain(FINDING_FILE)
    expect(JSON.parse(journalDetail)).toMatchObject({
      reviewChatId: REVIEW_ID,
      providerId: 'claude',
      findingCount: 1,
    })
  })

  it('clean «В план»: plan behavior stays intact and journal remains metadata-only', async () => {
    mount()

    fireEvent.click(screen.getByRole('button', { name: /в план/i }))

    await waitFor(() => expect(calls('plans.create')).toHaveBeenCalledTimes(1))
    expect(calls('plans.create')?.mock.calls[0][2]).toEqual([
      expect.objectContaining({ title: expect.stringContaining(MARKER) }),
    ])
    await waitFor(() => expect(calls('journal.append')).toHaveBeenCalledTimes(1))
    const journalDetail = String(calls('journal.append')?.mock.calls[0][3] ?? '')
    expect(journalDetail).not.toContain(MARKER)
    expect(journalDetail).not.toContain(FINDING_FILE)
    expect(JSON.parse(journalDetail)).toMatchObject({
      reviewChatId: REVIEW_ID,
      providerId: 'claude',
      findingCount: 1,
    })
  })
})
