// host-runtime.mjs — Chrome Native Messaging host (stdio) → Verstak named pipe.
//
// Запускается Chrome'ом. Не исполняет shell/JS-команд: только framed JSON
// relay. Если desktop offline — отвечает error state=offline.
//
// Этот файл копируется в package/resources и в userData при install.

import { createConnection } from 'node:net'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_MESSAGE_BYTES = 256 * 1024
const BRIDGE_PROTOCOL_VERSION = 1
const NATIVE_HOST_NAME = 'ru.verstak.browser_bridge'

function findEndpoint() {
  // 1) VERSTAK_BRIDGE_ENDPOINT env (tests/dev)
  if (process.env.VERSTAK_BRIDGE_ENDPOINT) {
    return process.env.VERSTAK_BRIDGE_ENDPOINT
  }
  // 2) userData storage endpoint file (Electron app name = verstak)
  const candidates = []
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    candidates.push(join(appData, 'verstak', 'storage', 'browser-bridge-endpoint.json'))
    candidates.push(join(appData, 'Verstak', 'storage', 'browser-bridge-endpoint.json'))
  } else {
    candidates.push(join(homedir(), '.config', 'verstak', 'storage', 'browser-bridge-endpoint.json'))
  }
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue
      const j = JSON.parse(readFileSync(p, 'utf8'))
      if (j && typeof j.path === 'string' && j.path) return j.path
    } catch {
      // continue
    }
  }
  return null
}

function encodeFrame(json) {
  const body = Buffer.from(json, 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

function offlineError(requestId, message) {
  return JSON.stringify({
    v: BRIDGE_PROTOCOL_VERSION,
    type: 'error',
    requestId: requestId || 'none',
    code: 'desktop_offline',
    message: message || 'Verstak desktop offline — запустите Verstak',
  })
}

class FrameDecoder {
  constructor() {
    this.buf = Buffer.alloc(0)
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk])
    const out = []
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0)
      if (len > MAX_MESSAGE_BYTES) {
        out.push({ ok: false, code: 'oversize', message: `frame ${len}` })
        this.buf = Buffer.alloc(0)
        break
      }
      if (this.buf.length < 4 + len) break
      const body = this.buf.subarray(4, 4 + len)
      this.buf = this.buf.subarray(4 + len)
      out.push({ ok: true, json: body.toString('utf8') })
    }
    return out
  }
}

function writeStdout(json) {
  try {
    process.stdout.write(encodeFrame(json))
  } catch {
    // ignore
  }
}

function main() {
  const endpoint = findEndpoint()
  const stdinDecoder = new FrameDecoder()

  if (!endpoint) {
    // Still consume stdin; answer offline for every message.
    process.stdin.on('data', (chunk) => {
      for (const f of stdinDecoder.push(chunk)) {
        if (!f.ok) {
          writeStdout(offlineError(undefined, f.message))
          continue
        }
        let requestId = 'none'
        try {
          const m = JSON.parse(f.json)
          if (m && m.requestId) requestId = String(m.requestId)
        } catch { /* ignore */ }
        writeStdout(offlineError(requestId, 'Verstak desktop offline (нет endpoint)'))
      }
    })
    process.stdin.on('end', () => process.exit(0))
    return
  }

  const socket = createConnection(endpoint)
  const sockDecoder = new FrameDecoder()
  let ready = false
  const pending = []

  socket.on('connect', () => {
    ready = true
    for (const p of pending) socket.write(p)
    pending.length = 0
  })

  socket.on('data', (chunk) => {
    for (const f of sockDecoder.push(chunk)) {
      if (!f.ok) {
        writeStdout(offlineError(undefined, f.message))
        continue
      }
      writeStdout(f.json)
    }
  })

  socket.on('error', () => {
    ready = false
  })

  socket.on('close', () => {
    ready = false
    // Keep host alive until Chrome closes stdin — report offline on next msg.
  })

  process.stdin.on('data', (chunk) => {
    for (const f of stdinDecoder.push(chunk)) {
      if (!f.ok) {
        writeStdout(JSON.stringify({
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'error',
          requestId: 'none',
          code: f.code,
          message: f.message,
        }))
        continue
      }
      if (!ready || !socket.writable) {
        let requestId = 'none'
        try {
          const m = JSON.parse(f.json)
          if (m && m.requestId) requestId = String(m.requestId)
        } catch { /* ignore */ }
        writeStdout(offlineError(requestId, 'Verstak desktop offline (pipe closed)'))
        continue
      }
      const frame = encodeFrame(f.json)
      if (ready) socket.write(frame)
      else pending.push(frame)
    }
  })

  process.stdin.on('end', () => {
    try { socket.destroy() } catch { /* ignore */ }
    process.exit(0)
  })
}

// Host must not process any command-line arbitrary code — only relay.
void NATIVE_HOST_NAME
main()
