// VSK-BROWSER-B2 блок 3: чистое ядро дев-сервера-по-конфигу (парс/резолв/URL/реюз).
// Тестируется БЕЗ реального сервера; подъём и проба порта — живой свидетель.
import { describe, it, expect } from 'vitest'
import { parseDevServers, resolveDevServer, devServerUrl, decideDevAction } from '../../electron/ipc/tool-handlers/dev-server-core'

describe('parseDevServers — конфиг {name,command,port}, невалидное отбрасывается с перечнем', () => {
  it('берёт валидные, отбрасывает битые, но НЕ роняет весь конфиг', () => {
    const { servers, dropped } = parseDevServers([
      { name: 'web', command: 'npm run dev', port: 5173 },
      { name: 'api', command: 'npm run api', port: 3001 },
      { name: 'нет порта', command: 'npm run x' },        // битый: нет порта
      { name: '', command: 'npm run y', port: 8080 },       // битый: пустое имя
      { name: 'badport', command: 'z', port: 99999 },       // битый: порт вне диапазона
    ])
    expect(servers.map(s => s.name)).toEqual(['web', 'api'])
    expect(servers[0]).toEqual({ name: 'web', command: 'npm run dev', port: 5173 })
    expect(dropped.length).toBe(3)   // тишины про отброшенное нет
  })

  it('принимает и форму { servers: [...] }, и голый массив; мусор → пусто', () => {
    expect(parseDevServers({ servers: [{ name: 'w', command: 'c', port: 80 }] }).servers).toHaveLength(1)
    expect(parseDevServers('не массив').servers).toEqual([])
    expect(parseDevServers(null).servers).toEqual([])
  })
})

describe('resolveDevServer — по имени, иначе ЧЕСТНАЯ ошибка с перечнем', () => {
  const servers = [{ name: 'web', command: 'npm run dev', port: 5173 }, { name: 'api', command: 'x', port: 3001 }]
  it('находит по имени (без учёта регистра)', () => {
    const r = resolveDevServer(servers, 'WEB')
    expect(r.ok).toBe(true)
    expect((r as { ok: true; config: { port: number } }).config.port).toBe(5173)
  })
  it('не нашёл → ошибка перечисляет доступные (не молчит)', () => {
    const r = resolveDevServer(servers, 'db')
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: string }).error).toContain('web')
    expect((r as { ok: false; error: string }).error).toContain('api')
  })
  it('нет конфигов вовсе → подсказка про .verstak/dev-servers.json', () => {
    const r = resolveDevServer([], 'web')
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: string }).error).toContain('.verstak/dev-servers.json')
  })
})

describe('URL и решение реюза', () => {
  it('devServerUrl — постоянный localhost:порт (порт из конфига заранее)', () => {
    expect(devServerUrl(5173)).toBe('http://localhost:5173')
  })
  it('порт уже слушает → reuse (не поднимаем второй); закрыт → spawn', () => {
    expect(decideDevAction(true)).toBe('reuse')
    expect(decideDevAction(false)).toBe('spawn')
  })
})
