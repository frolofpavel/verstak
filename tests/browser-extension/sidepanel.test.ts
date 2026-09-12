// @vitest-environment jsdom
//
// sidepanel.test.ts — гейт activeTab error flow VSK-EXT-A1-R1 (сценарий 16).
//
// Подход: sidepanel.mjs при импорте читает DOM (document.getElementById) и
// регистрирует обработчики. Подсовываем реальный HTML sidepanel.html в jsdom,
// мокаем chrome.tabs.query / chrome.scripting.executeScript / navigator.clipboard,
// затем эмулируем клик и смотрим, что попало в #vsk-status.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXT_DIR = resolve(HERE, '..', '..', 'browser-extension')
const SIDEPANEL_HTML = readFileSync(join(EXT_DIR, 'sidepanel.html'), 'utf8')
const SIDEPANEL_URL = pathToFileURL(join(EXT_DIR, 'sidepanel.mjs')).href

interface ChromeMock {
  tabs: {
    query: ReturnType<typeof vi.fn>
  }
  scripting: {
    executeScript: ReturnType<typeof vi.fn>
  }
  sidePanel: {
    setPanelBehavior: ReturnType<typeof vi.fn>
  }
  runtime: {
    lastError: { message: string } | null
    sendMessage?: ReturnType<typeof vi.fn>
    onMessage?: { addListener: ReturnType<typeof vi.fn> }
  }
}

function buildChromeMock(overrides: Partial<ChromeMock> = {}): ChromeMock {
  return {
    tabs: { query: vi.fn(async () => []) },
    scripting: { executeScript: vi.fn(async () => []) },
    sidePanel: { setPanelBehavior: vi.fn(async () => {}) },
    runtime: { lastError: null },
    ...overrides,
  }
}

function setStatusTo(status: HTMLElement) {
  return status.textContent || ''
}

async function loadSidepanel(chromeMock: ChromeMock) {
  // Полный HTML sidepanel + script-тег удаляем (jsdom не выполнит module script
  // через import из файла — загружаем сами как ESM после установки chrome-глобала).
  document.documentElement.innerHTML = SIDEPANEL_HTML.replace(
    /<script\b[^>]*><\/script>/g,
    ''
  )
  // window.chrome должен стоять ДО импорта sidepanel.mjs (он читает его при init).
  ;(window as unknown as { chrome: ChromeMock }).chrome = chromeMock
  // navigator.clipboard используется в copyText — не нужно для onCapture.
  await import(SIDEPANEL_URL)
}

