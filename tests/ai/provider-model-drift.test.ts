// Provider/model drift harness — Фаза 2 §2.2 плана качества (срез 5).
//
// Класс дефекта: список моделей провайдера дублируется в РАЗНЫХ местах —
// main-реестр `electron/ai/registry.ts` (то, что реально уходит в запрос) и
// renderer-хардкод `PROVIDERS` в `src/components/Settings.tsx` (то, что видит и
// сохраняет пользователь). Когда они расходятся, юзер выбирает в настройках модель,
// которой рантайм не знает → длинный прогон с финальной ошибкой «unknown model id».
//
// Прецедент (12.07): UI-ветка откатывала grok к legacy `grok-build`; main-сторону
// поймал model-registry.test, а renderer-сторону пришлось ловить руками — теста не было.
//
// Здесь этот шов закрыт: Settings.tsx парсится как ИСХОДНИК (TS AST, без импорта
// React) и сверяется с main-реестром. Тест намеренно падает ГРОМКО, если не смог
// найти/разобрать PROVIDERS — молчаливое «зелено, потому что ничего не нашли»
// недопустимо для анти-дрейф-стража.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { PROVIDERS as MAIN_PROVIDERS } from '../../electron/ai/registry'
import { parseProviderId, normalizeStoredModel, type ProviderMeta } from '../../src/hooks/useProvider'

interface UiProvider {
  id: string
  models: string[]
  defaultModel: string
}

const SETTINGS_PATH = join(process.cwd(), 'src', 'components', 'Settings.tsx')

/** Достаёт литерал `const PROVIDERS: ProviderConfig[] = [...]` из исходника Settings.tsx. */
function parseUiProviders(): UiProvider[] {
  const src = readFileSync(SETTINGS_PATH, 'utf8')
  const sf = ts.createSourceFile(SETTINGS_PATH, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  let arr: ts.ArrayLiteralExpression | undefined
  const findArray = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'PROVIDERS' &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      arr = node.initializer
    }
    ts.forEachChild(node, findArray)
  }
  findArray(sf)
  if (!arr) {
    throw new Error(
      'Анти-дрейф-страж сломан: не найден литерал `const PROVIDERS: ProviderConfig[] = [...]` в src/components/Settings.tsx. ' +
      'Если массив переименовали/вынесли — почини ЭТОТ парсер, не удаляй тест (иначе дрейф моделей снова пойдёт молча).'
    )
  }

  const strLit = (n: ts.Expression | undefined): string | undefined =>
    n && ts.isStringLiteral(n) ? n.text : undefined

  const out: UiProvider[] = []
  for (const el of arr.elements) {
    if (!ts.isObjectLiteralExpression(el)) continue
    let id: string | undefined
    let defaultModel: string | undefined
    let models: string[] | undefined
    for (const prop of el.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
      const key = prop.name.text
      if (key === 'id') id = strLit(prop.initializer)
      else if (key === 'defaultModel') defaultModel = strLit(prop.initializer)
      else if (key === 'models' && ts.isArrayLiteralExpression(prop.initializer)) {
        models = prop.initializer.elements.map(e => strLit(e)).filter((s): s is string => s !== undefined)
      }
    }
    if (id && models && defaultModel !== undefined) out.push({ id, models, defaultModel })
  }
  if (out.length === 0) {
    throw new Error('Анти-дрейф-страж сломан: PROVIDERS найден, но ни один провайдер не разобран. Почини парсер.')
  }
  return out
}

const uiProviders = parseUiProviders()

describe('provider/model drift — renderer (Settings.tsx) ↔ main-реестр (registry.ts)', () => {
  it('парсер реально извлёк провайдеров из Settings.tsx (страж не «молча зелёный»)', () => {
    expect(uiProviders.length).toBeGreaterThan(10)
    expect(uiProviders.map(p => p.id)).toContain('claude')
  })

  // Каждый провайдер, который UI показывает пользователю, обязан предлагать РОВНО те
  // модели, что знает рантайм. Иначе выбранная в настройках модель не дойдёт до запроса.
  for (const ui of uiProviders) {
    const main = (MAIN_PROVIDERS as Record<string, { models: string[]; defaultModel: string } | undefined>)[ui.id]
    if (!main) continue // провайдер только в UI (или ещё не в реестре) — покрывается отдельным тестом ниже

    // custom-openai / ollama: список моделей задаёт пользователь (в реестре пусто) — строгое
    // равенство неприменимо, проверяем лишь что UI не выдаёт чужие модели за «известные».
    if (main.models.length === 0) continue

    it(`${ui.id}: список моделей UI совпадает с рантаймом`, () => {
      expect(ui.models).toEqual(main.models)
    })

    it(`${ui.id}: модель по умолчанию UI совпадает с рантаймом`, () => {
      expect(ui.defaultModel).toBe(main.defaultModel)
    })
  }

  it('UI не предлагает провайдеров, которых нет в рантайм-реестре', () => {
    const mainIds = new Set(Object.keys(MAIN_PROVIDERS))
    const unknown = uiProviders.filter(p => !mainIds.has(p.id)).map(p => p.id)
    expect(unknown, `провайдеры есть в Settings.tsx, но не в registry.ts: ${unknown.join(', ')}`).toEqual([])
  })
})

