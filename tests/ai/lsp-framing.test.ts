import { describe, it, expect } from 'vitest'
import { encodeMessage, LspDecoder } from '../../electron/ai/lsp/framing'

/**
 * Кодек JSON-RPC кадров LSP. Главные ловушки: Content-Length в БАЙТАХ (не символах),
 * сообщения разорванные/склеенные в потоке stdout. Без правильного framing'а клиент
 * LSP молча зависает или рассыпается на кириллице.
 */
describe('LSP framing', () => {
  it('encode: Content-Length = длина тела в БАЙТАХ (кириллица > символов)', () => {
    const frame = encodeMessage({ method: 'привет' }).toString('utf8')
    const body = JSON.stringify({ method: 'привет' })
    const byteLen = Buffer.byteLength(body, 'utf8')
    expect(byteLen).toBeGreaterThan(body.length)        // кириллица: байт > символов
    expect(frame).toBe(`Content-Length: ${byteLen}\r\n\r\n${body}`)
  })

  it('decode: одно сообщение целиком', () => {
    const dec = new LspDecoder()
    const msgs = dec.push(encodeMessage({ id: 1, result: 'ok' }))
    expect(msgs).toEqual([{ id: 1, result: 'ok' }])
    expect(dec.pending).toBe(0)
  })

  it('decode: несколько сообщений в одном чанке', () => {
    const dec = new LspDecoder()
    const chunk = Buffer.concat([
      encodeMessage({ id: 1 }),
      encodeMessage({ id: 2 }),
      encodeMessage({ id: 3 })
    ])
    expect(dec.push(chunk)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })

  it('decode: сообщение разорвано между чанками (заголовок и тело по частям)', () => {
    const dec = new LspDecoder()
    const full = encodeMessage({ id: 7, method: 'тест' })
    // рвём посреди заголовка
    expect(dec.push(full.subarray(0, 8))).toEqual([])
    expect(dec.pending).toBeGreaterThan(0)
    // рвём посреди тела
    const mid = full.length - 3
    expect(dec.push(full.subarray(8, mid))).toEqual([])
    // хвост — сообщение собирается
    expect(dec.push(full.subarray(mid))).toEqual([{ id: 7, method: 'тест' }])
    expect(dec.pending).toBe(0)
  })

  it('decode: байт-точность с многобайтовым телом (Content-Length по байтам)', () => {
    const dec = new LspDecoder()
    const msg = { text: 'функция 函数 🚀' }
    const out = dec.push(encodeMessage(msg))
    expect(out).toEqual([msg])
    expect(dec.pending).toBe(0)
  })

  it('decode: хвост следующего сообщения остаётся в буфере', () => {
    const dec = new LspDecoder()
    const two = Buffer.concat([encodeMessage({ id: 1 }), encodeMessage({ id: 2 })])
    // отдаём первое целиком + кусок второго
    const cut = encodeMessage({ id: 1 }).length + 5
    expect(dec.push(two.subarray(0, cut))).toEqual([{ id: 1 }])
    expect(dec.pending).toBeGreaterThan(0)              // хвост второго ждёт
    expect(dec.push(two.subarray(cut))).toEqual([{ id: 2 }])
  })

  it('decode: битое тело JSON пропускается, поток не виснет', () => {
    const dec = new LspDecoder()
    const bad = Buffer.from('Content-Length: 5\r\n\r\n{bad}', 'utf8')
    expect(dec.push(bad)).toEqual([])                   // битое — не отдаём
    // следующее валидное проходит
    expect(dec.push(encodeMessage({ id: 9 }))).toEqual([{ id: 9 }])
  })
})
