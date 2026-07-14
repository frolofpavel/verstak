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
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import ts from 'typescript'
import { PROVIDERS as MAIN_PROVIDERS, providerCapabilities } from '../../electron/ai/registry'
import { EXTRA_PROVIDERS } from '../../electron/ai/extra-providers'
import { parseProviderId, normalizeStoredModel, type ProviderMeta } from '../../src/hooks/useProvider'
import {
  PROVIDER_IDS,
  isKnownProviderId,
  capabilitiesFor,
  executionModeFor,
  authKindFor,
  isSubprocessTransport,
  resolveStoredProviderId,
  type ProviderId,
} from '../../shared/contracts/provider'

const ROOT = process.cwd()

/**
 * Собирает строковые литералы внутри объявления `decl` в файле `file`.
 * Падает ГРОМКО, если объявление исчезло: страж, который «ничего не нашёл и потому
 * зелёный», хуже отсутствующего стража — он создаёт ложное чувство защиты.
 */
function literalsOf(file: string, decl: string): string[] {
  const src = readFileSync(join(ROOT, file), 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true)
  let found: ts.VariableDeclaration | undefined
  const findDecl = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === decl) found = n
    ts.forEachChild(n, findDecl)
  }
  findDecl(sf)
  if (!found?.initializer) throw new Error(`Страж политик сломан: в ${file} нет объявления ${decl}`)
  const out: string[] = []
  const collect = (n: ts.Node) => {
    if (ts.isStringLiteral(n)) out.push(n.text)
    ts.forEachChild(n, collect)
  }
  collect(found.initializer)
  if (out.length === 0) throw new Error(`Страж политик сломан: в ${file}.${decl} не найдено ни одного id`)
  return out
}

/**
 * Литеральные ключи объекта PROVIDERS в исходнике реестра — то есть БАЗОВЫЕ провайдеры,
 * без спреда extra. Источник независим от контракта: только так проверка «extra не затирает
 * базового» остаётся настоящей, а не тавтологией.
 */
function registryBaseKeys(): string[] {
  const file = 'electron/ai/registry.ts'
  const src = readFileSync(join(ROOT, file), 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true)
  let obj: ts.ObjectLiteralExpression | undefined
  const find = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'PROVIDERS' &&
        n.initializer && ts.isObjectLiteralExpression(n.initializer)) obj = n.initializer
    ts.forEachChild(n, find)
  }
  find(sf)
  if (!obj) throw new Error(`Страж сломан: не найден литерал PROVIDERS в ${file}`)
  const keys: string[] = []
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue // спред extra-провайдеров пропускаем
    if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) keys.push(p.name.text)
  }
  return keys
}

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

