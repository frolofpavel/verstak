import { describe, expect, it, vi } from 'vitest'
import { createRelayRouter } from '../../mobile/relay/router'
import { createEnvelope } from '../../mobile/shared/protocol'

describe('mobile relay router', () => {
  it('routes commands only to the matching desktop', () => {
    const router = createRelayRouter()
    const owner = vi.fn()
    const stranger = vi.fn()
    router.registerConnection({ accountId: 'a', deviceId: 'd', role: 'desktop' }, owner)
    router.registerConnection({ accountId: 'b', deviceId: 'd', role: 'desktop' }, stranger)
    const result = router.route(createEnvelope({ id: '1', accountId: 'a', deviceId: 'd', kind: 'roots.list', payload: {} }))
    expect(result).toEqual({ delivered: 1 })
    expect(owner).toHaveBeenCalledOnce()
    expect(stranger).not.toHaveBeenCalled()
  })

  it('reports an offline target and rejects replayed ids', () => {
    const router = createRelayRouter()
    const envelope = createEnvelope({ id: 'same', accountId: 'a', deviceId: 'd', kind: 'roots.list', payload: { secret: 'not logged' } })
    expect(router.route(envelope)).toEqual({ delivered: 0 })
    expect(() => router.route(envelope)).toThrow('replayed envelope')
    expect(router.audit()).toEqual([{ id: 'same', accountId: 'a', deviceId: 'd', kind: 'roots.list', delivered: 0 }])
  })

  it('routes live run events from desktop to the matching mobile stream', () => {
    const router = createRelayRouter()
    const mobile = vi.fn()
    const desktop = vi.fn()
    router.registerConnection({ accountId: 'a', deviceId: 'd', role: 'mobile' }, mobile)
    router.registerConnection({ accountId: 'a', deviceId: 'd', role: 'desktop' }, desktop)
    const result = router.route(createEnvelope({ id: 'evt-1', accountId: 'a', deviceId: 'd', kind: 'run.event', payload: { runId: '42', event: { type: 'text', text: 'hi' } } }))
    expect(result).toEqual({ delivered: 1 })
    expect(mobile).toHaveBeenCalledOnce()
    expect(desktop).not.toHaveBeenCalled()
  })
})
