export interface MobileState {
  deviceId: string | null
  rootId: string | null
  chatId: number | null
  draft: string
  online: boolean
}
export type MobileAction =
  | { type: 'device.selected'; deviceId: string }
  | { type: 'root.selected'; rootId: string }
  | { type: 'chat.selected'; chatId: number }
  | { type: 'draft.changed'; text: string }
  | { type: 'connection.changed'; online: boolean }

export const createMobileState = (): MobileState => ({ deviceId: null, rootId: null, chatId: null, draft: '', online: false })
export function reduceMobileState(state: MobileState, action: MobileAction): MobileState {
  switch (action.type) {
    case 'device.selected': return { ...state, deviceId: action.deviceId, rootId: null, chatId: null }
    case 'root.selected': return { ...state, rootId: action.rootId, chatId: null }
    case 'chat.selected': return { ...state, chatId: action.chatId }
    case 'draft.changed': return { ...state, draft: action.text }
    case 'connection.changed': return { ...state, online: action.online }
  }
}