// ─── 2.0.7-C: единый контракт вместо синхронизации копий ──────────────────────
// Раньше дрейф ЛОВИЛСЯ тестами постфактум. Теперь он структурно невозможен: ID,
// transport, capabilities и DTO живут в shared/contracts/provider.ts, а реестр main
// типизирован Record<ProviderId, …>. Ниже — прямые инварианты контракта (а не сверка
// двух копий): они держат сам контракт честным.
describe('единый контракт провайдеров (shared/contracts/provider.ts)', () => {
  it('список ID без дублей', () => {
    expect(new Set(PROVIDER_IDS).size).toBe(PROVIDER_IDS.length)
  })

  it('рантайм-реестр main покрывает контракт ровно (ни одного лишнего/потерянного)', () => {
    // Проверка именно РАНТАЙМА: тип Record<ProviderId,…> можно обмануть кастом,
    // а этот тест смотрит на фактические ключи объекта.
    expect([...Object.keys(MAIN_PROVIDERS)].sort()).toEqual([...PROVIDER_IDS].sort())
  })

  it('каждый ID контракта опознаётся как известный', () => {
    for (const id of PROVIDER_IDS) expect(isKnownProviderId(id)).toBe(true)
  })

  // Дыра, которую тип НЕ закрывает: extra-провайдеры вливаются в реестр через
  // Object.fromEntries — ключи для TS становятся индексной сигнатурой, и
  // Record<ProviderId,…> перестаёт требовать их наличия. Ловим рантаймом.
  it('extra-провайдеры не перезаписывают базовых (коллизия id молча подменила бы провайдера)', () => {
    const extraIds = EXTRA_PROVIDERS.map(s => s.id) as string[]
    expect(new Set(extraIds).size, 'дубли id среди extra-провайдеров').toBe(extraIds.length)

    // Ревью 2.0.7-C: список базовых был ЗАХАРДКОЖЕН прямо в тесте (сам тест — ещё одна
    // копия реестра), а вычитать extra из контракта нельзя: пересечение стало бы пустым
    // ПО ПОСТРОЕНИЮ, и тест превратился бы в тавтологию. Берём базовые ключи независимо —
    // из исходника реестра (литеральные ключи объекта PROVIDERS, без спреда extra).
    const base = registryBaseKeys()
    expect(base.length, 'не разобрали базовые ключи реестра — страж сломан').toBeGreaterThan(5)

    const collisions = extraIds.filter(id => base.includes(id))
    expect(collisions, `extra-провайдер затирает базового: ${collisions.join(', ')}`).toEqual([])

    // И вместе они обязаны давать ровно контракт — иначе провайдер потерян на стыке.
    expect([...base, ...extraIds].sort()).toEqual([...PROVIDER_IDS].sort())
  })

  it('страж политик не «молча зелёный»: пропавшее объявление роняет тест', () => {
    // Проверка самой проверки: если файл переписали и объявления больше нет,
    // страж обязан упасть, а не тихо ничего не проверить.
    expect(() => literalsOf('electron/ai/tool-mode.ts', 'НЕТ_ТАКОГО_ОБЪЯВЛЕНИЯ'))
      .toThrow(/Страж политик сломан/)
  })

  it('дефолтная модель входит в список моделей своего провайдера', () => {
    for (const p of Object.values(MAIN_PROVIDERS)) {
      if (p.models.length === 0) continue // custom-openai/ollama — модели задаёт пользователь
      expect(p.models, `${p.id}: defaultModel вне своего списка`).toContain(p.defaultModel)
    }
  })

  it('реестр не заводит вторую матрицу capabilities (страж от повторного форка)', () => {
    for (const p of Object.values(MAIN_PROVIDERS)) {
      expect(providerCapabilities(p)).toEqual(capabilitiesFor(p.transport, p.supportsTools))
    }
  })

  it('honesty: у subprocess-провайдеров (CLI/Tunnel) НЕТ пофайлового undo и живого таймлайна', () => {
    // CLI пишет файлы мимо нашего undo-стека (для него — git-якорь Control Envelope).
    // Обещать per-file undo на CLI = врать пользователю про контроль.
    for (const p of Object.values(MAIN_PROVIDERS)) {
      if (!isSubprocessTransport(p.transport)) continue
      const caps = providerCapabilities(p)
      expect(caps.perFileUndo, `${p.id}: обещает per-file undo, которого нет`).toBe(false)
      expect(caps.liveTimeline, `${p.id}: обещает живой таймлайн нашего loop'а`).toBe(false)
    }
  })

  it('executionMode честно следует из transport (внешний агент не выдаётся за наш loop)', () => {
    for (const p of Object.values(MAIN_PROVIDERS)) {
      const mode = executionModeFor(p.transport)
      if (p.transport === 'API') expect(mode).toBe('native-agent-loop')
      if (p.transport === 'CLI') expect(mode).toBe('cli-subprocess')
      if (p.transport === 'Tunnel') expect(mode).toBe('external-agent-loop')
    }
  })

  it('authKind: OAuth-подписка, CLI-сессия и безключевой различимы (секрет в DTO не течёт)', () => {
    const kind = (id: ProviderId) => {
      const p = MAIN_PROVIDERS[id]
      return authKindFor(p.id, p.transport, p.secretKey)
    }
    expect(kind('openai-codex-oauth')).toBe('oauth-subscription')
    expect(kind('claude-cli')).toBe('cli-session')
    expect(kind('ollama')).toBe('none')
    expect(kind('claude')).toBe('api-key')
  })
})

// Страж от РЕЦИДИВА: баг родился не из «неправильного списка», а из того, что
// список можно было завести ЕЩЁ РАЗ в произвольном файле. Тест ловит новую копию.
// Источник обхода — git ls-files, а НЕ ручной список каталогов. Ре-ревью 2.0.7-C
// поймало: walk('src'/'electron'/'shared') врал про «все деревья кода приложения» —
// мимо шли git-tracked legacy/rail-v1/*.tsx и корневые *.config.ts, куда можно было
// спрятать копию списка. git ls-files перечисляет РОВНО отслеживаемый код, без дрейфа
// каталогов. tests/ исключаем — там перечисление id легитимно (этот файл тому пример).
function trackedSources(): string[] {
  const out = execSync('git ls-files "*.ts" "*.tsx"', { cwd: ROOT, encoding: 'utf8' })
  return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).filter(f => !f.startsWith('tests/'))
}

