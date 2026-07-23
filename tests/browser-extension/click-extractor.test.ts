// @vitest-environment jsdom
// click-extractor.test.ts — controls map + performClickByRef (EXT-C1).

import { describe, it, expect } from 'vitest'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXT_DIR = resolve(HERE, '..', '..', 'browser-extension')
const EXTRACTOR_URL = pathToFileURL(join(EXT_DIR, 'extractor.mjs')).href

const { capturePageSnapshot, performClickByRef } = await import(EXTRACTOR_URL) as {
  capturePageSnapshot: (opts?: Record<string, unknown>) => {
    text: string
    controls: Array<{ elementRef: string; role: string; label: string; observationVersion: number }>
    observationVersion: number
  }
  performClickByRef: (
    elementRef: string,
    observationVersion: number | string,
  ) => { ok: boolean; finalUrl?: string; error?: string }
}

function setBody(html: string) {
  document.documentElement.innerHTML = ''
  const body = document.createElement('body')
  document.documentElement.appendChild(body)
  body.innerHTML = html
}

describe('extractor controls + click (C1)', () => {
  it('capture includes button control with stable elementRef', () => {
    setBody(`
      <div id="counter">Счётчик: 0</div>
      <button type="button" id="inc">Увеличить</button>
    `)
    const snap = capturePageSnapshot({})
    expect(snap.controls?.length).toBeGreaterThan(0)
    const btn = snap.controls.find((c) => c.label.includes('Увеличить'))
    expect(btn).toBeTruthy()
    expect(btn!.elementRef).toMatch(/^button:/)
    expect(snap.observationVersion).toBeTruthy()
    expect(document.documentElement.getAttribute('data-verstak-obs')).toBe(
      String(snap.observationVersion),
    )
  })

  it('performClickByRef increments counter once', () => {
    setBody(`
      <div id="counter">Счётчик: 0</div>
      <button type="button" id="inc">Увеличить</button>
    `)
    let n = 0
    document.getElementById('inc')!.addEventListener('click', () => {
      n += 1
      document.getElementById('counter')!.textContent = `Счётчик: ${n}`
    })
    const snap = capturePageSnapshot({})
    const btn = snap.controls.find((c) => c.label.includes('Увеличить'))
    expect(btn).toBeTruthy()
    const r = performClickByRef(btn!.elementRef, snap.observationVersion)
    expect(r.ok).toBe(true)
    expect(document.getElementById('counter')!.textContent).toBe('Счётчик: 1')
  })

  it('stale observationVersion → no click', () => {
    setBody(`
      <div id="counter">Счётчик: 0</div>
      <button type="button" id="inc">Увеличить</button>
    `)
    let n = 0
    document.getElementById('inc')!.addEventListener('click', () => {
      n += 1
      document.getElementById('counter')!.textContent = `Счётчик: ${n}`
    })
    const snap = capturePageSnapshot({})
    const btn = snap.controls.find((c) => c.label.includes('Увеличить'))
    const r = performClickByRef(btn!.elementRef, 1)
    expect(r.ok).toBe(false)
    expect(String(r.error)).toMatch(/stale/)
    expect(document.getElementById('counter')!.textContent).toBe('Счётчик: 0')
  })

  it('raw CSS-looking ref → reject', () => {
    setBody(`<button type="button">X</button>`)
    capturePageSnapshot({})
    const r = performClickByRef('document.querySelector("button")', 1)
    expect(r.ok).toBe(false)
    expect(String(r.error)).toMatch(/CSS|JS|forbidden/i)
  })
})
