import { describe, expect, it } from 'vitest'
import { parseEnvelope } from '../../mobile/shared/protocol'

const valid = {
  v: 1,
  id: 'cmd-1',
  accountId: 'account-1',
  deviceId: 'device-1',
  kind: 'roots.list',
  sentAt: 1_700_000_000_000,
  payload: {},
}

describe('mobile protocol', () => {
  it('parses a supported envelope', () => {
    expect(parseEnvelope(valid)).toEqual(valid)
  })

  it.each([
    [{ ...valid, v: 2 }, 'unsupported protocol version'],
    [{ ...valid, id: '' }, 'id'],
    [{ ...valid, accountId: '' }, 'accountId'],
    [{ ...valid, kind: 'shell.run' }, 'unknown message kind'],
  ])('rejects invalid envelope %#', (value, message) => {
    expect(() => parseEnvelope(value)).toThrow(message)
  })
})
