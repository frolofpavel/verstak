// ДЕФЕКТ 2 ЖИВОЙ ПРИЁМКИ (29.07): тумблер согласования плана существовал, но
// человек его не нашёл — он жил в свёрнутом блоке «Дополнительные настройки»
// вкладки «Права модели», а искали его на вкладке «Поведение агента».
//
// Здесь охраняется то, что нельзя проверить рендером одной вкладки: переключатель
// ОДИН на всё приложение. Два контрола на один ключ не имеют общего состояния —
// переключил в одном месте, второе показывает старое, пока его не перемонтируют.
// Именно поэтому дубль в PolicyTab снят, а не оставлен «для удобства».
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { RUNTIME_FLAGS, runtimeFlagByKey } from '../../src/lib/runtime-flags'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')

/** Файлы renderer'а, в которых вообще может встретиться имя ключа настройки. */
function srcFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter(p => /\.tsx?$/.test(p))
    .map(p => join(SRC, p))
}

/** Где в renderer встречается литерал ключа — путь относительно корня. */
function filesMentioning(key: string): string[] {
  return srcFiles()
    .filter(f => readFileSync(f, 'utf8').includes(`'${key}'`))
    .map(f => relative(ROOT, f).split(sep).join('/'))
    .sort()
}

describe('переключатель согласования плана — ровно один на приложение', () => {
  it('ключ упоминается в renderer только в таблице рантайм-флагов', () => {
    expect(filesMentioning('plan_approval_gate')).toEqual(['src/lib/runtime-flags.ts'])
  })

  // КОНТРОЛЬ. Без него первый пин был бы зелёным и оттого, что сканер ничего не
  // ищет: путь неверный, расширение не то, кавычки другие.
  it('контроль: сканер находит настройку, которая осталась в PolicyTab', () => {
    expect(filesMentioning('auto_approve_edits')).toContain('src/components/settings/PolicyTab.tsx')
  })

  it('контроль: несуществующий ключ не находится нигде', () => {
    expect(filesMentioning('plan_approval_gate_v2')).toEqual([])
  })
})

describe('подпись флага — по правилу Павла', () => {
  // Правило: подпись говорит, что человек ПОЛУЧАЕТ. Формулировка с «не» описывает
  // отсутствие, а не приобретение, поэтому запрещена в заголовке.
  it('ни одна подпись не начинается с «не»', () => {
    for (const f of RUNTIME_FLAGS) {
      expect(f.title.trim().toLowerCase().startsWith('не '), f.title).toBe(false)
    }
  })

  it('у согласования плана подпись про решение человека, а не про имя ключа', () => {
    const f = runtimeFlagByKey('plan_approval_gate')
    expect(f.title).toContain('план')
    expect(f.what).toContain('решени')
    // Пин утверждает, что подпись НАЗЫВАЕТ состояние по умолчанию — чтобы решение
    // человека было осознанным. Само состояние переехало 30.07 (A3 §2.1): дефолт
    // теперь «включено», поэтому упоминание переехало из whenOff в what вместе с
    // ним. Утверждение то же, изменился только его адрес.
    expect(f.what).toContain('по умолчанию')
    // ДЕФОЛТ ИЗМЕНЁН ОСОЗНАННО 30.07 (A3 §2.1) — решение Павла, контракт отменён.
    // Прежнее «дефолт менять было нельзя» стерегло продуктовую логику, которая
    // сама оказалась дефектом: человек не пойдёт включать то, о чём не знает.
    // Осознанное ВЫКЛЮЧЕНИЕ по-прежнему уважается — см. plan-approval-default.
    expect(f.defaultOn, 'цикл планов снова спрятан за выключенным тумблером').toBe(true)
  })
})