// Файлы-ОПРЕДЕЛЕНИЯ, где список id — это и есть определение (их сверяют drift/contract-
// тесты выше). Исключены и из копи-стража, и из скана опечаток (их модельные массивы
// иначе давали бы ложные «почти-id»).
const DEFINITION_FILES = [
  'shared/contracts/provider.ts',
  'electron/ai/registry.ts',
  'electron/ai/extra-providers.ts',
  'src/components/Settings.tsx',
]

describe('нет ещё одной копии списка провайдеров', () => {
  // Полноправно держат МНОГО id (это их работа): определения + policy-файлы, которые
  // законно перечисляют провайдеров (тиры/бейджи/vision). Копи-страж их не флагует,
  // но опечатки в них ловит скан ниже.
  const COPY_ALLOWED = [
    ...DEFINITION_FILES,
    'electron/ai/tier-router.ts',
    'src/components/Sidebar.tsx',
    'electron/ai/tool-mode.ts',
    'src/lib/vision-support.ts',
    'src/lib/runtime-capability.ts',
  ]

  it('ни один другой tracked-файл не перечисляет провайдеров списком', () => {
    const offenders: string[] = []
    for (const rel of trackedSources()) {
      if (COPY_ALLOWED.includes(rel)) continue
      const src = readFileSync(join(ROOT, rel), 'utf8')
      // Ключи Record'а могут быть БЕЗ кавычек (`openai: {...}`), поэтому ищем и голый
      // токен-ключ, и кавыченный литерал.
      const hits = PROVIDER_IDS.filter(id =>
        src.includes(`'${id}'`) || src.includes(`"${id}"`) ||
        new RegExp(`(^|[^\\w-])${id.replace(/[-]/g, '\\-')}\\s*:`, 'm').test(src))
      // Порог 10 из 22: пара упоминаний — обычная работа с провайдером; перечисление
      // большинства — уже копия реестра. Осознанная граница: копию из ≤9 id копи-страж
      // не увидит (её узкий случай стережёт скан опечаток по provider-позициям ниже).
      if (hits.length >= 10) offenders.push(`${rel} (${hits.length} id)`)
    }
    expect(offenders, `появилась новая копия списка провайдеров — заведите её через shared-контракт: ${offenders.join(', ')}`).toEqual([])
  })
})

