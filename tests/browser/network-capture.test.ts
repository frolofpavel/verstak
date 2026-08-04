import { describe, it, expect, beforeEach } from 'vitest'
import {
  trackWebview, untrackWebview, isTrackedWebview, resetTab,
  noteStart, noteFinish, readCapture, __resetCaptureForTests, MAX_PER_TAB,
} from '../../electron/browser/network-capture'

describe('browser network-capture — чистый стор', () => {
  beforeEach(() => { __resetCaptureForTests() })

  it('пишет запись ТОЛЬКО для отслеживаемой webview (главное окно/провайдеры — мимо)', () => {
    trackWebview(10)
    noteFinish({ wcid: 10, requestId: 1, ts: 100, method: 'get', url: 'https://x/a', status: 200 })
    noteFinish({ wcid: 99, requestId: 2, ts: 100, method: 'GET', url: 'https://y/b', status: 200 }) // не трекается
    const recs = readCapture(10)
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ method: 'GET', url: 'https://x/a', status: 200 })
    expect(isTrackedWebview(99)).toBe(false)
    expect(readCapture(99)).toHaveLength(0)
  })

  it('длительность = finish.ts − start.ts, если старт известен; иначе null', () => {
    trackWebview(1)
    noteStart(1, 5, 1000)
    noteFinish({ wcid: 1, requestId: 5, ts: 1350, method: 'GET', url: 'https://x/a', status: 200 })
    noteFinish({ wcid: 1, requestId: 6, ts: 2000, method: 'GET', url: 'https://x/b', status: 204 }) // без старта
    const recs = readCapture(1)
    expect(recs[0].durationMs).toBe(350)
    expect(recs[1].durationMs).toBeNull()
  })

  it('ошибка запроса (onErrorOccurred → status 0) тоже пишется', () => {
    trackWebview(1)
    noteFinish({ wcid: 1, requestId: 7, ts: 10, method: 'GET', url: 'https://x/fail', status: 0 })
    expect(readCapture(1)[0].status).toBe(0)
  })

  it('кольцевой буфер: не больше MAX_PER_TAB, старые вытесняются', () => {
    trackWebview(1)
    for (let i = 0; i < MAX_PER_TAB + 25; i++) {
      noteFinish({ wcid: 1, requestId: i, ts: i, method: 'GET', url: `https://x/${i}`, status: 200 })
    }
    const recs = readCapture(1)
    expect(recs).toHaveLength(MAX_PER_TAB)
    expect(recs[recs.length - 1].url).toBe(`https://x/${MAX_PER_TAB + 24}`) // самый свежий на конце
    expect(recs[0].url).toBe(`https://x/25`)                                 // первые 25 вытеснены
  })

  it('resetTab чистит буфер вкладки (новая страница — своя сеть)', () => {
    trackWebview(1)
    noteFinish({ wcid: 1, requestId: 1, ts: 1, method: 'GET', url: 'https://x/a', status: 200 })
    resetTab(1)
    expect(readCapture(1)).toHaveLength(0)
  })

  it('readCapture() без аргумента → буфер последней активной webview', () => {
    trackWebview(1)
    trackWebview(2)
    noteFinish({ wcid: 1, requestId: 1, ts: 1, method: 'GET', url: 'https://x/a', status: 200 })
    noteFinish({ wcid: 2, requestId: 2, ts: 2, method: 'GET', url: 'https://y/b', status: 200 })
    // Последняя запись была во вкладке 2 → она активна.
    expect(readCapture()).toHaveLength(1)
    expect(readCapture()[0].url).toBe('https://y/b')
  })

  it('untrackWebview забывает вкладку и её буфер (webview уничтожен)', () => {
    trackWebview(1)
    noteFinish({ wcid: 1, requestId: 1, ts: 1, method: 'GET', url: 'https://x/a', status: 200 })
    untrackWebview(1)
    expect(isTrackedWebview(1)).toBe(false)
    expect(readCapture(1)).toHaveLength(0)
    // После untrack запись мимо (не воскрешает буфер).
    noteFinish({ wcid: 1, requestId: 2, ts: 2, method: 'GET', url: 'https://x/b', status: 200 })
    expect(readCapture(1)).toHaveLength(0)
  })

  it('заголовки старта переносятся в запись (для редакции auth в main)', () => {
    trackWebview(1)
    noteStart(1, 5, 1000, { authorization: 'Bearer secret', 'content-type': 'application/json' })
    noteFinish({ wcid: 1, requestId: 5, ts: 1100, method: 'POST', url: 'https://x/a', status: 201 })
    expect(readCapture(1)[0].headers).toEqual({ authorization: 'Bearer secret', 'content-type': 'application/json' })
  })
})
