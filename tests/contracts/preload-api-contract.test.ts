// Контракт Preload API — срез 2.0.7-B программы релизов 2.0.7–2.0.10.
//
// Класс дефекта: поверхность `window.api` объявлена ДВАЖДЫ и синхронизируется вручную —
// фактическая реализация в `electron/preload.ts` (`contextBridge.exposeInMainWorld`) и
// её декларация для renderer в `src/types/api.d.ts` (`Window.api`). Когда они расходятся:
//  · метод есть в декларации, но НЕ проброшен в preload → renderer вызывает undefined
//    и падает в рантайме, хотя `npm run type` зелёный (типы врут);
//  · метод проброшен, но не объявлен → renderer не может им пользоваться (мёртвый IPC);
//  · подписка `on*` объявлена без корректного unsubscribe → утечка слушателей.
//
// Здесь обе поверхности извлекаются из ИСХОДНИКОВ через TS AST и сравниваются.
// Ни `preload.ts`, ни `api.d.ts` этот срез не меняет (allowlist карточки).
//
// Красный сценарий проверяется на СИНТЕТИЧЕСКИХ фикстурах (требование карточки, шаг 5):
// временно ломать production-файл нельзя.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const ROOT = process.cwd()
const PRELOAD_PATH = join(ROOT, 'electron', 'preload.ts')
const DECL_PATH = join(ROOT, 'src', 'types', 'api.d.ts')

/** Поверхность API: namespace → набор имён методов. Пустой namespace '' = метод в корне. */
type Surface = Map<string, Set<string>>

const surfaceKeys = (s: Surface): string[] => {
  const out: string[] = []
  for (const [ns, methods] of s) for (const m of methods) out.push(ns ? `${ns}.${m}` : m)
  return out.sort()
}

function propName(node: ts.PropertyName | undefined): string | null {
  if (!node) return null
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
  return null // computed — в контракте не участвует
}

/** Извлекает поверхность из `contextBridge.exposeInMainWorld('api', { … })`. */
export function extractPreloadSurface(source: string, fileName = 'preload.ts'): Surface {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let apiObject: ts.ObjectLiteralExpression | undefined

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'exposeInMainWorld' &&
      node.arguments.length >= 2 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === 'api' &&
      ts.isObjectLiteralExpression(node.arguments[1])
    ) {
      apiObject = node.arguments[1]
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  if (!apiObject) {
    throw new Error(
      'Контракт-страж сломан: не найден `contextBridge.exposeInMainWorld(\'api\', { … })` в preload. ' +
      'Если вызов переименовали/вынесли — почини ЭТОТ парсер, не удаляй тест (иначе дрейф поверхности пойдёт молча).'
    )
  }

  const surface: Surface = new Map()
  for (const prop of apiObject.properties) {
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop) && !ts.isMethodDeclaration(prop)) continue
    const name = propName(prop.name)
    if (!name) continue
    if (ts.isPropertyAssignment(prop) && ts.isObjectLiteralExpression(prop.initializer)) {
      const methods = new Set<string>()
      for (const m of prop.initializer.properties) {
        const mn = propName(m.name)
        if (mn) methods.add(mn)
      }
      surface.set(name, methods)
    } else {
      // метод прямо в корне api
      const root = surface.get('') ?? new Set<string>()
      root.add(name)
      surface.set('', root)
    }
  }
  return surface
}

/** Извлекает поверхность из `declare global { interface Window { api: { … } } }`. */
export function extractDeclSurface(source: string, fileName = 'api.d.ts'): Surface {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let apiType: ts.TypeLiteralNode | undefined

  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'Window') {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && propName(member.name) === 'api' && member.type && ts.isTypeLiteralNode(member.type)) {
          apiType = member.type
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  if (!apiType) {
    throw new Error(
      'Контракт-страж сломан: не найден `interface Window { api: { … } }` в src/types/api.d.ts. ' +
      'Если декларацию переименовали/вынесли — почини ЭТОТ парсер, не удаляй тест.'
    )
  }

  const surface: Surface = new Map()
  for (const member of apiType.members) {
    if (!ts.isPropertySignature(member)) continue
    const name = propName(member.name)
    if (!name) continue
    if (member.type && ts.isTypeLiteralNode(member.type)) {
      const methods = new Set<string>()
      for (const m of member.type.members) {
        if (!ts.isPropertySignature(m) && !ts.isMethodSignature(m)) continue
        const mn = propName(m.name)
        if (mn) methods.add(mn)
      }
      surface.set(name, methods)
    } else {
      const root = surface.get('') ?? new Set<string>()
      root.add(name)
      surface.set('', root)
    }
  }
  return surface
}

