import { describe, expect, it } from 'vitest'
import { createMobileState, reduceMobileState } from '../../mobile/app/src/state'

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