describe('UI→runtime parity — любая предложенная моделью UI известна рантайму', () => {
  it('каждая модель из Settings.tsx существует в списке своего провайдера в реестре', () => {
    const broken: string[] = []
    for (const ui of uiProviders) {
      const main = (MAIN_PROVIDERS as Record<string, { models: string[] } | undefined>)[ui.id]
      if (!main || main.models.length === 0) continue
      for (const m of ui.models) {
        if (!main.models.includes(m)) broken.push(`${ui.id}:${m}`)
      }
    }
    // Каждая такая пара = «юзер выберет модель, а рантайм её не знает» (unknown model id).
    expect(broken, `модели из UI отсутствуют в рантайм-реестре: ${broken.join(', ')}`).toEqual([])
  })

  it('модель по умолчанию каждого провайдера входит в его же список моделей (реестр)', () => {
    const broken: string[] = []
    for (const [id, d] of Object.entries(MAIN_PROVIDERS)) {
      const desc = d as { models: string[]; defaultModel: string }
      if (desc.models.length === 0) continue // user-defined (custom-openai/ollama)
      if (!desc.models.includes(desc.defaultModel)) broken.push(`${id}:${desc.defaultModel}`)
    }
    expect(broken, `defaultModel вне собственного списка моделей: ${broken.join(', ')}`).toEqual([])
  })
})

// Третья копия списка провайдеров — runtime-allowlist renderer'а (KNOWN_IDS в
// useProvider.parseProviderId). Если провайдер есть в реестре, но НЕТ в allowlist,
// выбор пользователя МОЛЧА подменяется на 'gemini-api' (провайдер «не выбирается»).
// Живой случай: openai-codex-oauth был добавлен в union и в реестр, но забыт в KNOWN_IDS.
describe('provider-id parity — renderer allowlist ↔ main-реестр', () => {
  it('каждый провайдер из реестра принимается renderer\'ом (не схлопывается в gemini-api)', () => {
    const broken: string[] = []
    for (const id of Object.keys(MAIN_PROVIDERS)) {
      if (parseProviderId(id) !== id) broken.push(id)
    }
    expect(broken, `провайдеры из реестра молча подменяются на gemini-api: ${broken.join(', ')}`).toEqual([])
  })

  it('неизвестный/пустой id падает в безопасный дефолт', () => {
    expect(parseProviderId('такого-провайдера-нет')).toBe('gemini-api')
    expect(parseProviderId(null)).toBe('gemini-api')
    expect(parseProviderId(undefined)).toBe('gemini-api')
  })
})

// §2.2: «Невалидная сохранённая model ID должна давать понятный repair path,
// а не долгий пользовательский run с финальной ошибкой».
describe('repair-путь сохранённой невалидной model ID', () => {
  const meta = (models: string[], defaultModel: string): ProviderMeta => ({
    label: 'x', transport: 'API', models, supportsTools: true, defaultModel, secretKey: null
  })

  it('невалидная сохранённая модель → дефолт провайдера (repair, а не unknown model id в запрос)', () => {
    expect(normalizeStoredModel(meta(['a', 'b'], 'a'), 'снятая-с-поддержки')).toBe('a')
  })

  it('валидная сохранённая модель сохраняется как есть', () => {
    expect(normalizeStoredModel(meta(['a', 'b'], 'a'), 'b')).toBe('b')
  })

  it('пустая сохранённая модель → дефолт провайдера', () => {
    expect(normalizeStoredModel(meta(['a', 'b'], 'a'), null)).toBe('a')
    expect(normalizeStoredModel(meta(['a', 'b'], 'a'), '')).toBe('a')
  })

  it('провайдер с пользовательским списком (custom-openai/ollama) — любая непустая модель валидна', () => {
    expect(normalizeStoredModel(meta([], ''), 'моя-локальная-модель')).toBe('моя-локальная-модель')
  })

  it('дескрипторы ещё не загружены → не гадаем, отдаём сохранённое как есть', () => {
    expect(normalizeStoredModel(undefined, 'что-то')).toBe('что-то')
  })

  it('живой случай: старый датированный claude id (дрейф UI) чинится на текущий дефолт', () => {
    const claude = (MAIN_PROVIDERS as Record<string, { models: string[]; defaultModel: string }>)['claude']
    // Такой id пользователь мог сохранить из старого (дрейфующего) Settings-списка.
    expect(normalizeStoredModel(meta(claude.models, claude.defaultModel), 'claude-sonnet-4-5-20251101'))
      .toBe(claude.defaultModel)
  })
})