/** Разница поверхностей: что объявлено, но не проброшено, и наоборот. */
export function diffSurfaces(preload: Surface, decl: Surface): {
  declaredButNotExposed: string[]
  exposedButNotDeclared: string[]
} {
  const p = new Set(surfaceKeys(preload))
  const d = new Set(surfaceKeys(decl))
  return {
    // renderer вызовет undefined → падение в рантайме при зелёном type-check
    declaredButNotExposed: [...d].filter(k => !p.has(k)).sort(),
    // мёртвый IPC: проброшено, но renderer об этом не знает
    exposedButNotDeclared: [...p].filter(k => !d.has(k)).sort(),
  }
}

/**
 * Подписки `on*` обязаны возвращать unsubscribe `() => void` — иначе слушатель
 * невозможно снять и он течёт между чатами/проектами.
 */
export function findBadUnsubscribes(source: string, fileName = 'api.d.ts'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const bad: string[] = []

  const isUnsubscribe = (t: ts.TypeNode | undefined): boolean => {
    if (!t || !ts.isFunctionTypeNode(t)) return false
    return t.parameters.length === 0 && t.type.kind === ts.SyntaxKind.VoidKeyword
  }

  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'Window') {
      const walkType = (tl: ts.TypeLiteralNode, path: string): void => {
        for (const m of tl.members) {
          if (!ts.isPropertySignature(m)) continue
          const name = propName(m.name)
          if (!name) continue
          if (m.type && ts.isTypeLiteralNode(m.type)) {
            walkType(m.type, path ? `${path}.${name}` : name)
            continue
          }
          if (!/^on[A-Z]/.test(name)) continue
          // ожидаем: (cb: …) => () => void
          const t = m.type
          if (t && ts.isFunctionTypeNode(t) && isUnsubscribe(t.type)) continue
          bad.push(path ? `${path}.${name}` : name)
        }
      }
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && propName(member.name) === 'api' && member.type && ts.isTypeLiteralNode(member.type)) {
          walkType(member.type, '')
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return bad.sort()
}

// ─────────────────────────────────────────────────────────────────────────────
// Красные сценарии на СИНТЕТИЧЕСКИХ фикстурах (шаг 5 карточки: production-файлы
// временно ломать нельзя). Доказывают, что сравнение реально ловит дрейф.
// ─────────────────────────────────────────────────────────────────────────────
const FIXTURE_PRELOAD = `
import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('api', {
  projects: {
    pick: () => ipcRenderer.invoke('projects:pick'),
    list: () => ipcRenderer.invoke('projects:list'),
  },
  window: {
    onMaximizedChanged: (cb: (v: boolean) => void) => { void cb; return () => {} },
  },
})
`

const FIXTURE_DECL_OK = `
declare global {
  interface Window {
    api: {
      projects: {
        pick: () => Promise<string | null>
        list: () => Promise<string[]>
      }
      window: {
        onMaximizedChanged: (cb: (v: boolean) => void) => () => void
      }
    }
  }
}
export {}
`

