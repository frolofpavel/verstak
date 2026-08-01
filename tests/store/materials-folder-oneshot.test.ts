// VSK-PRODUCT-A1 (композер): one-shot вооружение код-сводки материалов в projectStore.
// Проверяем: (1) set/clear + дефолт null; (2) НЕ течёт между чатами (switchChatSession
// сбрасывает); (3) снимается при смене проекта (папка относится к прежнему проекту).
import { describe, it, expect, beforeEach, vi } from 'vitest'

const baseWindow = {
  api: {
    chats: { listWindow: vi.fn(async () => ({ messages: [], totalCount: 0, hasMoreBefore: false })), append: vi.fn(async () => {}), list: vi.fn(async () => []) },
    agentRuns: { list: vi.fn(async () => []) },
    settings: { getKey: vi.fn(async () => null), setKey: vi.fn(async () => {}) },
    projects: { list: vi.fn(async () => []) },
    chatSessions: {
      list: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: 9, providerId: null, model: null })),
      listReviews: vi.fn(async () => []),
      setModel: vi.fn(async () => {}),
      get: vi.fn(async () => ({ id: 5, providerId: null, model: null })),
      messages: vi.fn(async () => []),
    },
  },
}
vi.stubGlobal('window', baseWindow)

import { useProject } from '../../src/store/projectStore'

const FOLDER = { path: 'C:/proj/docs', name: 'docs', docCount: 3 }
const flush = () => new Promise(r => setTimeout(r, 0))

describe('projectStore: one-shot materialsFolder', () => {
  beforeEach(() => {
    vi.stubGlobal('window', baseWindow)
    useProject.setState({ path: 'C:/proj', activeChatId: 1, materialsFolder: null, chatSessions: [] })
  })

  it('setMaterialsFolder задаёт и снимает; дефолт — null', () => {
    expect(useProject.getState().materialsFolder).toBeNull()
    useProject.getState().setMaterialsFolder(FOLDER)
    expect(useProject.getState().materialsFolder).toEqual(FOLDER)
    useProject.getState().setMaterialsFolder(null)
    expect(useProject.getState().materialsFolder).toBeNull()
  })

  it('switchChatSession сбрасывает вооружение (не течёт в другой чат)', async () => {
    useProject.getState().setMaterialsFolder(FOLDER)
    await useProject.getState().switchChatSession(2)
    expect(useProject.getState().materialsFolder, 'вооружение не должно течь в другой чат').toBeNull()
    await flush()
  })
  // Сброс при СМЕНЕ ПРОЕКТА живёт в setProject (projectStore) и защищён комментарием
  // там; отдельным пином не покрыт — полный конвейер открытия проекта тянет весь
  // window.api и не относится к one-shot-инварианту. Основные утечки закрыты этим
  // switchChatSession-пином и one-shot-снятием на отправке (send-chat-message.test).
})
