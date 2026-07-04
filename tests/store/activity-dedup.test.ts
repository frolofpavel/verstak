import { describe, it, expect, beforeEach, vi } from 'vitest'

// Регрессия: pushActivity дедупит по id. attest_verification (и др. tool-activity)
// эмитит два события с одинаковым callId+name (pending + result) → раньше в стрим
// падали ДВЕ строки с одинаковым React-key → предупреждение о дубль-key +
// «Maximum update depth exceeded» (thrash реконсиляции). Теперь второй апдейтит
// первый на месте.

const windowStub = {
  api: {
    chats: { list: vi.fn(async () => []), append: vi.fn(async () => {}) },
    settings: { setKey: vi.fn(async () => {}) },
    chatSessions: { listReviews: vi.fn(async () => []) },
  },
}
vi.stubGlobal('window', windowStub)

import { useProject } from '../../src/store/projectStore'

describe('pushActivity — дедуп по id', () => {
  beforeEach(() => {
    useProject.getState().clearActivity()
  })

  it('одинаковый id не создаёт дубль-строку, а обновляет существующую', () => {
    const store = useProject.getState()
    const id = 'call_00_ABC-attest_verification'
    store.pushActivity({ id, kind: 'command', label: 'attest_verification', status: 'pending', timestamp: 1 })
    store.pushActivity({ id, kind: 'command', label: 'attest_verification', detail: 'DoD 2/2', status: 'ok', timestamp: 2 })

    const activity = useProject.getState().activity
    expect(activity).toHaveLength(1)
    expect(activity[0].status).toBe('ok')
    expect(activity[0].detail).toBe('DoD 2/2')
    // Уникальность id (React-key) — инвариант, который держит стрим.
    expect(new Set(activity.map(a => a.id)).size).toBe(activity.length)
  })

  it('разные id добавляются как отдельные строки в порядке прихода', () => {
    const store = useProject.getState()
    store.pushActivity({ id: 'a', kind: 'read', label: 'read_file', status: 'ok', timestamp: 1 })
    store.pushActivity({ id: 'b', kind: 'list', label: 'list_directory', status: 'ok', timestamp: 2 })

    const activity = useProject.getState().activity
    expect(activity.map(a => a.id)).toEqual(['a', 'b'])
  })
})
