// C9 (13.08): подтверждение ЗАПИСИ из скрытого чата — показать некому.
//
// Родня Б2 (11.08). Тогда закрыли путь КОМАНД: awaitCommandConfirm видит
// ctx.autoRejectConfirms (у прогона нет поверхности подтверждений — скрытый чат
// попытки состязания, окна нет) и немедленно отказывает, вместо того чтобы висеть
// вечно. Путь ЗАПИСИ остался со своим ожиданием и про этот флаг не знал.
//
// Класс числился недостижимым: попытки состязания идут в auto, а в auto запись
// авто-принимается. C1 (тем же пакетом) это изменил — правила проекта спрашивают
// и в auto. То есть недостижимое стало достижимым В ЭТОМ ЖЕ ПАКЕТЕ, и без
// починки скрытый прогон повис бы до ручного Stop.
//
// Отказ, никогда согласие: пауза ответственного действия не ослабляется.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { writeFileHandler } from '../../electron/ipc/tool-handlers/file-ops'
import { draftProjectRulesHandler } from '../../electron/ipc/tool-handlers/project-rules'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { AgentMode } from '../../electron/ai/mode-policy'
import type { ToolCall } from '../../electron/ai/types'

interface Harness {
  ctx: ToolContext
  writes: Array<{ path: string; content: string }>
  rejected: Array<{ callId: string; toolName: string; subject: string }>
}

function harness(dir: string, mode: AgentMode, hidden: boolean): Harness {
  const writes: Array<{ path: string; content: string }> = []
  const rejected: Array<{ callId: string; toolName: string; subject: string }> = []
  const ctx = {
    runId: 'run-c9',
    projectPath: dir,
    sendId: 't',
    agentMode: mode,
    signal: new AbortController().signal,
    sender: { send: () => {} },
    pendingWrites: new Map(),
    pendingCommands: new Map(),
    scopedKey: (s: unknown, c: unknown) => `${s}:${c}`,
    recordWrite: () => {},
    recordRunEvent: () => {},
    ...(hidden ? { autoRejectConfirms: (i: Harness['rejected'][number]) => { rejected.push(i) } } : {}),
    tools: {
      execute: async (name: string, args: Record<string, unknown>) => {
        if (name === 'write_file') { writes.push({ path: String(args.path), content: String(args.content) }); return 'ok' }
        return ''
      },
    },
  } as unknown as ToolContext
  return { ctx, writes, rejected }
}

/**
 * Ждём результат с бюджетом. Без него незакрытый пин ВИСНЕТ, а не краснеет:
 * повисший прогон — ровно тот дефект, который здесь чинится, и увидеть его надо
 * как названную ошибку, а не как безымянный таймаут всего прогона (§3.1 про
 * бюджет заметно меньше testTimeout).
 */
async function within<T>(p: Promise<T>, ms = 2000): Promise<T | 'ЗАВИС'> {
  return Promise.race([p, new Promise<'ЗАВИС'>(r => setTimeout(() => r('ЗАВИС'), ms))])
}

const writeCall = (): ToolCall => ({ id: '1', name: 'write_file', args: { path: 'src/foo.ts', content: 'x' } })
const rulesCall = (): ToolCall => ({ id: '1', name: 'draft_project_rules', args: {} })

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verstak-c9-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }), 'utf8')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('C9: write-confirm из скрытого чата', () => {
  it('ПИН: ask + скрытый чат → немедленный отказ, а не вечное ожидание', async () => {
    const h = harness(dir, 'ask', true)

    const res = await within(writeFileHandler.handle(writeCall(), h.ctx))

    expect(res, 'скрытый прогон повис на карточке, которую некому показать').not.toBe('ЗАВИС')
    expect(h.writes, 'запись прошла без человека — отказ подменён согласием').toHaveLength(0)
    expect((res as { error?: string }).error).toBe('User rejected')
  })

  it('ПИН: отказ несёт СЛЕД с предметом — иначе причина невосстановима', async () => {
    const h = harness(dir, 'ask', true)

    await within(writeFileHandler.handle(writeCall(), h.ctx))

    expect(h.rejected).toHaveLength(1)
    expect(h.rejected[0].toolName).toBe('write_file')
    expect(h.rejected[0].subject).toContain('src/foo.ts')
  })

  it('ПИН: правила проекта в AUTO из скрытого чата — путь, открытый C1, тоже не виснет', async () => {
    // До C1 запись в auto авто-принималась и до ожидания не доходила. Теперь
    // доходит, поэтому кейс не гипотетический.
    const h = harness(dir, 'auto', true)

    const res = await within(draftProjectRulesHandler.handle(rulesCall(), h.ctx))

    expect(res, 'C1 сделал путь достижимым, и скрытый прогон на нём повис').not.toBe('ЗАВИС')
    expect(h.writes).toHaveLength(0)
    expect(h.rejected).toHaveLength(1)
  })

  it('КОНТРОЛЬ: обычный (видимый) чат в ask по-прежнему СПРАШИВАЕТ человека', async () => {
    // Без этого кейса пины выше зелены и у гейта, который отказывает всем подряд.
    const h = harness(dir, 'ask', false)

    const p = writeFileHandler.handle(writeCall(), h.ctx)
    await new Promise<void>(r => setTimeout(r, 20))

    expect(h.ctx.pendingWrites.size, 'подтверждение перестало доходить до человека').toBe(1)
    expect(h.rejected).toHaveLength(0)
    h.ctx.pendingWrites.get('t:1')!.resolve(true)
    await p
    expect(h.writes).toHaveLength(1)
  })

  it('КОНТРОЛЬ: скрытый чат в auto пишет обычный код без вопроса (авто-приём не сломан)', async () => {
    const h = harness(dir, 'auto', true)

    const res = await within(writeFileHandler.handle(writeCall(), h.ctx))

    expect(h.writes).toHaveLength(1)
    expect((res as { error?: string }).error).toBeFalsy()
    expect(h.rejected).toHaveLength(0)
  })

  it('ПИН: скрытый чат НИКОГДА не получает согласие — plan по-прежнему блокирует', async () => {
    const h = harness(dir, 'plan', true)

    const res = await within(writeFileHandler.handle(writeCall(), h.ctx))

    expect(h.writes).toHaveLength(0)
    expect((res as { error?: string }).error).toBeTruthy()
  })
})
