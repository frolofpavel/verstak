import { describe, expect, it, vi } from 'vitest'
import { MobileBridgeSession } from '../../electron/mobile-bridge/session'
import { createEnvelope } from '../../mobile/shared/protocol'

describe('MobileBridgeSession', () => {
  it('does not execute duplicate commands twice', async () => {
    const handler = vi.fn(async () => ({ sendId: 7 }))
    const session = new MobileBridgeSession({ 'chat.send': handler })
    const command = createEnvelope({ id: 'same', accountId: 'a', deviceId: 'd', kind: 'chat.send', payload: { text: 'hi' } })
    expect(await session.handle(command)).toEqual(await session.handle(command))
    expect(handler).toHaveBeenCalledOnce()
  })

  it('rejects unknown handlers and replayed approval decisions', async () => {
    const session = new MobileBridgeSession({})
    const unknown = createEnvelope({ id: 'x', accountId: 'a', deviceId: 'd', kind: 'files.list', payload: {} })
    await expect(session.handle(unknown)).rejects.toThrow('unsupported mobile command')
    const approval = createEnvelope({ id: 'approve', accountId: 'a', deviceId: 'd', kind: 'approval.resolve', payload: {} })
    const allowed = new MobileBridgeSession({ 'approval.resolve': async () => ({ ok: true }) })
    await allowed.handle(approval)
    await expect(allowed.handle(approval)).rejects.toThrow('approval replay')
  })
})
