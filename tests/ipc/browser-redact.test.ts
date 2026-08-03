// VSK-BROWSER-B2 блок 2: ОБЯЗАТЕЛЬНЫЙ пин на редакцию консоли и сети (требование №4).
// В заголовках — авторизация, в телах — PII, в console.log мог утечь ключ. Сырьё в
// контекст модели не отдаём. Пин красный на «сырой» отдаче, зелёный после редакции;
// мутация (снять маску заголовков) обязана его ронять — проверено ниже отдельным
// контрольным утверждением про КАЖДЫЙ auth-заголовок.
import { describe, it, expect, vi } from 'vitest'
import { redactNetworkEntry, redactConsoleMessage, capConsoleErrors, capNetwork } from '../../electron/ipc/tool-handlers/browser-redact'
import { browserHandler } from '../../electron/ipc/tool-handlers/browser'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { ToolCall } from '../../electron/ai/types'

describe('redactNetworkEntry — auth-заголовки и URL-секреты не уходят модели', () => {
  it('маскирует КАЖДЫЙ auth-заголовок целиком, безопасные оставляет', () => {
    const safe = redactNetworkEntry({
      method: 'get', url: 'https://api.example.com/v1/me', status: 200,
      headers: {
        'Authorization': 'Bearer sk-live-abcdef1234567890',
        'Cookie': 'session=deadbeefsecret; theme=dark',
        'X-Api-Key': 'key_9f8e7d6c5b4a',
        'Set-Cookie': 'auth=xyz; HttpOnly',
        'Content-Type': 'application/json',
        'Accept-Language': 'ru-RU',
      },
    })
    expect(safe.headers['Authorization']).toBe('[REDACTED]')
    expect(safe.headers['Cookie']).toBe('[REDACTED]')
    expect(safe.headers['X-Api-Key']).toBe('[REDACTED]')
    expect(safe.headers['Set-Cookie']).toBe('[REDACTED]')
    // Контроль: безобидные заголовки не выпилены — иначе сеть бесполезна для отладки.
    expect(safe.headers['Content-Type']).toBe('application/json')
    expect(safe.headers['Accept-Language']).toBe('ru-RU')
    expect(safe.method).toBe('GET')
    // Ни один секрет не просочился ни в один заголовок.
    const dump = JSON.stringify(safe)
    expect(dump).not.toContain('sk-live-abcdef1234567890')
    expect(dump).not.toContain('deadbeefsecret')
    expect(dump).not.toContain('key_9f8e7d6c5b4a')
  })

  it('гасит секрет-токен в URL (?token=…), тело не включается вовсе', () => {
    const safe = redactNetworkEntry({
      method: 'POST', url: 'https://api.example.com/pay?token=supersecret123&id=7', status: 201,
      headers: {}, durationMs: 42.7,
      // умышленно кладём «тело» — его в SafeNetEntry быть НЕ должно
      ...( { body: 'card=4111111111111111&cvv=123' } as Record<string, unknown> ),
    })
    expect(safe.url).not.toContain('supersecret123')
    expect(JSON.stringify(safe)).not.toContain('4111111111111111')  // тело не уехало
    expect(safe.durationMs).toBe(43)
    expect('body' in (safe as unknown as Record<string, unknown>)).toBe(false)
  })
})

describe('redactConsoleMessage — секрет из console.log не уходит модели', () => {
  it('редактирует текст, нормализует уровень, хранит номер строки', () => {
    const m = redactConsoleMessage({ level: 2, text: 'Auth failed with key sk-aBcdEfGh1234567890ijKLmnOP', line: 42, source: 'app.js' })
    expect(m.level).toBe('error')
    expect(m.text).not.toContain('sk-aBcdEfGh1234567890ijKLmnOP')
    expect(m.line).toBe(42)
  })

  it('уровни webview (0/1/2/3) → log/warning/error/debug', () => {
    expect(redactConsoleMessage({ level: 0, text: 'x' }).level).toBe('log')
    expect(redactConsoleMessage({ level: 1, text: 'x' }).level).toBe('warning')
    expect(redactConsoleMessage({ level: 2, text: 'x' }).level).toBe('error')
    expect(redactConsoleMessage({ level: 3, text: 'x' }).level).toBe('debug')
  })
})

