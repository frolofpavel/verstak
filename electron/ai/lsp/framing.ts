// LSP-тул (Фаза 1): кодек JSON-RPC поверх stdio языкового сервера.
//
// Протокол LSP оборачивает каждое сообщение заголовком `Content-Length: N\r\n\r\n`
// + телом JSON. КРИТИЧНО: N — длина тела в БАЙТАХ (UTF-8), не в символах. Тело с
// кириллицей/эмодзи даёт байт-длину > символьной — частая ошибка реализаций.
//
// Поток stdout сервера приходит произвольными чанками: один чанк может содержать
// несколько сообщений, или одно сообщение может быть разорвано между чанками
// (даже посреди заголовка или тела). Декодер аккумулирует буфер и выдаёт только
// ПОЛНЫЕ сообщения.

/** Закодировать сообщение в кадр LSP (заголовок + тело). Длина — в байтах UTF-8. */
export function encodeMessage(msg: unknown): Buffer {
  const json = JSON.stringify(msg)
  const body = Buffer.from(json, 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([header, body])
}

const HEADER_SEP = Buffer.from('\r\n\r\n', 'ascii')

/**
 * Потоковый декодер кадров LSP. push(chunk) докладывает данные и возвращает массив
 * полностью собранных сообщений (распарсенный JSON). Неполный «хвост» остаётся в
 * буфере до следующего push. Битый заголовок/тело — пропускается с восстановлением,
 * чтобы один сбой не вешал весь поток.
 */
export class LspDecoder {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Buffer | string): unknown[] {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    this.buf = this.buf.length === 0 ? incoming : Buffer.concat([this.buf, incoming])
    const out: unknown[] = []
    for (;;) {
      const headerEnd = this.buf.indexOf(HEADER_SEP)
      if (headerEnd === -1) break // заголовок ещё не пришёл целиком
      const header = this.buf.subarray(0, headerEnd).toString('ascii')
      const m = /Content-Length:\s*(\d+)/i.exec(header)
      if (!m) {
        // Заголовка без Content-Length быть не должно — пропускаем до конца этого
        // заголовка и пробуем ресинхронизироваться.
        this.buf = this.buf.subarray(headerEnd + HEADER_SEP.length)
        continue
      }
      const len = parseInt(m[1], 10)
      const bodyStart = headerEnd + HEADER_SEP.length
      if (this.buf.length < bodyStart + len) break // тело пришло не полностью — ждём
      const body = this.buf.subarray(bodyStart, bodyStart + len).toString('utf8')
      this.buf = this.buf.subarray(bodyStart + len)
      try {
        out.push(JSON.parse(body))
      } catch {
        // Битое тело — уже «съели» из буфера, просто не отдаём наверх.
      }
    }
    return out
  }

  /** Сколько байт ждёт в буфере (для диагностики/тестов). */
  get pending(): number {
    return this.buf.length
  }
}
