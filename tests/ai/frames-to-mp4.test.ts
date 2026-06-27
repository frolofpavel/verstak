import { describe, it, expect } from 'vitest'
import { deflateSync } from 'zlib'
import { existsSync, statSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveFfmpeg, encodeFramesToMp4 } from '../../electron/ai/frames-to-mp4'

// Tier-2 #5 — MP4-энкодер кадров. Реальный ffmpeg за RUN_FFMPEG_IT=1 (спавн внешнего
// процесса). Базовые ветки (нет кадров) — всегда.

function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return (~c) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}
function makePng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8-bit, color type 2 (RGB)
  const row = Buffer.concat([Buffer.from([0]), ...Array(w).fill(Buffer.from(rgb))])
  const raw = Buffer.concat(Array(h).fill(row))
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const ffmpegAvailable = process.env.RUN_FFMPEG_IT === '1' && !!resolveFfmpeg()

describe('encodeFramesToMp4', () => {
  it('нет кадров → { ok:false }', async () => {
    expect((await encodeFramesToMp4([], join(tmpdir(), 'x.mp4'))).ok).toBe(false)
  })

  it.skipIf(!ffmpegAvailable)('3 PNG-кадра → MP4 создан (real ffmpeg)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp4-it-'))
    const out = join(dir, 'proof.mp4')
    const frames = [makePng(8, 8, [255, 0, 0]), makePng(8, 8, [0, 255, 0]), makePng(8, 8, [0, 0, 255])]
    try {
      const r = await encodeFramesToMp4(frames, out, { fps: 2 })
      expect(r.error ?? '').toBe('')
      expect(r.ok).toBe(true)
      expect(existsSync(out)).toBe(true)
      expect(statSync(out).size).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)
})