async function clickCapture() {
  const btn = document.getElementById('vsk-capture') as HTMLButtonElement
  expect(btn, 'кнопка #vsk-capture должна присутствовать в DOM').toBeTruthy()
  btn.dispatchEvent(new window.Event('click'))
  // Подождать микротаски (onCapture асинхронный).
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe('sidepanel activeTab error flow — VSK-EXT-A1-R1 (сценарий 16)', () => {
  beforeEach(() => {
    // Полный сброс DOM перед каждым тестом.
    document.documentElement.innerHTML = '<head></head><body></body>'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    // Сбрасываем window.chrome чтобы не протекло между тестами.
    delete (window as unknown as { chrome?: ChromeMock }).chrome
    vi.resetModules()
  })

  it('16a. нет активной вкладки → понятное сообщение (НЕ системная схема)', async () => {
    const chromeMock = buildChromeMock({
      tabs: { query: vi.fn(async () => []) },
    })
    await loadSidepanel(chromeMock)
    await clickCapture()
    const status = setStatusTo(document.getElementById('vsk-status')!)
    expect(status).toMatch(/нет активной|нет вкладки|no active|вкладка/i)
    // НЕ должно быть ложного сообщения о системной схеме.
    expect(status).not.toMatch(/системн/i)
  })

  it('16b. tab без id → понятная ошибка', async () => {
    const chromeMock = buildChromeMock({
      tabs: { query: vi.fn(async () => [{ id: undefined, url: 'https://example.com' }]) },
    })
    await loadSidepanel(chromeMock)
    await clickCapture()
    const status = setStatusTo(document.getElementById('vsk-status')!)
    expect(status.length).toBeGreaterThan(0)
    // Не должно показывать пользователю raw URL.
    expect(status).not.toContain('https://example.com')
  })

  it('16c. tab.url отсутствует (пустой) → НЕ считается системной схемой, пытается executeScript', async () => {
    // Когда activeTab ещё не предоставлен, Chrome может вернуть tab.url = ''.
    // executeScript должен быть вызван (а не сразу отбита как «системная схема»).
    const chromeMock = buildChromeMock({
      tabs: { query: vi.fn(async () => [{ id: 42, url: '' }]) },
      scripting: {
        executeScript: vi.fn(async () => {
          throw new Error('Cannot access contents of the page')
        }),
      },
    })
    await loadSidepanel(chromeMock)
    await clickCapture()
    // executeScript должен был быть вызван.
    expect(chromeMock.scripting.executeScript).toHaveBeenCalled()
    const status = setStatusTo(document.getElementById('vsk-status')!)
    // НЕ системная схема — это была ошибка executeScript.
    expect(status).not.toMatch(/системн/i)
  })

  it('16d. tab.url с системной схемой → сообщение о системной странице (без raw URL)', async () => {
    const chromeMock = buildChromeMock({
      tabs: { query: vi.fn(async () => [{ id: 42, url: 'chrome://settings/' }]) },
    })
    await loadSidepanel(chromeMock)
    await clickCapture()
    const status = setStatusTo(document.getElementById('vsk-status')!)
    expect(status).toMatch(/системн|нельзя читать|chrome:|недоступн/i)
    // Не светим raw URL — там может быть чувствительный путь настроек.
    expect(status).not.toContain('chrome://settings/')
  })

  it('16e. отказ executeScript из-за отсутствия activeTab → короткое понятное сообщение', async () => {
    const chromeMock = buildChromeMock({
      tabs: { query: vi.fn(async () => [{ id: 42, url: 'https://example.com' }]) },
      scripting: {
        executeScript: vi.fn(async () => {
          throw new Error('Cannot access contents of the page. Extension manifest must request permission')
        }),
      },
    })
    await loadSidepanel(chromeMock)
    await clickCapture()
    const status = setStatusTo(document.getElementById('vsk-status')!)
    expect(status).toMatch(/activeTab|доступ|иконку|нажмите|разрешени/i)
    // НЕ показываем raw exception message целиком.
    expect(status).not.toContain('Cannot access contents of the page. Extension manifest must request permission')
  })

  it('16f. executeScript вернул пустой массив → понятное сообщение', async () => {
    const chromeMock = buildChromeMock({
      tabs: { query: vi.fn(async () => [{ id: 42, url: 'https://example.com' }]) },
      scripting: { executeScript: vi.fn(async () => []) },
    })
    await loadSidepanel(chromeMock)
    await clickCapture()
    const status = setStatusTo(document.getElementById('vsk-status')!)
    expect(status.length).toBeGreaterThan(0)
    // Не должно быть raw exception или «undefined».
    expect(status).not.toMatch(/^Ошибка:/)
  })

  it('16g. успешный capture — кнопки копирования активируются', async () => {
    const fakeSnapshot = {
      schemaVersion: 1,
      capturedAt: '2026-07-19T12:00:00.000Z',
      source: { kind: 'chrome-active-tab', url: 'https://example.com/x', title: 'Ok' },
      selection: '', text: 'CAPTURE_OK_TEXT', tables: [], omissions: [],
      truncated: { text: false, selection: false, tables: false },
    }
    const chromeMock = buildChromeMock({
      tabs: { query: vi.fn(async () => [{ id: 42, url: 'https://example.com' }]) },
      scripting: { executeScript: vi.fn(async () => [{ result: fakeSnapshot }]) },
    })
    await loadSidepanel(chromeMock)
    await clickCapture()
    const copyV = document.getElementById('vsk-copy-verstak') as HTMLButtonElement
    const copyJ = document.getElementById('vsk-copy-json') as HTMLButtonElement
    expect(copyV.disabled).toBe(false)
    expect(copyJ.disabled).toBe(false)
    const output = (document.getElementById('vsk-output') as HTMLTextAreaElement).value
    expect(output).toContain('CAPTURE_OK_TEXT')
  })

  it('product prompt goes to Verstak and renders only returned task events', async () => {
    const taskListeners: Array<(message: unknown) => void> = []
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'bridge.submitTask') {
        return { ok: true, task: { sendId: 77, browserTaskId: 'bt-1', chatId: 1 } }
      }
      return { ok: false, state: { ui: 'offline' } }
    })
    const chromeMock = buildChromeMock({
      runtime: {
        lastError: null,
        sendMessage,
        onMessage: { addListener: vi.fn((fn) => { taskListeners.push(fn) }) },
      },
    })
    await loadSidepanel(chromeMock)
    const input = document.getElementById('vsk-prompt-input') as HTMLTextAreaElement
    input.value = 'Нажми кнопку'
    ;(document.getElementById('vsk-form') as HTMLFormElement)
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sendMessage).toHaveBeenCalledWith({ type: 'bridge.submitTask', prompt: 'Нажми кнопку' })
    expect(document.body.textContent).not.toContain('Счётчик: 1')

    taskListeners[0]?.({ type: 'bridge.taskEvent', payload: { sendId: 77, event: { type: 'text', text: 'Реальный ответ' } } })
    expect(document.body.textContent).toContain('Реальный ответ')
  })
})
