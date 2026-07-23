// bridge-protocol.test.ts — framing / parse fail-closed (EXT-B1).

import { describe, it, expect } from 'vitest'
import {
  parseInboundMessage,
  encodeNativeFrame,
  NativeFrameDecoder,
  serializeOutbound,
  makeError,
  BRIDGE_PROTOCOL_VERSION,
  MAX_MESSAGE_BYTES,
  EXTENSION_ID,
} from '../../../electron/ai/browser/bridge'

function okHello(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    v: BRIDGE_PROTOCOL_VERSION,
    type: 'hello',
    requestId: 'r1',
    client: 'chrome-extension',
    extensionId: EXTENSION_ID,
    ...over,
  })
}

describe('bridge protocol — parseInboundMessage', () => {
  it('принимает валидный hello', () => {
    const r = parseInboundMessage(okHello())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.msg.type).toBe('hello')
      expect(r.msg.requestId).toBe('r1')
    }
  })

  it('malformed JSON → reject', () => {
    const r = parseInboundMessage('{not json')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('malformed_json')
  })

  it('oversize body → reject', () => {
    const big = 'x'.repeat(MAX_MESSAGE_BYTES + 10)
    const r = parseInboundMessage(big)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('oversize')
  })

  it('bad version → reject', () => {
    const r = parseInboundMessage(JSON.stringify({
      v: 99,
      type: 'hello',
      requestId: 'r',
      client: 'chrome-extension',
    }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('bad_version')
  })

  it('unknown type → reject', () => {
    const r = parseInboundMessage(JSON.stringify({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'shell_exec',
      requestId: 'r',
    }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('unknown_type')
  })

  it('click result without ids → reject', () => {
    const r = parseInboundMessage(JSON.stringify({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'click',
      requestId: 'r',
      ok: true,
    }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('bad_click_ids')
  })

  it('click with raw selector field → reject', () => {
    const r = parseInboundMessage(JSON.stringify({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'click',
      requestId: 'r',
      browserTaskId: 'bt',
      runId: 'run',
      tabRef: 'tab-1',
      elementRef: 'button:Ok:0',
      selector: '#evil',
      ok: true,
    }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('forbidden_field')
  })

  it('forbidden exec fields → reject', () => {
    const r = parseInboundMessage(JSON.stringify({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'hello',
      requestId: 'r',
      client: 'chrome-extension',
      shell: 'rm -rf /',
    }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('forbidden_field')
  })

  it('chrome:// tab attach → reject', () => {
    const r = parseInboundMessage(JSON.stringify({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'attach',
      requestId: 'r',
      tab: { tabRef: 't1', url: 'chrome://settings', title: 'x', origin: 'chrome://settings' },
    }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('bad_tab')
  })

  it('task_submit принимает только непустой prompt', () => {
    const good = parseInboundMessage(JSON.stringify({
      v: BRIDGE_PROTOCOL_VERSION, type: 'task_submit', requestId: 'task-1', prompt: 'Прочитай страницу',
    }))
    expect(good.ok).toBe(true)
    const bad = parseInboundMessage(JSON.stringify({
      v: BRIDGE_PROTOCOL_VERSION, type: 'task_submit', requestId: 'task-2', prompt: '   ',
    }))
    expect(bad.ok).toBe(false)
  })

  it('task_approval fail-closed без полного scope', () => {
    const r = parseInboundMessage(JSON.stringify({
      v: BRIDGE_PROTOCOL_VERSION, type: 'task_approval', requestId: 'a1',
      actionId: 'act', approvalDigest: 'digest', approved: true,
    }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('bad_approval')
  })
})

describe('bridge protocol — NativeFrameDecoder framing', () => {
  it('full frame in one chunk', () => {
    const json = okHello()
    const frame = encodeNativeFrame(json)
    const dec = new NativeFrameDecoder()
    const out = dec.push(frame)
    expect(out).toHaveLength(1)
    expect(out[0].ok).toBe(true)
    if (out[0].ok) expect(JSON.parse(out[0].json).type).toBe('hello')
  })

  it('fragmented frame across chunks', () => {
    const json = okHello()
    const frame = encodeNativeFrame(json)
    const dec = new NativeFrameDecoder()
    const mid = Math.floor(frame.length / 2)
    const a = dec.push(frame.subarray(0, mid))
    expect(a).toHaveLength(0)
    const b = dec.push(frame.subarray(mid))
    expect(b).toHaveLength(1)
    expect(b[0].ok).toBe(true)
  })

  it('fragmented header then body', () => {
    const json = okHello()
    const frame = encodeNativeFrame(json)
    const dec = new NativeFrameDecoder()
    expect(dec.push(frame.subarray(0, 2))).toHaveLength(0)
    expect(dec.push(frame.subarray(2, 4))).toHaveLength(0)
    const rest = dec.push(frame.subarray(4))
    expect(rest).toHaveLength(1)
    expect(rest[0].ok).toBe(true)
  })

  it('oversize length header → reject and reset', () => {
    const header = Buffer.alloc(4)
    header.writeUInt32LE(MAX_MESSAGE_BYTES + 1, 0)
    const dec = new NativeFrameDecoder()
    const out = dec.push(header)
    expect(out).toHaveLength(1)
    expect(out[0].ok).toBe(false)
    if (!out[0].ok) expect(out[0].code).toBe('oversize')
    // subsequent valid frame still works after reset
    const ok = dec.push(encodeNativeFrame(okHello()))
    expect(ok).toHaveLength(1)
    expect(ok[0].ok).toBe(true)
  })

  it('malformed json inside valid frame is still delivered as string (parse layer rejects)', () => {
    const frame = encodeNativeFrame('{broken')
    const dec = new NativeFrameDecoder()
    const out = dec.push(frame)
    expect(out[0].ok).toBe(true)
    if (out[0].ok) {
      const parsed = parseInboundMessage(out[0].json)
      expect(parsed.ok).toBe(false)
    }
  })

  it('serializeOutbound + makeError round-trip under cap', () => {
    const err = makeError('rid', 'x', 'y')
    const s = serializeOutbound(err)
    expect(JSON.parse(s).type).toBe('error')
    expect(Buffer.byteLength(s, 'utf8')).toBeLessThanOrEqual(MAX_MESSAGE_BYTES)
  })
})
