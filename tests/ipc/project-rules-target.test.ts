// C3 (13.08): куда draft_project_rules пишет, когда файла правил НЕТ.
//
// Наблюдение живой приёмки 12.08 звучало так: «ensureUserLayer скаффолдит
// .verstak/RULES.md при открытии проекта → draft_project_rules всегда видит
// существующий файл, ветка "нет правил → писать напрямую" недостижима,
// targetPath фактически мёртв». Разбор показал, что вывод неверен, а ветка —
// не мёртвый код, а рабочий запасной путь. Скаффолд НЕ гарантирует файл к
// моменту вызова инструмента:
//
//  1. `ensureUserLayer` вызывается через `void ... .catch(() => {})` (projects.ts) —
//     его никто не ждёт; хендлер `projects:set-current` возвращает управление
//     сразу, и вызов инструмента может опередить асинхронную запись;
//  2. он срабатывает на ОТКРЫТИИ проекта, а не перед каждым вызовом: файл,
//     удалённый или переименованный человеком после открытия, не восстанавливается;
//  3. его запись может не пройти (права, read-only каталог) — он возвращает
//     `{created:false, path:null}` и молчит.
//
// Поэтому ветка остаётся, а снимается ЗАПИСЬ о её мёртвости. Сетка ниже —
// характеризация: она держит обе цели и краснеет, если кто-то удалит ветку,
// поверив прежней формулировке.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { draftProjectRulesHandler } from '../../electron/ipc/tool-handlers/project-rules'
import { ensureUserLayer } from '../../electron/ai/user-layer'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { ToolCall } from '../../electron/ai/types'

interface Harness { ctx: ToolContext; writes: Array<{ path: string; content: string }> }

// bypass: сетка про ВЫБОР ЦЕЛИ, показ diff — предмет своей сетки (C1).
function harness(dir: string): Harness {
  const writes: Array<{ path: string; content: string }> = []
  const ctx = {
    runId: 'run-c3',
    projectPath: dir,
    sendId: 't',
    agentMode: 'bypass',
    signal: new AbortController().signal,
    sender: { send: () => {} },
    pendingWrites: new Map(),
    scopedKey: (s: unknown, c: unknown) => `${s}:${c}`,
    recordWrite: () => {},
    recordRunEvent: () => {},
    tools: {
      execute: async (name: string, args: Record<string, unknown>) => {
        if (name === 'write_file') { writes.push({ path: String(args.path), content: String(args.content) }); return 'ok' }
        return ''
      },
    },
  } as unknown as ToolContext
  return { ctx, writes }
}

const rulesCall = (args: Record<string, unknown> = {}): ToolCall => ({ id: '1', name: 'draft_project_rules', args })

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verstak-c3-rules-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }), 'utf8')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('C3: выбор цели записи правил', () => {
  it('ПИН: файла правил нет → пишем ПРЯМО в .verstak/RULES.md, без .draft', async () => {
    const h = harness(dir)

    const res = await draftProjectRulesHandler.handle(rulesCall(), h.ctx)

    expect(h.writes).toHaveLength(1)
    expect(h.writes[0].path, 'ветка «нет правил → писать напрямую» действительно недостижима').toBe('.verstak/RULES.md')
    expect(res.result).toContain('.verstak/RULES.md')
    expect(res.result).not.toContain('НЕ тронут')
  })

  it('ЗЕРКАЛО: файл правил есть → предложение в .verstak/RULES.draft.md, чужое не тронуто', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Правила, написанные человеком\n', 'utf8')
    const h = harness(dir)

    const res = await draftProjectRulesHandler.handle(rulesCall(), h.ctx)

    expect(h.writes[0].path).toBe('.verstak/RULES.draft.md')
    expect(res.result).toContain('НЕ тронут')
  })

  it('ЗЕРКАЛО: overwrite:true → правка адресована существующему файлу', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Правила\n', 'utf8')
    const h = harness(dir)

    await draftProjectRulesHandler.handle(rulesCall({ overwrite: true }), h.ctx)

    expect(h.writes[0].path).toBe('CLAUDE.md')
  })

  it('ДОСТИЖИМОСТЬ: правила, удалённые после открытия проекта, скаффолдом не восстанавливаются', async () => {
    // Проходим ровно тот путь, что и продукт: скаффолд на открытии проекта…
    const created = await ensureUserLayer(dir)
    expect(created.created).toBe(true)
    expect(existsSync(join(dir, '.verstak', 'RULES.md'))).toBe(true)

    // …человек удаляет файл, проект не переоткрывает — второго скаффолда нет.
    rmSync(join(dir, '.verstak', 'RULES.md'))
    const h = harness(dir)

    const res = await draftProjectRulesHandler.handle(rulesCall(), h.ctx)

    expect(h.writes[0].path, 'состояние «правил нет» на живом проекте достижимо, ветка не мёртвая').toBe('.verstak/RULES.md')
    expect(res.error).toBeFalsy()
  })

  it('КОНТРОЛЬ: скаффолд идемпотентен — существующие правила он не подменяет', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Человеческие правила\n', 'utf8')

    const r = await ensureUserLayer(dir)

    expect(r.created).toBe(false)
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain('Человеческие правила')
  })
})
