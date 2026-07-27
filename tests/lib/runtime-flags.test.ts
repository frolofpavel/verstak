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
import { join } from 'node:path'
import {
  RUNTIME_FLAGS,
  isRuntimeFlagOn,
  runtimeFlagValue,
  runtimeFlagByKey,
  type RuntimeFlagKey,
} from '../../src/lib/runtime-flags'

const ROOT = process.cwd()

describe('RUNTIME_FLAGS — состав', () => {
  it('в таблице ровно пять флагов из плана, без дублей', () => {
    const keys = RUNTIME_FLAGS.map(f => f.key)
    expect(keys).toEqual([
      'memory_lifecycle',
      'use_project_brain',
      'smart_routing',
      'smart_fallback',
      'auto_capture_memory',
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
// АНТИ-ДРЕЙФ. Renderer не может импортировать electron/, поэтому сверяемся с
// ИСХОДНИКОМ main: ищем реальное выражение чтения каждого флага и выводим из него
// полярность. Разъехалось — красный.
// ─────────────────────────────────────────────────────────────────────────────
describe('RUNTIME_FLAGS — анти-дрейф с main', () => {
  /** Полярность, выведенная из исходника main: true = opt-out, false = opt-in. */
  function polarityFromSource(key: RuntimeFlagKey, file: string): boolean {
    const src = readFileSync(join(ROOT, file), 'utf8')
    const optOut = new RegExp(`getSecret[^\\n]*['\`"]${key}['\`"]\\s*\\)?\\s*!==\\s*'false'`)
    const optIn = new RegExp(`getSecret[^\\n]*['\`"]${key}['\`"]\\s*\\)?\\s*===\\s*'true'`)
    // memory-hooks читает через вынесенную константу — разбираем и этот вид.
    const optInViaConst = /getSecret\?\.\(AUTO_CAPTURE_SETTING_KEY\)\s*===\s*'true'/
    if (optOut.test(src)) return true
    if (optIn.test(src)) return false
    if (key === 'auto_capture_memory' && optInViaConst.test(src)) return false
    throw new Error(
      `не нашёл чтение флага ${key} в ${file}. Либо флаг перестал читаться, либо ` +
      'изменилась форма выражения — страж обязан упасть, а не промолчать.'
    )
  }

  for (const f of RUNTIME_FLAGS) {
    it(`${f.key}: полярность в ${f.readAt} совпадает с таблицей renderer`, () => {
      expect(polarityFromSource(f.key, f.readAt)).toBe(f.defaultOn)
    })
  }

  it('ключ автозахвата в main объявлен той же строкой', () => {
    const src = readFileSync(join(ROOT, 'electron/ai/memory-hooks.ts'), 'utf8')
    expect(src).toContain("AUTO_CAPTURE_SETTING_KEY = 'auto_capture_memory'")
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

