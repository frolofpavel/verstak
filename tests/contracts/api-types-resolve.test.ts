import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/**
 * Страж «типы api.d.ts РЕАЛЬНО резолвятся» (инцидент 2.0.8-F).
 *
 * Корень дефекта: `export type { X } from './mod'` — это РЕЭКСПОРТ, он НЕ вводит имя X в
 * область модуля. Если X при этом используется в теле `declare global` (window.api), имя
 * неразрешено (TS2304) — но `skipLibCheck: true` в tsconfig ГЛУШИТ ошибки внутри .d.ts,
 * поэтому `npm run type` молчит, а у потребителя тип тихо становится `any`.
 *
 * Итог: «типизированный IPC» оказывался фикцией и никто этого не видел. Так было найдено
 * 4 поверхности сразу: usage (этот срез), subscriptionAccounts (2.0.8-B), providers и
 * prompt-route (2.0.7-C/F) — суммарно 6 TS2304.
 *
 * Лечение — `import type { X } … } + export type { X }`. Этот страж не даёт откатиться.
 * Дешёвый AST-разбор (мс) вместо `tsc --skipLibCheck false` (~21с).
 */

const API_DTS = join(__dirname, '..', '..', 'src', 'types', 'api.d.ts')

interface Parsed {
  /** Имена, введённые в модуль (import type … / локальные type-алиасы) — они резолвятся. */
  bound: Set<string>
  /** Имена ТОЛЬКО из `export … from` (реэкспорт без импорта) — в модуле их НЕТ. */
  reexportedOnly: Set<string>
  sf: ts.SourceFile
}

function parseApiDts(): Parsed {
  const source = readFileSync(API_DTS, 'utf8')
  const sf = ts.createSourceFile('api.d.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const bound = new Set<string>()
  const reexported = new Set<string>()

  for (const st of sf.statements) {
    // import type { A, B as C } from '…' → в модуль попадают A и C
    if (ts.isImportDeclaration(st) && st.importClause) {
      const nb = st.importClause.namedBindings
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) bound.add(el.name.text)
      if (st.importClause.name) bound.add(st.importClause.name.text)
    }
    // export type { A } from '…' → РЕЭКСПОРТ: в модуль НЕ попадает.
    // export type { A }          → без moduleSpecifier: имя обязано быть уже связано.
    if (ts.isExportDeclaration(st) && st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) reexported.add(el.name.text)
    }
    // Локальные объявления типов/интерфейсов — тоже связывают имя.
    if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) bound.add(st.name.text)
  }
  const reexportedOnly = new Set([...reexported].filter(n => !bound.has(n)))
  return { bound, reexportedOnly, sf }
}

/** Все идентификаторы, использованные в ТИПОВЫХ позициях внутри declare global. */
function namesUsedInGlobal(sf: ts.SourceFile): Set<string> {
  const used = new Set<string>()
  const collect = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) {
      const n = node.typeName
      used.add(ts.isIdentifier(n) ? n.text : n.right.text)
    }
    ts.forEachChild(node, collect)
  }
  for (const st of sf.statements) {
    // `declare global { … }` — ModuleDeclaration с флагом GlobalAugmentation.
    if (ts.isModuleDeclaration(st) && st.body) collect(st.body)
  }
  return used
}

describe('типы api.d.ts должны реально резолвиться (инцидент 2.0.8-F)', () => {
  it('ни одно имя, используемое в declare global, не приходит ТОЛЬКО через реэкспорт', () => {
    const { reexportedOnly, sf } = parseApiDts()
    const used = namesUsedInGlobal(sf)
    // Пересечение = имена, которые TS не разрешит (TS2304), а skipLibCheck это спрячет
    // → window.api.<эта поверхность> молча станет any.
    const broken = [...used].filter(n => reexportedOnly.has(n)).sort()
    expect(broken).toEqual([])
  })

  it('страж жив: он действительно видит имена в declare global и реэкспорты', () => {
    // Защита от «зелёного из-за пустого разбора» (парсер сломался → тест бесполезен).
    const { sf, bound } = parseApiDts()
    expect(namesUsedInGlobal(sf).size).toBeGreaterThan(20)
    expect(bound.has('UsageSummaryGroup')).toBe(true) // фикс среза F на месте
    expect(bound.has('ProviderDescriptorDTO')).toBe(true)
  })
})
