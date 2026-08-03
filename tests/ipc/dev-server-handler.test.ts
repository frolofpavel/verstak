// VSK-BROWSER-B2 блок 3: SEC-CMD на НОВОМ пути (dev_server). Дев-сервер поднимается
// через тот же authorizeProcessCommand, что spawn_process/run_command: команда из
// конфига проходит denylist. Пин доказывает, что гейт НА ПУТИ — денай команды роняет
// запуск ДО spawn. Зелёный ПОТОМУ, что dev_server зовёт тот же authorize, а не потому
// что кто-то другой жив.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { devServerHandler } from '../../electron/ipc/tool-handlers/dev-server'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { ToolCall } from '../../electron/ai/types'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vsk-dev-'))
  mkdirSync(join(dir, '.verstak'), { recursive: true })
})
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })

function ctxWith(classifyAllowed: boolean, spawnSpy: () => void): ToolContext {
  return {
    projectPath: dir, sendId: 1, runId: 'r', agentMode: 'auto',
    tools: { classifyCommand: () => classifyAllowed ? { allowed: true } : { allowed: false, reason: 'denylist' } },
    sender: { send: vi.fn(), exec: async () => ({}) },
    processRegistry: { get: () => undefined, spawn: (...a: unknown[]) => { spawnSpy(); return { id: 'x', pid: 1, status: 'running', command: String(a[0]), cwd: dir, startedAt: 0, outputTail: '', notifyOnExit: false } } },
    permissionRules: [], autoApprove: false, pendingAttachments: [], recordJournal: () => {}, recordRunEvent: () => {},
  } as unknown as ToolContext
}
const call = (name: string): ToolCall => ({ id: 'd1', name: 'dev_server', args: { name } })

describe('dev_server — SEC-CMD на пути + честные отказы', () => {
  it('денайнутая командой конфига НЕ доходит до spawn (гейт на пути)', async () => {
    // Порт заведомо закрыт → путь spawn; команда denylisted → authorize блокирует ДО spawn.
    writeFileSync(join(dir, '.verstak', 'dev-servers.json'), JSON.stringify([{ name: 'web', command: 'rm -rf /', port: 59997 }]))
    const spawnSpy = vi.fn()
    const res = await devServerHandler.handle(call('web'), ctxWith(false, spawnSpy))
    expect(spawnSpy, 'дев-сервер поднялся мимо denylist').not.toHaveBeenCalled()
    expect(String(res.error)).toMatch(/safety policy|denylist/i)
  })

  it('имени нет в конфиге → честная ошибка с перечнем, без запуска', async () => {
    writeFileSync(join(dir, '.verstak', 'dev-servers.json'), JSON.stringify([{ name: 'web', command: 'npm run dev', port: 59996 }]))
    const spawnSpy = vi.fn()
    const res = await devServerHandler.handle(call('api'), ctxWith(true, spawnSpy))
    expect(spawnSpy).not.toHaveBeenCalled()
    expect(String(res.error)).toContain('web')      // перечисляет доступные
  })

  it('нет конфига вовсе → подсказка про .verstak/dev-servers.json', async () => {
    const res = await devServerHandler.handle(call('web'), ctxWith(true, vi.fn()))
    expect(String(res.error)).toContain('.verstak/dev-servers.json')
  })
})
