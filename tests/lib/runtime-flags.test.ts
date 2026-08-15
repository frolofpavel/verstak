// Рантайм-флаги: пины на ДЕФОЛТЫ и анти-дрейф между renderer и main.
//
// Класс дефекта, который здесь закрывается: полярность флага живёт в двух местах —
// в main это выражение `getSecret(k) !== 'false'` либо `=== 'true'`, в renderer это
// поле `defaultOn` таблицы RUNTIME_FLAGS. Если они разъедутся, пользователь увидит
// в Настройках выключенным то, что на самом деле включено, и наоборот. Особенно
// дорого это стоит на `auto_capture_memory`: он opt-in по решению Павла от 26.07,
// и случайное превращение его в opt-out вернёт свалку служебных записей в память
// проекта.
//
// Страж намеренно падает ГРОМКО, если не нашёл выражение чтения: «зелено, потому
// что ничего не нашли» для анти-дрейф теста недопустимо.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import {
  RUNTIME_FLAGS,
  isRuntimeFlagOn,
  runtimeFlagValue,
  runtimeFlagByKey,
  type RuntimeFlagKey,
} from '../../src/lib/runtime-flags'
import { RUNTIME_FLAG_DEFAULT_ON } from '../../shared/contracts/runtime-flag-policy'

const ROOT = process.cwd()

