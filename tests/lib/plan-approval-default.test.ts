// §2.1 A3 · цикл планов включён по умолчанию, и обе стороны согласны в этом.
//
// ЧТО МЕНЯЕТСЯ ДЛЯ ЧЕЛОВЕКА. Механизм «задача → план → согласование → выполнение»
// был построен, но спрятан за выключенным тумблером: человек не пойдёт включать
// то, о чём не знает. Теперь цикл работает сразу после установки.
//
// ГЛАВНАЯ ГРАБЛЯ, И ОНА НЕ ПРО ДЕФОЛТ. Полярность жила в ДВУХ местах: поле
// `defaultOn` таблицы renderer и собственное сравнение строки в main
// (`=== 'true'`). Перевернуть только декларацию значило показать «включено»,
// пока main продолжает читать «выключено» у всех, кто тумблер не трогал:
// интерфейс врёт, тесты зелёные. Поэтому пин ниже проверяет СОГЛАСОВАННОСТЬ
// трёх точек на ПОВЕДЕНИИ (что renderer и main отвечают одинаково), а не наличие
// строки в исходнике — иначе он стерёг бы формулировку, а не смысл.
//
// ОСОЗНАННЫЙ ВЫБОР УВАЖЕН БЕЗ МИГРАЦИИ. Значение пишется только по клику
// (RuntimeFlagsTab: при загрузке лишь читает, seeding дефолтов нет нигде), так
// что «ключа нет» = «человек не трогал», а `'false'` = «выключил осознанно». При
// opt-out семантике `stored !== 'false'` первый получает включённый цикл, второй
// остаётся с выключенным. Никого не перещёлкиваем молча.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRuntimeFlagOn, runtimeFlagByKey } from '../../src/lib/runtime-flags'
import { isPlanApprovalGateOn, PLAN_APPROVAL_GATE_DEFAULT_ON } from '../../shared/contracts/runtime-flag-policy'

const ROOT = process.cwd()
/** Обе точки main, где решается судьба карточки согласования. */
const MAIN_READERS = [
  'electron/ipc/tool-handlers/verification.ts',
  'electron/ipc/tool-handlers/outcome.ts',
]

describe('§2.1 · дефолт перевёрнут', () => {
  it('свежая установка: согласование включено', () => {
    expect(PLAN_APPROVAL_GATE_DEFAULT_ON, 'цикл планов снова спрятан за выключенным тумблером').toBe(true)
    expect(isPlanApprovalGateOn(null), 'нет записи в настройках = человек не трогал → включено').toBe(true)
    expect(isPlanApprovalGateOn(undefined)).toBe(true)
  })

  // Уважение осознанного выбора — без миграции и без release notes.
  it('кто выключил осознанно, остаётся выключенным', () => {
    expect(isPlanApprovalGateOn('false'), 'молча перещёлкнули того, кто отказался').toBe(false)
  })

  it('кто включал явно, остаётся включённым', () => {
    expect(isPlanApprovalGateOn('true')).toBe(true)
  })

  it('таблица renderer говорит то же самое', () => {
    const def = runtimeFlagByKey('plan_approval_gate')
    expect(def.defaultOn).toBe(true)
    for (const stored of [null, undefined, '', 'true', 'yes']) {
      expect(isRuntimeFlagOn(def, stored), String(stored)).toBe(true)
    }
    expect(isRuntimeFlagOn(def, 'false')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// СОГЛАСОВАННОСТЬ ТРЁХ ТОЧЕК — требование постановщика, и проверяется по
// ПОВЕДЕНИЮ, а не по тексту. Точки: декларация renderer, оба читателя в main.
// ─────────────────────────────────────────────────────────────────────────────
describe('§2.1 · renderer и main отвечают одинаково', () => {
  it('main не сравнивает строку сам, а зовёт общий хелпер', () => {
    for (const file of MAIN_READERS) {
      const src = readFileSync(join(ROOT, file), 'utf8')
      expect(src, `${file}: полярность снова продублирована сравнением строки`)
        .not.toMatch(/['"`]plan_approval_gate['"`]\s*\)?\s*===\s*'true'/)
      expect(src, `${file}: флаг перестал читаться общим хелпером`).toContain('isPlanApprovalGateOn')
    }
  })

  // КОНТРОЛЬ к предыдущему пину: он ищет в существующих файлах, а не в пустоте.
  // Без этого «не нашли сравнение» было бы зелёным и при неверном пути.
  it('контроль: файлы читателей существуют и упоминают флаг', () => {
    for (const file of MAIN_READERS) {
      const src = readFileSync(join(ROOT, file), 'utf8')
      expect(src.length, `${file} пуст — пин потерял предмет`).toBeGreaterThan(100)
      expect(src).toContain('plan_approval_gate')
    }
  })

  it('на каждом сохранённом значении обе стороны дают один ответ', () => {
    const def = runtimeFlagByKey('plan_approval_gate')
    for (const stored of [null, undefined, '', 'true', 'false', 'FALSE', '1', 'нет']) {
      expect(isRuntimeFlagOn(def, stored), `renderer и shared разошлись на ${String(stored)}`)
        .toBe(isPlanApprovalGateOn(stored))
    }
  })
})