describe('ОГРАНИЧЕННЫЙ список (не весь лог — план §4)', () => {
  it('capConsoleErrors: только error+warning, последние N, count честный', () => {
    const raw = [
      { level: 0, text: 'обычный лог' },
      { level: 1, text: 'предупреждение 1' },
      { level: 2, text: 'ошибка 1' },
      { level: 2, text: 'ошибка 2' },
      { level: 2, text: 'ошибка 3' },
    ]
    const r = capConsoleErrors(raw, 2)
    expect(r.count).toBe(4)          // всего error+warning (лог отфильтрован)
    expect(r.messages).toHaveLength(2)
    expect(r.truncated).toBe(true)
    expect(r.messages.map(m => m.text)).toEqual(['ошибка 2', 'ошибка 3']) // свежие
    expect(r.messages.every(m => m.level === 'error' || m.level === 'warning')).toBe(true)
  })

  it('capNetwork: ограничивает и редактирует каждую запись', () => {
    const raw = Array.from({ length: 5 }, (_, i) => ({
      method: 'GET', url: `https://api.example.com/x/${i}`, status: 200,
      headers: { 'Authorization': `Bearer secret-${i}` },
    }))
    const r = capNetwork(raw, 3)
    expect(r.count).toBe(5)
    expect(r.requests).toHaveLength(3)
    expect(r.truncated).toBe(true)
    expect(r.requests.every(x => x.headers['Authorization'] === '[REDACTED]')).toBe(true)
  })
})

// ЧЕРЕЗ ХЕНДЛЕР: редакция стоит НА ПУТИ исполнения, а не только в чистой функции —
// иначе она была бы ложно-зелёной (функция верна, а хендлер отдаёт сырьё). Ловушка
// того же класса, что закрывали для bash_allowlist и клика.
function ctxWith(execResult: unknown): ToolContext {
  return {
    projectPath: 'C:/proj', sendId: 1, runId: 'run-1', agentMode: 'auto',
    sender: { send: vi.fn(), exec: async () => execResult },
    pendingAttachments: [], recordJournal: () => {}, recordRunEvent: () => {},
  } as unknown as ToolContext
}

describe('редакция стоит на ПУТИ исполнения (через browserHandler)', () => {
  it('browser_network через хендлер маскирует Authorization и не отдаёт секрет', async () => {
    const ctx = ctxWith({ url: 'https://x', __raw: [
      { method: 'GET', url: 'https://api.example.com/me', status: 200, headers: { Authorization: 'Bearer sk-live-abcdef1234567890xyz' } },
    ] })
    const res = await browserHandler.handle({ id: 'n1', name: 'browser_network', args: {} } as ToolCall, ctx)
    const out = res.result as { requests: Array<{ headers: Record<string, string> }> }
    expect(out.requests[0].headers.Authorization).toBe('[REDACTED]')
    expect(JSON.stringify(res)).not.toContain('sk-live-abcdef1234567890xyz')
  })

  it('browser_console_errors через хендлер отдаёт только error/warning, ограниченным списком', async () => {
    const ctx = ctxWith({ url: 'https://x', __raw: [
      { level: 0, text: 'обычный лог' }, { level: 2, text: 'TypeError: x is undefined' },
    ] })
    const res = await browserHandler.handle({ id: 'c1', name: 'browser_console_errors', args: {} } as ToolCall, ctx)
    const out = res.result as { count: number; messages: Array<{ level: string; text: string }> }
    expect(out.count).toBe(1)                    // лог отфильтрован
    expect(out.messages[0].level).toBe('error')
    expect(out.messages[0].text).toContain('TypeError')
  })
})