// Тихий класс дрейфа: ОПЕЧАТКА в id (≤2 правки) в policy-структуре НЕ падает, политика
// просто молча не применяется (Set<string> — tsc слеп). Честная граница: сильно
// обрезанный/переименованный stale-id (напр. 'gateway' вместо 'verstak-gateway') на
// расстоянии >2 скан НЕ ловит — он про опечатки, не про любой дрейф имени. Ре-ревью
// 2.0.7-C поймало ДВЕ дыры прежней версии: (1) ручной POLICY_FILES не включал
// src/lib/runtime-capability.ts (CLI_WITH_NATIVE_MODE_CONTROL — опечатка ломала бы бейдж
// контроля); (2) скан по ВСЕМ строковым литералам был хрупок (запас до ложного
// срабатывания — 1 правка).
//
// Теперь: policy-файлы ОБНАРУЖИВАЮТСЯ (файл с ≥2 известными id в provider-позициях), а
// «почти-id» ищется ТОЛЬКО в этих позициях — элементы массивов/Set, ключи объектов,
// операнды === / !==. Метки, подсказки и текст (property-VALUES) в скан не попадают —
// ложных срабатываний на 'observed'/'partial'/'ULT' больше нет.
describe('per-provider политики ссылаются только на существующих провайдеров', () => {
  function distance(a: string, b: string): number {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
    for (let j = 0; j <= b.length; j++) dp[0][j] = j
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      }
    }
    return dp[a.length][b.length]
  }

  /**
   * Литералы в «provider-позициях»: элемент массива/Set, ключ объекта, операнд ===/!==.
   * Именно так провайдер попадает в политику — а метки/подсказки (значения свойств,
   * аргументы i18n) сюда НЕ входят, что и убирает ложные срабатывания скана.
   */
  function providerPositionLiterals(file: string): string[] {
    const src = readFileSync(join(ROOT, file), 'utf8')
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const out: string[] = []
    const push = (n: ts.Node) => { if (n && ts.isStringLiteral(n)) out.push(n.text) }
    const visit = (n: ts.Node) => {
      if (ts.isArrayLiteralExpression(n)) n.elements.forEach(push)
      else if (ts.isPropertyAssignment(n) && ts.isStringLiteral(n.name)) push(n.name)
      else if (ts.isBinaryExpression(n) &&
        (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
         n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)) {
        push(n.left); push(n.right)
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    return out
  }

  // Обнаруживаем policy-файлы среди tracked-кода: файл с ≥2 известными id в
  // provider-позициях — это политика по провайдеру. Определения исключены (их сверяют
  // отдельные тесты, а модельные массивы дали бы шум).
  const policyFiles = trackedSources()
    .filter(f => !DEFINITION_FILES.includes(f))
    .map(f => ({ f, lits: providerPositionLiterals(f) }))
    .filter(({ lits }) => lits.filter(l => isKnownProviderId(l.toLowerCase())).length >= 2)

  it('обнаружены реальные policy-файлы (скан не пуст — не «молча зелёный»)', () => {
    const names = policyFiles.map(p => p.f)
    // Известные политики ОБЯЗАНЫ обнаружиться — иначе скан ничего не проверяет.
    expect(names).toContain('src/lib/runtime-capability.ts')
    expect(names).toContain('electron/ai/tool-mode.ts')
    expect(names.length).toBeGreaterThanOrEqual(3)
  })

  for (const { f } of policyFiles) {
    it(`${f}: нет «почти-провайдеров» в provider-позициях (опечатка = молча выключенная политика)`, () => {
      const suspects: string[] = []
      for (const lit of new Set(providerPositionLiterals(f))) {
        const v = lit.toLowerCase()
        if (v.length < 4 || isKnownProviderId(v)) continue
        const near = PROVIDER_IDS.find(id => distance(v, id) <= 2)
        if (near) suspects.push(`"${lit}" ≈ ${near}`)
      }
      expect(suspects, `похоже на опечатку в provider-id (политика молча не применится): ${suspects.join(', ')}`).toEqual([])
    })
  }

  // Точечная проверка Set-политик: падает ГРОМКО, если объявление ИСЧЕЗЛО (переименовали/
  // удалили) — авто-обнаружение такое молча пропустит. Только Set-политики (их члены —
  // сплошь id); Record с не-id значениями (CLI_SECRET_LEVEL) сюда не берём — их ключи
  // покрывает позиционный скан выше.
  const NAMED: { file: string; decl: string }[] = [
    { file: 'electron/ai/tool-mode.ts', decl: 'COAXABLE_PROVIDERS' },
    { file: 'src/lib/vision-support.ts', decl: 'NO_VISION' },
    { file: 'electron/ai/tier-router.ts', decl: 'TIER_PROVIDERS' },
    { file: 'src/lib/runtime-capability.ts', decl: 'CLI_WITH_TIMELINE' },
    { file: 'src/lib/runtime-capability.ts', decl: 'CLI_WITH_NATIVE_MODE_CONTROL' },
  ]

  for (const { file, decl } of NAMED) {
    it(`${file} → ${decl}: каждый id есть в контракте`, () => {
      const unknown = literalsOf(file, decl).filter(v => !isKnownProviderId(v))
      expect(unknown, `политика ссылается на несуществующих провайдеров (молча не применяется): ${unknown.join(', ')}`).toEqual([])
    })
  }
})

// Третья копия списка провайдеров (KNOWN_IDS в useProvider) УДАЛЕНА в 2.0.7-C —
// parseProviderId теперь резолвит через shared-контракт. Тест оставлен: он проверяет
// сам факт, что ни один провайдер реестра не схлопывается в дефолт.
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

  // 2.0.7-C, суть фикса: дефолт остаётся (иначе приложению не с чем стартовать), но
  // ФАКТ подмены больше не теряется — раньше пользователь просто видел «мой провайдер
  // не сохраняется» и не мог понять почему.
  it('resolveStoredProviderId возвращает ФАКТ подмены (UI-баннер поверх — срез 2.0.7-D)', () => {
    const r = resolveStoredProviderId('openai-codex-oauth-v2')
    expect(r.id).toBe('gemini-api')
    expect(r.unavailable).toBe(true)
    expect(r.requested).toBe('openai-codex-oauth-v2')
  })

  it('известный провайдер резолвится без флага подмены', () => {
    const r = resolveStoredProviderId('openai-codex-oauth')
    expect(r).toEqual({ id: 'openai-codex-oauth', unavailable: false, requested: 'openai-codex-oauth' })
  })

  it('пустой выбор — это не «недоступный провайдер», а просто дефолт', () => {
    expect(resolveStoredProviderId(null)).toEqual({ id: 'gemini-api', unavailable: false, requested: null })
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
