// Срез 2.0.7-G: контракт-страж диспетчеризации инструментов.
//
// Класс дефекта: lookupHandler раньше отдавал generic readHandler ЛЮБОМУ имени, которого
// нет в HANDLER_REGISTRY. Последствия: (1) новый write/sequential TOOL_DEF, забытый в
// регистре, молча получал parallel-read вместо своего mode (confirm-модалка/подтверждение
// не срабатывали); (2) галлюцинированное или необъявленное имя молча исполнялось как read.
//
// Здесь этот шов закрыт контрактом: каждый TOOL_DEF обязан быть ЯВНО классифицирован
// (registry или audited read-allowlist), опасные тулзы держат свой mode, а неизвестное
// имя ОТКЛОНЯЕТСЯ, а не читается. Плюс: scheduler-allowlist не содержит write/exec.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

// tool-handlers тянет electron-зависимые хендлеры → мокаем electron ДО импорта (паттерн ipc-тестов).
vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { getPath: () => '/tmp' } }))

const { lookupHandler, GENERIC_READ_ALLOWLIST } = await import('../../electron/ipc/tool-handlers')
const { readHandler, unknownToolHandler } = await import('../../electron/ipc/tool-handlers/file-ops')

const ROOT = process.cwd()

/** Извлекает `name: '...'`-поля верхнего уровня из массива-литерала `decl` в файле. */
function toolDefNames(file: string, decl: string): string[] {
  const src = readFileSync(join(ROOT, file), 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true)
  let arr: ts.ArrayLiteralExpression | undefined
  const find = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === decl &&
        n.initializer && ts.isArrayLiteralExpression(n.initializer)) arr = n.initializer
    ts.forEachChild(n, find)
  }
  find(sf)
  if (!arr) throw new Error(`Контракт-страж сломан: не найден массив ${decl} в ${file}`)
  const names: string[] = []
  for (const el of arr.elements) {
    if (!ts.isObjectLiteralExpression(el)) continue
    for (const p of el.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'name' && ts.isStringLiteral(p.initializer)) {
        names.push(p.initializer.text)
      }
    }
  }
  if (names.length === 0) throw new Error(`Контракт-страж сломан: в ${decl} (${file}) не разобрано ни одного name`)
  return names
}

/** Извлекает элементы строкового массива-литерала `decl` (напр. SCHEDULED_READONLY_TOOLS). */
function stringArray(file: string, decl: string): string[] {
  const src = readFileSync(join(ROOT, file), 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true)
  let arr: ts.ArrayLiteralExpression | undefined
  const find = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === decl &&
        n.initializer && ts.isArrayLiteralExpression(n.initializer)) arr = n.initializer
    ts.forEachChild(n, find)
  }
  find(sf)
  if (!arr) throw new Error(`Контракт-страж сломан: не найден массив ${decl} в ${file}`)
  const out = arr.elements.filter(ts.isStringLiteral).map(e => e.text)
  if (out.length === 0) throw new Error(`Контракт-страж сломан: ${decl} пуст`)
  return out
}

const TOOL_NAMES = toolDefNames('electron/ai/tools.ts', 'TOOL_DEFS')
const SCHEDULED = stringArray('electron/ipc/ai.ts', 'SCHEDULED_READONLY_TOOLS')

// Whitelist вместо denylist (ревью 2.0.7-G): unattended scheduler-tool допустим ТОЛЬКО если
// он parallel-read ЛИБО один из read-гейтящихся sequential-коннекторов ниже. Так новый
// sequential-опасный тул, добавленный в SCHEDULED без правки этого набора, ПАДАЕТ сам —
// denylist же пропустил бы незнакомое опасное имя.
// connector_query/list_connectors — sequential, но op-level политика гейтит их read-only
// (readOnlyConnectors=true в runScheduledHeadless), поэтому легитимны в unattended-наборе.
const READ_GATED_SEQUENTIAL = new Set(['connector_query', 'list_connectors'])