describe('RUNTIME_FLAGS — состав', () => {
  // СОСТАВ ИЗМЕНЁН ОСОЗНАННО (29.07, затем 11.08), и это объявляется прямо здесь:
  // пятёрка была не контрактом, а перечнем того, что успели вывести 27.07. Шестым
  // добавлен `plan_approval_gate` (тумблер был спрятан, живая приёмка встала).
  // Восьмым — `mutation_check_enabled` (C2/P6): выключатель обязателен по
  // постановке — второй прогон тестов стоит времени.
  it('в таблице ровно восемь флагов, без дублей', () => {
    const keys = RUNTIME_FLAGS.map(f => f.key)
    expect(keys).toEqual([
      'memory_lifecycle',
      'use_project_brain',
      'smart_routing',
      'smart_fallback',
      'auto_capture_memory',
      'plan_approval_gate',
      'orchestrator_default',
      'mutation_check_enabled',
    ])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('у каждого флага человеческая подпись, а не имя ключа', () => {
    for (const f of RUNTIME_FLAGS) {
      expect(f.title.length).toBeGreaterThan(3)
      expect(f.title).not.toContain('_')
      expect(f.what.length).toBeGreaterThan(20)
      expect(f.whenOff.length).toBeGreaterThan(20)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ДЕФОЛТЫ. Мутация любого значения ниже обязана давать красный — в этом весь
// смысл пина: дефолты менять нельзя, случайно включённый сырой автозахват
// вернёт свалку в память проекта.
// ─────────────────────────────────────────────────────────────────────────────
describe('RUNTIME_FLAGS — дефолты', () => {
  const EXPECTED: Record<RuntimeFlagKey, boolean> = {
    memory_lifecycle: true,
    use_project_brain: true,
    smart_routing: true,
    smart_fallback: true,
    // opt-in — решение Павла от 26.07 (2.1.13). Мутация в true = красный.
    auto_capture_memory: false,
    // ДЕФОЛТ ПЕРЕВЁРНУТ 30.07 (A3 §2.1) — контракт отменён решением Павла, а не
    // подогнан под правку. Прежняя запись «включается ОСОЗНАННО» описывала
    // неверную продуктовую логику: человек не пойдёт включать то, о чём не знает,
    // и не откроет раздел, про который не слышал. Теперь цикл планов работает
    // сразу, а осознанное ВЫКЛЮЧЕНИЕ уважается (stored === 'false').
    plan_approval_gate: true,
    // Задача 10: ВКЛЮЧЁН ПО УМОЛЧАНИЮ — решение Павла («должна быть фишка») после
    // того как весь поток (спавн → видимая сессия → карточка-след → возврат) собран
    // и проверен харнесом. Полярность opt-out (stored !== 'false'), килл-свитч в
    // RuntimeFlagsTab. Мутация в false без флипа чтения в runner-api = красный анти-дрейф.
    orchestrator_default: true,
    // C2 (P6): включён по умолчанию, осознанное выключение (stored === 'false')
    // уважается — цена проверки объявлена в whenOff.
    mutation_check_enabled: true,
  }

  for (const [key, defaultOn] of Object.entries(EXPECTED) as Array<[RuntimeFlagKey, boolean]>) {
    it(`${key}: по умолчанию ${defaultOn ? 'включён' : 'ВЫКЛЮЧЕН'}`, () => {
      expect(runtimeFlagByKey(key).defaultOn).toBe(defaultOn)
      // Ничего не сохранено — состояние равно дефолту.
      expect(isRuntimeFlagOn(runtimeFlagByKey(key), null)).toBe(defaultOn)
      expect(isRuntimeFlagOn(runtimeFlagByKey(key), undefined)).toBe(defaultOn)
    })
  }

  it('сырой автозахват не включается ничем, кроме явной строки true', () => {
    const f = runtimeFlagByKey('auto_capture_memory')
    for (const v of [null, undefined, '', 'false', '1', 'yes', 'TRUE', 'on']) {
      expect(isRuntimeFlagOn(f, v)).toBe(false)
    }
    expect(isRuntimeFlagOn(f, 'true')).toBe(true)
  })

  it('opt-out флаг выключается только явной строкой false', () => {
    const f = runtimeFlagByKey('smart_routing')
    for (const v of [null, undefined, '', 'true', '0', 'no', 'FALSE']) {
      expect(isRuntimeFlagOn(f, v)).toBe(true)
    }
    expect(isRuntimeFlagOn(f, 'false')).toBe(false)
  })

  it('записываемое значение читается обратно как то же состояние', () => {
    for (const f of RUNTIME_FLAGS) {
      expect(isRuntimeFlagOn(f, runtimeFlagValue(true))).toBe(true)
      expect(isRuntimeFlagOn(f, runtimeFlagValue(false))).toBe(false)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// АНТИ-ДРЕЙФ. КОНТРАКТ СМЕНИЛСЯ 15.08 (§3.1 ревизии), и это объявляется прямо
// здесь, а не подгоняется молча.
//
// Было: полярность объявлялась ТРИЖДЫ — в shared, в таблице renderer и отдельным
// сравнением строки в каждой точке чтения main. Страж сверял две последние
// редакции, выводя полярность из исходника main регуляркой по `!== 'false'`.
// Именно так этот пин и должен был работать, пока дубль существовал.
//
// Стало: полярность объявлена ОДИН раз — RUNTIME_FLAG_DEFAULT_ON в
// shared/contracts/runtime-flag-policy.ts; main зовёт `runtimeFlagOn(key, …)`,
// таблица renderer берёт `defaultOn` оттуда же. Сверять две редакции больше
// нечего — их одна. Ровно так с 30.07 жил plan_approval_gate, и его ветка в
// прежнем страже (`viaSharedHelper`) была образцом: теперь он распространён на
// все восемь флагов.
//
// Поэтому страж проверяет ДРУГОЕ, и это не ослабление, а перенос на то, что
// теперь может сломаться:
//   1) чтение флага НЕ ИСЧЕЗЛО из файла, где оно обещано таблицей (readAt);
//   2) сравнение строки НЕ ЗАВЕЛОСЬ ЗАНОВО нигде в electron/ — то есть дубль
//      не вернулся;
//   3) контрольный кейс к пункту 2: та же регулярка обязана ЛОВИТЬ дубль на
//      синтетическом тексте. Без него «не нашли ни одного сравнения» было бы
//      зелёным и у сломанной регулярки (§3.1: рядом с «не произошло» стоит
//      кейс, где происходит).
// ─────────────────────────────────────────────────────────────────────────────
/** Сравнение строки настройки с 'true'/'false' по конкретному ключу флага —
 *  ровно та форма, которая раньше и была дублем полярности. */
function inlineComparisonRe(key: string): RegExp {
  return new RegExp(`['\`"]${key}['\`"]\\s*\\)?\\s*(?:!==\\s*'false'|===\\s*'true')`)
}

describe('RUNTIME_FLAGS — анти-дрейф с main', () => {
  for (const f of RUNTIME_FLAGS) {
    it(`${f.key}: читается в ${f.readAt} общим хелпером, а не своим сравнением`, () => {
      const src = readFileSync(join(ROOT, f.readAt), 'utf8')
      // Чтение существует. Три допустимых вида: по литералу ключа, по вынесенной
      // константе (memory-hooks) и через именной хелпер (plan_approval_gate).
      const readsViaHelper = new RegExp(`runtimeFlagOn\\(\\s*(?:['\`"]${f.key}['\`"]|[A-Z_]+)`).test(src)
        || new RegExp(`isPlanApprovalGateOn\\([^\\n]*${f.key}`).test(src)
      expect(
        readsViaHelper,
        `не нашёл чтение флага ${f.key} в ${f.readAt}: либо флаг перестал читаться, ` +
        'либо чтение снова делает что-то своё — страж обязан упасть, а не промолчать.'
      ).toBe(true)
      // И полярность в этом файле НЕ объявляется заново.
      expect(
        inlineComparisonRe(f.key).test(src),
        `${f.readAt}: полярность ${f.key} снова продублирована сравнением строки`
      ).toBe(false)
    })
  }

  it('во ВСЁМ electron/ нет ни одного сравнения строки по ключу флага', () => {
    const files = execSync('git ls-files electron', { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(f => f.endsWith('.ts'))
    expect(files.length, 'не нашёл исходников electron/ — пин потерял предмет').toBeGreaterThan(50)
    const offenders: string[] = []
    for (const file of files) {
      const src = readFileSync(join(ROOT, file), 'utf8')
      for (const f of RUNTIME_FLAGS) if (inlineComparisonRe(f.key).test(src)) offenders.push(`${file} → ${f.key}`)
    }
    expect(offenders, 'дубль полярности вернулся в main').toEqual([])
  })

  it('контроль: регулярка ловит дубль, если он появится (иначе пин выше пуст)', () => {
    expect(inlineComparisonRe('smart_routing').test("getSecret('smart_routing') !== 'false'")).toBe(true)
    expect(inlineComparisonRe('auto_capture_memory').test("get?.('auto_capture_memory') === 'true'")).toBe(true)
    expect(inlineComparisonRe('smart_routing').test("runtimeFlagOn('smart_routing', getSecret('smart_routing'))")).toBe(false)
  })

  it('ключ автозахвата в main объявлен той же строкой', () => {
    const src = readFileSync(join(ROOT, 'electron/ai/memory-hooks.ts'), 'utf8')
    expect(src).toContain("AUTO_CAPTURE_SETTING_KEY = 'auto_capture_memory'")
  })

  it('таблица renderer берёт полярность из единственного источника, а не пишет свою', () => {
    const src = readFileSync(join(ROOT, 'src/lib/runtime-flags.ts'), 'utf8')
    for (const f of RUNTIME_FLAGS) {
      expect(src, `${f.key}: defaultOn снова объявлен литералом в таблице renderer`)
        .toContain(`defaultOn: RUNTIME_FLAG_DEFAULT_ON.${f.key},`)
    }
    expect(RUNTIME_FLAGS.map(f => f.defaultOn))
      .toEqual(RUNTIME_FLAGS.map(f => RUNTIME_FLAG_DEFAULT_ON[f.key]))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Вкладка должна быть ПОДКЛЮЧЕНА. Построенный и не смонтированный экран — ровно
// тот дефект, который эта позиция и закрывала: флаги существовали, но человек их
// не видел. Страж читает исходник Settings.tsx: пропало — красный.
// ─────────────────────────────────────────────────────────────────────────────
describe('вкладка «Поведение агента» подключена к Настройкам', () => {
  const src = readFileSync(join(ROOT, 'src/components/Settings.tsx'), 'utf8')

  it('импортирована и смонтирована', () => {
    expect(src).toContain("import { RuntimeFlagsTab } from './RuntimeFlagsTab'")
    expect(src).toContain("{tab === 'runtimeFlags' && <RuntimeFlagsTab />}")
  })

  it('есть в union вкладок и в списке навигации', () => {
    expect(src).toMatch(/type Tab =[^\n]*'runtimeFlags'/)
    expect(src).toMatch(/id: 'runtimeFlags', label: '[^']+'/)
  })

  it('находится поиском по настройкам — ключевые слова заданы', () => {
    const nav = src.split('\n').find(l => l.includes("id: 'runtimeFlags'")) ?? ''
    expect(nav).toContain('keywords:')
    expect(nav).toContain('память')
  })
})

