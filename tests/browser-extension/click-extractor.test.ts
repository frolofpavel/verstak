// @vitest-environment jsdom
// click-extractor.test.ts — controls map + performClickByRef (EXT-C1).

import { describe, it, expect } from 'vitest'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { wrapObservationForModel } from '../../electron/ai/browser/untrusted'

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
    expect(btn!.elementRef).toMatch(/^el-[a-f0-9]{16}$/)
    expect(snap.observationVersion).toBeTruthy()
    expect(document.documentElement.getAttribute('data-verstak-obs')).toBe(
      String(snap.observationVersion),
    )
  })

  it('elementRef opaque: секрет из label не попадает в ref и model envelope', () => {
    const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'
    setBody(`<button type="button" aria-label="${secret}">Открыть</button>`)

    const snap = capturePageSnapshot({})
    const control = snap.controls[0]
    expect(control).toBeTruthy()
    expect(control.elementRef).toMatch(/^el-[a-f0-9]{16}$/)
    expect(control.elementRef).not.toContain('sk-proj-')
    expect(control.elementRef).not.toContain(secret.slice(0, 40))

    const wrapped = wrapObservationForModel({
      observationId: 'obs-opaque-ref',
      observationVersion: snap.observationVersion,
      browserTaskId: 'bt-opaque-ref',
      runId: 'run-opaque-ref',
      capturedAt: Date.now(),
      source: {
        kind: 'chrome-extension',
        tabRef: 'tab-1',
        documentId: null,
        url: 'https://example.com/',
        title: 'Example',
        origin: 'example.com',
      },
      text: '',
      tables: [],
      controls: [control],
      omissions: [],
      truncated: { text: false, selection: false, tables: false },
    })
    expect(wrapped.text).not.toContain(secret)
    expect(wrapped.text).not.toContain(secret.slice(0, 40))
  })

  it('fresh re-observe даёт тот же non-semantic ref после смены label и click находит элемент', () => {
    setBody('<button type="button" id="stable" aria-label="Стабильная кнопка">Нажать</button>')
    let clicks = 0
    const button = document.getElementById('stable')!
    button.addEventListener('click', () => { clicks += 1 })

    const first = capturePageSnapshot({})
    button.setAttribute('aria-label', 'Совсем другое имя')
    const second = capturePageSnapshot({})
    expect(first.controls[0].elementRef).toBe(second.controls[0].elementRef)

    const result = performClickByRef(second.controls[0].elementRef, second.observationVersion)
    expect(result.ok).toBe(true)
    expect(clicks).toBe(1)
  })

  it('editable input value не попадает в snapshot, opaque ref или model envelope', () => {
    const secret = 'sk-proj-editable-value-abcdefghijklmnopqrstuvwxyz'
    const unlabeledSecret = 'current-form-value-must-stay-private'
    setBody(`
      <label for="account-email">Рабочая почта</label>
      <input id="account-email" type="email" role="button"
             placeholder="name@example.com" value="${secret}">
      <input id="search" type="text" role="button" value="${unlabeledSecret}">
    `)

    const snap = capturePageSnapshot({})
    const control = snap.controls.find((candidate) => candidate.label === 'Рабочая почта')!
    expect(control).toBeTruthy()
    expect(control.label).toBe('Рабочая почта')
    expect(snap.controls.some((candidate) => candidate.label === 'button')).toBe(true)
    expect(JSON.stringify(snap)).not.toContain(secret)
    expect(JSON.stringify(snap)).not.toContain(unlabeledSecret)
    expect(control.elementRef).not.toContain(secret)

    const wrapped = wrapObservationForModel({
      observationId: 'obs-editable-value',
      observationVersion: snap.observationVersion,
      browserTaskId: 'bt-editable-value',
      runId: 'run-editable-value',
      capturedAt: Date.now(),
      source: {
        kind: 'chrome-extension',
        tabRef: 'tab-1',
        documentId: null,
        url: 'https://example.com/',
        title: 'Example',
        origin: 'example.com',
      },
      text: '',
      tables: [],
      controls: [control],
      omissions: [],
      truncated: { text: false, selection: false, tables: false },
    })
    expect(wrapped.text).not.toContain(secret)
    expect(wrapped.text).not.toContain(unlabeledSecret)
  })

  it('submit button keeps its value as label and remains clickable', () => {
    setBody('<input id="submit" type="submit" value="Продолжить">')
    let clicks = 0
    document.getElementById('submit')!.addEventListener('click', () => { clicks += 1 })

    const snap = capturePageSnapshot({})
    const control = snap.controls.find((candidate) => candidate.label === 'Продолжить')
    expect(control).toBeTruthy()
    const result = performClickByRef(control!.elementRef, snap.observationVersion)
    expect(result.ok).toBe(true)
    expect(clicks).toBe(1)
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
