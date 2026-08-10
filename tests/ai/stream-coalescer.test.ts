// V2 ось B (волна 2.6.0): склейка текстовых чанков стрима.
//
// ДЕФЕКТ. Каждая дельта провайдера уходила отдельным IPC-событием, renderer
// перерисовывал сообщение на каждую. Средний ответ — сотни событий, длинный —
// тысячи; глазу это рывки.
//
// ЧТО ЗАКРЕПЛЕНО, и почему пары обязательны. (1) Склейка снижает число отправок,
// НО (2) первый чанк уходит немедленно — иначе ось B воевала бы с осью A
// («время до первого символа» — главная метрика волны). (3) Ни один символ не
// теряется и порядок не меняется. (4) flush перед не-текстовым событием
// обязателен — иначе ответ приедет ПОСЛЕ инструмента.
import { describe, it, expect, vi } from 'vitest'
import { createTextCoalescer } from '../../electron/ai/stream-coalescer'

/** Детерминированный планировщик: время двигаем руками, не ждём реальное. */
function manualClock() {
  const pending: Array<{ fn: () => void; at: number }> = []
  let now = 0
  return {
    schedule: (fn: () => void, ms: number) => {
      const entry = { fn, at: now + ms }
      pending.push(entry)
      return { cancel: () => { const i = pending.indexOf(entry); if (i >= 0) pending.splice(i, 1) } }
    },
    advance: (ms: number) => {
      now += ms
      for (const e of pending.filter(p => p.at <= now)) {
        pending.splice(pending.indexOf(e), 1)
        e.fn()
      }
    },
  }
}

describe('V2 ось B: склейка текстовых чанков', () => {
  it('первый чанк уходит НЕМЕДЛЕННО (ось B не крадёт время у оси A)', () => {
    const clock = manualClock()
    const sent: string[] = []
    const c = createTextCoalescer(t => sent.push(t), { windowMs: 30, schedule: clock.schedule })

    c.push('При')

    expect(sent, 'первый символ задержан — время до первого символа выросло').toEqual(['При'])
  })

  it('чанки внутри окна склеиваются в ОДНУ отправку', () => {
    const clock = manualClock()
    const sent: string[] = []
    const c = createTextCoalescer(t => sent.push(t), { windowMs: 30, schedule: clock.schedule })

    c.push('a')            // немедленно
    c.push('b'); c.push('c'); c.push('d')   // копятся
    expect(sent).toEqual(['a'])

    clock.advance(30)

    expect(sent).toEqual(['a', 'bcd'])
    expect(c.emits(), '10 чанков дали 10 отправок — склейки нет').toBe(2)
  })

  it('НИ ОДИН символ не теряется и порядок сохраняется', () => {
    const clock = manualClock()
    const sent: string[] = []
    const c = createTextCoalescer(t => sent.push(t), { windowMs: 30, schedule: clock.schedule })

    const chunks = ['Пр', 'и', 'вет', ', ', 'мир', '!']
    for (const ch of chunks) c.push(ch)
    clock.advance(30)
    c.flush()

    expect(sent.join('')).toBe(chunks.join(''))
  })

  it('flush отдаёт накопленное СРАЗУ — не-текстовое событие не обгонит текст', () => {
    const clock = manualClock()
    const sent: string[] = []
    const c = createTextCoalescer(t => sent.push(t), { windowMs: 30, schedule: clock.schedule })

    c.push('ответ ')
    c.push('дописан')
    c.flush()

    expect(sent).toEqual(['ответ ', 'дописан'])
  })

  it('КОНТРОЛЬ: 200 чанков дают заметно меньше 200 отправок', () => {
    const clock = manualClock()
    let emits = 0
    const c = createTextCoalescer(() => { emits++ }, { windowMs: 30, schedule: clock.schedule })

    for (let i = 0; i < 200; i++) {
      c.push('x')
      if (i % 20 === 19) clock.advance(30)   // раз в 20 чанков окно закрывается
    }
    c.flush()

    expect(emits, 'склейка не сработала — отправок столько же, сколько чанков').toBeLessThan(30)
    expect(emits, 'вообще ничего не отправлено — текст потерян').toBeGreaterThan(0)
  })

  it('dispose снимает таймер и накопленное НЕ отправляет (abort)', () => {
    const clock = manualClock()
    const sent: string[] = []
    const c = createTextCoalescer(t => sent.push(t), { windowMs: 30, schedule: clock.schedule })

    c.push('первый')
    c.push('в буфере')
    c.dispose()
    clock.advance(100)

    expect(sent, 'после dispose буфер всё-таки уехал').toEqual(['первый'])
  })

  it('пустая строка отправку не порождает', () => {
    const sent: string[] = []
    const c = createTextCoalescer(t => sent.push(t), { windowMs: 30, schedule: manualClock().schedule })
    c.push('')
    c.flush()
    expect(sent).toEqual([])
  })
})

describe('V2 ось B: порядок событий в проде (обёртка sender)', () => {
  // Воспроизводим ровно то, что делает runApiConversation: перехват на sender.
  function wrap(raw: { send: (ch: string, p: { id: number; event: unknown }) => void }, sendId: number) {
    const textStream = createTextCoalescer(text => raw.send('ai:event', { id: sendId, event: { type: 'text', text } }))
    return {
      send: (channel: string, payload: { id: number; event: unknown }) => {
        if (channel === 'ai:event' && payload.id === sendId) {
          const ev = payload.event as { type?: string; text?: string }
          if (ev?.type === 'text' && typeof ev.text === 'string') { textStream.push(ev.text); return }
          textStream.flush()
        }
        raw.send(channel, payload)
      },
    }
  }

  it('текст, накопленный до tool-call, уходит РАНЬШЕ него', () => {
    const log: string[] = []
    const raw = { send: (_ch: string, p: { id: number; event: unknown }) => { const e = p.event as { type: string; text?: string }; log.push(e.type === 'text' ? `text:${e.text}` : e.type) } }
    const s = wrap(raw, 1)

    s.send('ai:event', { id: 1, event: { type: 'text', text: 'сейчас ' } })
    s.send('ai:event', { id: 1, event: { type: 'text', text: 'посмотрю' } })
    s.send('ai:event', { id: 1, event: { type: 'tool-call' } })
    s.send('ai:event', { id: 1, event: { type: 'done' } })

    expect(log).toEqual(['text:сейчас ', 'text:посмотрю', 'tool-call', 'done'])
  })

  it('чужой sendId через обёртку проходит как есть (склейка не путает прогоны)', () => {
    const log: string[] = []
    const raw = { send: (_ch: string, p: { id: number; event: unknown }) => { log.push(`${p.id}:${(p.event as { type: string }).type}`) } }
    const s = wrap(raw, 1)

    s.send('ai:event', { id: 2, event: { type: 'text', text: 'чужой' } })

    expect(log).toEqual(['2:text'])
  })
})