describe('фикстуры: страж реально ловит дрейф (красные сценарии)', () => {
  it('идентичные поверхности → расхождений нет', () => {
    const d = diffSurfaces(extractPreloadSurface(FIXTURE_PRELOAD), extractDeclSurface(FIXTURE_DECL_OK))
    expect(d.declaredButNotExposed).toEqual([])
    expect(d.exposedButNotDeclared).toEqual([])
  })

  it('метод ОБЪЯВЛЕН, но НЕ проброшен → поймано (renderer вызвал бы undefined)', () => {
    const decl = FIXTURE_DECL_OK.replace(
      'list: () => Promise<string[]>',
      'list: () => Promise<string[]>\n        remove: (p: string) => Promise<void>'
    )
    const d = diffSurfaces(extractPreloadSurface(FIXTURE_PRELOAD), extractDeclSurface(decl))
    expect(d.declaredButNotExposed).toEqual(['projects.remove'])
  })

  it('метод ПРОБРОШЕН, но не объявлен → поймано (мёртвый IPC)', () => {
    const preload = FIXTURE_PRELOAD.replace(
      "list: () => ipcRenderer.invoke('projects:list'),",
      "list: () => ipcRenderer.invoke('projects:list'),\n    secret: () => ipcRenderer.invoke('projects:secret'),"
    )
    const d = diffSurfaces(extractPreloadSurface(preload), extractDeclSurface(FIXTURE_DECL_OK))
    expect(d.exposedButNotDeclared).toEqual(['projects.secret'])
  })

  it('подписка on* без unsubscribe `() => void` → поймано (утечка слушателя)', () => {
    const bad = FIXTURE_DECL_OK.replace(
      'onMaximizedChanged: (cb: (v: boolean) => void) => () => void',
      'onMaximizedChanged: (cb: (v: boolean) => void) => void'
    )
    expect(findBadUnsubscribes(bad)).toEqual(['window.onMaximizedChanged'])
    // корректная фикстура нарушений не даёт
    expect(findBadUnsubscribes(FIXTURE_DECL_OK)).toEqual([])
  })

  it('парсер падает ГРОМКО, если поверхность не найдена (не «молча зелёный»)', () => {
    expect(() => extractPreloadSurface('const x = 1')).toThrow(/Контракт-страж сломан/)
    expect(() => extractDeclSurface('const x = 1')).toThrow(/Контракт-страж сломан/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Реальный контракт: preload.ts ↔ api.d.ts
// ─────────────────────────────────────────────────────────────────────────────
const preloadSrc = readFileSync(PRELOAD_PATH, 'utf8')
const declSrc = readFileSync(DECL_PATH, 'utf8')
const preloadSurface = extractPreloadSurface(preloadSrc, PRELOAD_PATH)
const declSurface = extractDeclSurface(declSrc, DECL_PATH)

describe('контракт: electron/preload.ts ↔ src/types/api.d.ts', () => {
  it('парсер реально извлёк поверхность (страж не «молча зелёный»)', () => {
    expect(preloadSurface.size).toBeGreaterThan(10)
    expect(declSurface.size).toBeGreaterThan(10)
    expect([...preloadSurface.keys()]).toContain('projects')
    expect([...declSurface.keys()]).toContain('projects')
  })

  it('нет методов, ОБЪЯВЛЕННЫХ в api.d.ts, но НЕ проброшенных в preload', () => {
    const { declaredButNotExposed } = diffSurfaces(preloadSurface, declSurface)
    // Каждый такой метод = renderer вызовет undefined и упадёт в рантайме,
    // хотя `npm run type` зелёный. Типы врут о реальности.
    expect(declaredButNotExposed, `объявлены, но не проброшены: ${declaredButNotExposed.join(', ')}`).toEqual([])
  })

  it('нет методов, ПРОБРОШЕННЫХ в preload, но не объявленных в api.d.ts', () => {
    const { exposedButNotDeclared } = diffSurfaces(preloadSurface, declSurface)
    // Каждый такой = мёртвый IPC: renderer о нём не знает и вызвать не может.
    expect(exposedButNotDeclared, `проброшены, но не объявлены: ${exposedButNotDeclared.join(', ')}`).toEqual([])
  })

  it('все подписки on* возвращают unsubscribe `() => void`', () => {
    const bad = findBadUnsubscribes(declSrc, DECL_PATH)
    expect(bad, `подписки без корректного unsubscribe: ${bad.join(', ')}`).toEqual([])
  })
})
