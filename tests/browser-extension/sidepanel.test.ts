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

  it('обычный интерфейс не показывает pair/attach/capture/JSON диагностику', () => {
    document.documentElement.innerHTML = SIDEPANEL_HTML
    expect(document.getElementById('vsk-pair-code')).toBeNull()
    expect(document.getElementById('vsk-attach')).toBeNull()
    expect(document.getElementById('vsk-capture')).toBeNull()
    expect(document.getElementById('vsk-copy-json')).toBeNull()
    expect(document.body.textContent).not.toMatch(/Pair|Attach|Capture|JSON/)
    expect(document.body.textContent).toMatch(/прочитать данные.*нажать кнопку/i)
    expect(document.body.textContent).not.toMatch(/заполнить форму/i)
  })

  it('при открытии подключает мост, а вкладку принимает только из toolbar action', async () => {
    const listeners: Array<(message: unknown) => void> = []
    const sendMessage = vi.fn(async () => ({
      ok: true,
      state: { ui: 'paired', attachedTab: null },
    }))
    const chromeMock = buildChromeMock({
      runtime: {
        lastError: null,
        sendMessage,
        onMessage: { addListener: vi.fn((fn) => { listeners.push(fn) }) },
      },
    })

    await loadSidepanel(chromeMock)
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'bridge.connect' }))
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'bridge.attach' }))
    expect(chromeMock.tabs.query).not.toHaveBeenCalled()
    expect(document.getElementById('vsk-status-pill')?.textContent).toMatch(/связь готова/i)
    expect((document.getElementById('vsk-prompt-input') as HTMLTextAreaElement).disabled).toBe(true)
    expect((document.getElementById('vsk-send-btn') as HTMLButtonElement).disabled).toBe(true)

    listeners[0]?.({
      type: 'bridge.stateChanged',
      state: {
        ui: 'attached',
        attachedTab: {
          tabRef: 'tab-42',
          url: 'https://my.calltouch.ru/accounts',
          title: 'Calltouch',
          origin: 'https://my.calltouch.ru',
        },
      },
    })
    expect(document.getElementById('vsk-status-pill')?.textContent).toMatch(/подключено/i)
    expect(document.getElementById('vsk-page-title')?.textContent).toBe('Calltouch')
    expect((document.getElementById('vsk-prompt-input') as HTMLTextAreaElement).disabled).toBe(false)
    expect((document.getElementById('vsk-send-btn') as HTMLButtonElement).disabled).toBe(false)
  })

  it('ошибка первого подключения ведёт в Settings без сырого Native Messaging текста', async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error('Specified native messaging host not found')
    })
    const chromeMock = buildChromeMock({
      runtime: {
        lastError: null,
        sendMessage,
        onMessage: { addListener: vi.fn() },
      },
    })

    await loadSidepanel(chromeMock)
    await vi.waitFor(() => expect(document.getElementById('vsk-status')?.textContent)
      .toMatch(/Настройки.*Интеграции.*Браузер/i))
    expect(document.body.textContent).not.toMatch(/native messaging host/i)
  })

  it('штатный first-pair reject тоже показывает единственный путь через Settings', async () => {
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'bridge.connect') {
        return {
          ok: false,
          error: 'bootstrap_missing',
          state: { ui: 'connecting', attachedTab: null },
        }
      }
      return { ok: true, state: { ui: 'connecting', attachedTab: null } }
    })
    const chromeMock = buildChromeMock({
      runtime: {
        lastError: null,
        sendMessage,
        onMessage: { addListener: vi.fn() },
      },
    })

    await loadSidepanel(chromeMock)
    await vi.waitFor(() => expect(document.getElementById('vsk-status')?.textContent)
      .toMatch(/Настройки.*Интеграции.*Браузер/i))
    expect(document.body.textContent).not.toContain('bootstrap_missing')
  })

  it('product prompt goes to Verstak and renders only returned task events', async () => {
    const taskListeners: Array<(message: unknown) => void> = []
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'bridge.submitTask') {
        return { ok: true, task: { sendId: 77, browserTaskId: 'bt-1', chatId: 1 } }
      }
      return {
        ok: true,
        state: {
          ui: 'attached',
          attachedTab: {
            tabRef: 'tab-42',
            url: 'https://my.calltouch.ru/accounts',
            title: 'Calltouch',
            origin: 'https://my.calltouch.ru',
          },
        },
      }
    })
    const chromeMock = buildChromeMock({
      tabs: { query: vi.fn(async () => [{ id: 42, url: 'https://my.calltouch.ru/accounts', title: 'Calltouch' }]) },
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
    expect(document.getElementById('vsk-stop-btn')?.classList.contains('vsk-hidden')).toBe(false)

    taskListeners[0]?.({ type: 'bridge.taskEvent', payload: { sendId: 77, event: { type: 'text', text: 'Реальный ответ' } } })
    expect(document.body.textContent).toContain('Реальный ответ')
    taskListeners[0]?.({ type: 'bridge.taskEvent', payload: { sendId: 77, event: { type: 'done' } } })
    expect(document.getElementById('vsk-stop-btn')?.classList.contains('vsk-hidden')).toBe(true)
  })

  it('ошибка отправки при выключенном Verstak остаётся понятной и без Native Messaging жаргона', async () => {
    const attached = {
      ui: 'attached',
      attachedTab: {
        tabRef: 'tab-42',
        url: 'https://my.calltouch.ru/accounts',
        title: 'Calltouch',
        origin: 'https://my.calltouch.ru',
      },
    }
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'bridge.submitTask') {
        return { ok: false, error: 'native port offline' }
      }
      return { ok: true, state: attached }
    })
    const chromeMock = buildChromeMock({
      runtime: {
        lastError: null,
        sendMessage,
        onMessage: { addListener: vi.fn() },
      },
    })

    await loadSidepanel(chromeMock)
    const input = document.getElementById('vsk-prompt-input') as HTMLTextAreaElement
    await vi.waitFor(() => expect(input.disabled).toBe(false))
    input.value = 'Прочитай страницу'
    ;(document.getElementById('vsk-form') as HTMLFormElement)
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(document.body.textContent).toMatch(/запустите приложение Verstak/i))
    expect(document.body.textContent).not.toMatch(/Native Messaging|native port|Host offline/i)
  })

  it('не скрывает approval при ошибке транспорта и позволяет повторить успешное решение', async () => {
    const taskListeners: Array<(message: unknown) => void> = []
    let approvalTransportOk = false
    const attached = {
      ui: 'attached',
      attachedTab: {
        tabRef: 'tab-42',
        url: 'https://my.calltouch.ru/accounts',
        title: 'Calltouch',
        origin: 'https://my.calltouch.ru',
      },
    }
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'bridge.resolveTaskApproval') {
        return approvalTransportOk
          ? { ok: true }
          : { ok: false, error: 'approval transport down' }
      }
      return { ok: true, state: attached }
    })
    const chromeMock = buildChromeMock({
      runtime: {
        lastError: null,
        sendMessage,
        onMessage: { addListener: vi.fn((fn) => { taskListeners.push(fn) }) },
      },
    })

    await loadSidepanel(chromeMock)
    taskListeners[0]?.({
      type: 'bridge.taskEvent',
      payload: {
        sendId: 77,
        event: {
          type: 'pending-browser-action',
          actionId: 'action-1',
          approvalDigest: 'digest-1',
          snapshot: { label: 'Нажать кнопку' },
        },
      },
    })
    const approvalArea = document.getElementById('vsk-approval-area')
    expect(approvalArea?.classList.contains('vsk-hidden')).toBe(false)

    ;(document.getElementById('vsk-approve-btn') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('approval transport down'))
    expect(approvalArea?.classList.contains('vsk-hidden')).toBe(false)

    approvalTransportOk = true
    ;(document.getElementById('vsk-approve-btn') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(approvalArea?.classList.contains('vsk-hidden')).toBe(true))
    expect(sendMessage.mock.calls.filter(([message]) => message.type === 'bridge.resolveTaskApproval')).toHaveLength(2)
  })

  it('rejected submit всегда убирает progress и снова разрешает ввод', async () => {
    const attached = {
      ui: 'attached',
      attachedTab: {
        tabRef: 'tab-42',
        url: 'https://my.calltouch.ru/accounts',
        title: 'Calltouch',
        origin: 'https://my.calltouch.ru',
      },
    }
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'bridge.submitTask') throw new Error('bridge rejected')
      return { ok: true, state: attached }
    })
    const chromeMock = buildChromeMock({
      runtime: {
        lastError: null,
        sendMessage,
        onMessage: { addListener: vi.fn() },
      },
    })

    await loadSidepanel(chromeMock)
    await vi.waitFor(() => expect((document.getElementById('vsk-prompt-input') as HTMLTextAreaElement).disabled).toBe(false))
    const input = document.getElementById('vsk-prompt-input') as HTMLTextAreaElement
    input.value = 'Прочитай страницу'
    ;(document.getElementById('vsk-form') as HTMLFormElement)
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(document.body.textContent).toContain('bridge rejected'))
    expect(document.querySelector('.vsk-step-card')).toBeNull()
    expect(input.disabled).toBe(false)
    expect((document.getElementById('vsk-send-btn') as HTMLButtonElement).disabled).toBe(false)
  })

  it('disconnect во время задачи не оставляет composer навсегда заблокированным после reconnect', async () => {
    const listeners: Array<(message: unknown) => void> = []
    const attached = {
      ui: 'attached',
      attachedTab: {
        tabRef: 'tab-42',
        url: 'https://my.calltouch.ru/accounts',
        title: 'Calltouch',
        origin: 'https://my.calltouch.ru',
      },
    }
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'bridge.submitTask') {
        return { ok: true, task: { sendId: 77, browserTaskId: 'bt-1', chatId: 1 } }
      }
      return { ok: true, state: attached }
    })
    const chromeMock = buildChromeMock({
      runtime: {
        lastError: null,
        sendMessage,
        onMessage: { addListener: vi.fn((fn) => { listeners.push(fn) }) },
      },
    })

    await loadSidepanel(chromeMock)
    const input = document.getElementById('vsk-prompt-input') as HTMLTextAreaElement
    await vi.waitFor(() => expect(input.disabled).toBe(false))
    input.value = 'Прочитай страницу'
    ;(document.getElementById('vsk-form') as HTMLFormElement)
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({
      type: 'bridge.submitTask', prompt: 'Прочитай страницу',
    }))
    expect(input.disabled).toBe(true)

    listeners[0]?.({ type: 'bridge.stateChanged', state: { ui: 'offline', attachedTab: null } })
    listeners[0]?.({ type: 'bridge.stateChanged', state: attached })

    expect(input.disabled).toBe(false)
    expect((document.getElementById('vsk-send-btn') as HTMLButtonElement).disabled).toBe(false)
  })

  it('disconnect send#1 → reconnect/send#2: поздние approval/done #1 не меняют активный run #2', async () => {
    const listeners: Array<(message: unknown) => void> = []
    const attached = {
      ui: 'attached',
      attachedTab: {
        tabRef: 'tab-42',
        url: 'https://my.calltouch.ru/accounts',
        title: 'Calltouch',
        origin: 'https://my.calltouch.ru',
      },
    }
    let resolveFirst!: (value: unknown) => void
    let resolveSecond!: (value: unknown) => void
    const firstSubmit = new Promise((resolve) => { resolveFirst = resolve })
    const secondSubmit = new Promise((resolve) => { resolveSecond = resolve })
    let submitCount = 0
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'bridge.submitTask') {
        submitCount += 1
        return submitCount === 1 ? firstSubmit : secondSubmit
      }
      return { ok: true, state: attached }
    })
    const chromeMock = buildChromeMock({
      runtime: {
        lastError: null,
        sendMessage,
        onMessage: { addListener: vi.fn((fn) => { listeners.push(fn) }) },
      },
    })

    await loadSidepanel(chromeMock)
    const input = document.getElementById('vsk-prompt-input') as HTMLTextAreaElement
    const form = document.getElementById('vsk-form') as HTMLFormElement
    const stop = document.getElementById('vsk-stop-btn') as HTMLButtonElement
    const approval = document.getElementById('vsk-approval-area') as HTMLElement
    await vi.waitFor(() => expect(input.disabled).toBe(false))

    input.value = 'Задача один'
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(submitCount).toBe(1))

    listeners[0]?.({ type: 'bridge.stateChanged', state: { ui: 'offline', attachedTab: null } })
    listeners[0]?.({ type: 'bridge.stateChanged', state: attached })
    expect(input.disabled).toBe(false)

    input.value = 'Задача два'
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(submitCount).toBe(2))
    resolveSecond({ ok: true, task: { sendId: 88, browserTaskId: 'bt-2', chatId: 2 } })
    await vi.waitFor(() => expect(stop.classList.contains('vsk-hidden')).toBe(false))

    // Старый submit завершается уже после нового. Его response и task events
    // принадлежат оборванному соединению и не могут захватить UI второго run.
    resolveFirst({ ok: true, task: { sendId: 77, browserTaskId: 'bt-1', chatId: 1 } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    listeners[0]?.({
      type: 'bridge.taskEvent',
      payload: {
        sendId: 77,
        event: {
          type: 'pending-browser-action',
          actionId: 'stale-action',
          approvalDigest: 'stale-digest',
          snapshot: { label: 'Старое действие' },
        },
      },
    })
    expect(approval.classList.contains('vsk-hidden')).toBe(true)
    listeners[0]?.({ type: 'bridge.taskEvent', payload: { sendId: 77, event: { type: 'done' } } })
    expect(stop.classList.contains('vsk-hidden')).toBe(false)
    expect(input.disabled).toBe(true)

    listeners[0]?.({ type: 'bridge.taskEvent', payload: { sendId: 88, event: { type: 'text', text: 'Ответ второй задачи' } } })
    expect(document.body.textContent).toContain('Ответ второй задачи')
    listeners[0]?.({ type: 'bridge.taskEvent', payload: { sendId: 88, event: { type: 'done' } } })
    expect(stop.classList.contains('vsk-hidden')).toBe(true)
    expect(input.disabled).toBe(false)
  })

  it('успешный Stop сразу освобождает composer и игнорирует поздние события остановленной задачи', async () => {
    const listeners: Array<(message: unknown) => void> = []
    const attached = {
      ui: 'attached',
      attachedTab: {
        tabRef: 'tab-42',
        url: 'https://my.calltouch.ru/accounts',
        title: 'Calltouch',
        origin: 'https://my.calltouch.ru',
      },
    }
    let submitCount = 0
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'bridge.submitTask') {
        submitCount += 1
        return {
          ok: true,
          task: {
            sendId: submitCount === 1 ? 77 : 88,
            browserTaskId: `bt-${submitCount}`,
            chatId: submitCount,
          },
        }
      }
      if (message.type === 'bridge.cancelTask') return { ok: true }
      return { ok: true, state: attached }
    })
    const chromeMock = buildChromeMock({
      runtime: {
        lastError: null,
        sendMessage,
        onMessage: { addListener: vi.fn((fn) => { listeners.push(fn) }) },
      },
    })

    await loadSidepanel(chromeMock)
    const input = document.getElementById('vsk-prompt-input') as HTMLTextAreaElement
    const form = document.getElementById('vsk-form') as HTMLFormElement
    const stop = document.getElementById('vsk-stop-btn') as HTMLButtonElement
    const approval = document.getElementById('vsk-approval-area') as HTMLElement
    await vi.waitFor(() => expect(input.disabled).toBe(false))

    input.value = 'Задача один'
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(stop.classList.contains('vsk-hidden')).toBe(false))
    stop.click()

    await vi.waitFor(() => expect(input.disabled).toBe(false))
    expect(stop.classList.contains('vsk-hidden')).toBe(true)
    expect(document.getElementById('vsk-status')?.textContent).toMatch(/остановлено/i)

    listeners[0]?.({
      type: 'bridge.taskEvent',
      payload: {
        sendId: 77,
        event: {
          type: 'pending-browser-action',
          actionId: 'late-action',
          approvalDigest: 'late-digest',
          snapshot: { label: 'Позднее действие' },
        },
      },
    })
    expect(approval.classList.contains('vsk-hidden')).toBe(true)
    expect(input.disabled).toBe(false)
    expect(stop.classList.contains('vsk-hidden')).toBe(true)
    listeners[0]?.({ type: 'bridge.taskEvent', payload: { sendId: 77, event: { type: 'done' } } })
    expect(input.disabled).toBe(false)

    input.value = 'Задача два'
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(submitCount).toBe(2))
  })
})