describe('tool-contract: каждый TOOL_DEF явно классифицирован', () => {
  it('парсер извлёк тулзы (страж не «молча зелёный»)', () => {
    expect(TOOL_NAMES.length).toBeGreaterThan(40)
    expect(TOOL_NAMES).toContain('write_file')
    expect(TOOL_NAMES).toContain('read_file')
  })

  it('ни один TOOL_DEF не резолвится в unknownToolHandler (все покрыты registry+allowlist)', () => {
    const orphan = TOOL_NAMES.filter(n => lookupHandler(n) === unknownToolHandler)
    expect(orphan, `объявленные тулзы без явного handler/allowlist: ${orphan.join(', ')}`).toEqual([])
  })

  it('audited read-allowlist содержит ТОЛЬКО parallel-read (write туда не просочился)', () => {
    for (const n of GENERIC_READ_ALLOWLIST) {
      expect(lookupHandler(n).mode, `${n} в read-allowlist, но не parallel-read`).toBe('parallel-read')
      expect(lookupHandler(n), `${n} должен резолвиться в generic readHandler`).toBe(readHandler)
    }
  })

  it('read-allowlist ⊆ TOOL_DEFS (нет allowlist-имени без объявленного тула)', () => {
    const ghost = [...GENERIC_READ_ALLOWLIST].filter(n => !TOOL_NAMES.includes(n))
    expect(ghost, `в read-allowlist имена, которых нет в TOOL_DEFS: ${ghost.join(', ')}`).toEqual([])
  })
})

describe('tool-contract: неизвестный tool отклоняется, а не читается (2.0.7-G)', () => {
  it('незарегистрированное имя → unknownToolHandler, НЕ readHandler', () => {
    const h = lookupHandler('totally_made_up_tool_xyz')
    expect(h).toBe(unknownToolHandler)
    expect(h).not.toBe(readHandler)
  })

  it('unknownToolHandler отдаёт ошибку и ничего не исполняет', async () => {
    const calls: string[] = []
    const ctx = {
      sendId: 1, sender: { send: () => {} },
      tools: { execute: async (name: string) => { calls.push(name); return 'LEAK' } },
    } as never
    const res = await unknownToolHandler.handle({ id: 'x', name: 'made_up', args: {} } as never, ctx)
    expect(res.error, 'должна быть структурная ошибка').toBeTruthy()
    expect(res.result).toBe('')
    expect(calls, 'unknownToolHandler НЕ должен вызывать ctx.tools.execute').toEqual([])
  })
})

describe('tool-contract: опасные тулзы держат свой mode (не понижены до read)', () => {
  const EXPECTED: Record<string, 'confirm-write' | 'sequential'> = {
    write_file: 'confirm-write', apply_patch: 'confirm-write', propose_edits: 'confirm-write',
    edit_spreadsheet: 'confirm-write',
    run_command: 'sequential', run_until_green: 'sequential', spawn_process: 'sequential',
    web_fetch: 'sequential', web_search: 'sequential',
  }
  for (const [name, mode] of Object.entries(EXPECTED)) {
    it(`${name} = ${mode}`, () => {
      expect(TOOL_NAMES, `${name} исчез из TOOL_DEFS — обнови контракт`).toContain(name)
      expect(lookupHandler(name).mode).toBe(mode)
    })
  }
})

describe('tool-contract: scheduler read-only allowlist безопасен (шаг 4)', () => {
  it('извлечён непустой набор', () => {
    expect(SCHEDULED.length).toBeGreaterThan(5)
    expect(SCHEDULED).toContain('read_file')
  })

  it('каждый scheduler-tool классифицирован (не unknown)', () => {
    const orphan = SCHEDULED.filter(n => lookupHandler(n) === unknownToolHandler)
    expect(orphan, `scheduler-tool без handler: ${orphan.join(', ')}`).toEqual([])
  })

  it('каждый scheduler-tool — parallel-read ИЛИ read-гейтящийся коннектор (whitelist)', () => {
    const bad = SCHEDULED.filter(n => {
      if (READ_GATED_SEQUENTIAL.has(n)) return false
      return lookupHandler(n).mode !== 'parallel-read'
    })
    expect(bad, `scheduler-tool не read-safe (не parallel-read и не read-гейтящийся коннектор): ${bad.join(', ')}`).toEqual([])
  })
})
