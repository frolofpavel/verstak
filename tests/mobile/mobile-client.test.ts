import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMobileRequestId } from '../../mobile/app/src/client'
import { createMobileState, reduceMobileState } from '../../mobile/app/src/state'

afterEach(() => vi.unstubAllGlobals())

describe('mobile app state', () => {
  it('navigates device to root to chat and keeps offline draft', () => {
    let state = createMobileState()
    state = reduceMobileState(state, { type: 'device.selected', deviceId: 'pc' })
    state = reduceMobileState(state, { type: 'root.selected', rootId: 'root' })
    state = reduceMobileState(state, { type: 'chat.selected', chatId: 4 })
    state = reduceMobileState(state, { type: 'draft.changed', text: 'Продолжить задачу' })
    state = reduceMobileState(state, { type: 'connection.changed', online: false })
    expect(state).toMatchObject({ deviceId: 'pc', rootId: 'root', chatId: 4, draft: 'Продолжить задачу', online: false })
  })
})

describe('mobile client', () => {
  it('creates request ids without crypto.randomUUID for local http browsers', () => {
    vi.stubGlobal('crypto', {})
    expect(createMobileRequestId()).toMatch(/^m-[a-z0-9]+-[a-z0-9]+$/)
  })
})
