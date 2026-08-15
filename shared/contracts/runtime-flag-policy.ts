/**
 * Полярность рантайм-флагов — ОДНА точка на main и renderer (A3 §2.1).
 *
 * ПОЧЕМУ ЭТО ЗДЕСЬ, А НЕ В ДВУХ КОПИЯХ. До 30.07 полярность жила в двух местах:
 * поле `defaultOn` таблицы renderer и выражение сравнения в main
 * (`getSecret(k) === 'true'` либо `!== 'false'`). Их держали синхронно руками и
 * стерегли анти-дрейф тестом, потому что `CLAUDE.md` §5 утверждал: shared-модуля
 * нет из-за контекст-изоляции. Утверждение неверно — `shared/` существует и
 * импортируется обоими слоями, — и оно направляло работу: дубли годами
 * поддерживали вместо того, чтобы устранить.
 *
 * Особенно дорого расхождение стоит при СМЕНЕ полярности: перевернуть дефолт
 * только в декларации значит показать человеку «включено», пока main продолжает
 * читать «выключено». Тесты при этом зелёные, а тумблер врёт.
 *
 * Модуль намеренно без зависимостей: его импортируют и слой политики, и
 * интерфейс.
 */

/** Включён ли флаг при таком сохранённом значении.
 *
 *  `defaultOn = true` (opt-out): выключает ТОЛЬКО явная строка 'false' — значит
 *  переворот дефолта сам по себе уважает осознанный выбор человека, у которого
 *  в настройках уже лежит 'false'. Ничего мигрировать не нужно.
 *  `defaultOn = false` (opt-in): включает только явная строка 'true'. */
export function isFlagOn(defaultOn: boolean, stored: string | null | undefined): boolean {
  return defaultOn ? stored !== 'false' : stored === 'true'
}

/** Что записать в настройки, чтобы флаг оказался в нужном состоянии. */
export function flagValue(on: boolean): string {
  return on ? 'true' : 'false'
}

/** Ключи рантайм-флагов (вкладка «Поведение агента»). Список живёт здесь, потому
 *  что его читают ОБА слоя: main — чтобы прочесть флаг, renderer — чтобы его
 *  показать. */
export type RuntimeFlagKey =
  | 'memory_lifecycle'
  | 'auto_capture_memory'
  | 'smart_routing'
  | 'smart_fallback'
  | 'use_project_brain'
  | 'plan_approval_gate'
  | 'orchestrator_default'
  | 'mutation_check_enabled'

/**
 * ЕДИНСТВЕННОЕ место, где объявлена полярность каждого флага (15.08, §3.1
 * ревизии). До этого дня формула жила в трёх редакциях: здесь, в таблице
 * renderer (`src/lib/runtime-flags.ts`) и в каждой точке чтения main отдельным
 * сравнением строки. Значения совпадали, но принцип — нет: модуль «одной правды»
 * был заведён 30.07 ровно чтобы убить дубль, а снаружи его не звал никто, и
 * дубль спокойно жил дальше под присмотром анти-дрейф-теста.
 *
 * Теперь расходиться нечему: main зовёт `runtimeFlagOn(key, stored)`, renderer
 * берёт `defaultOn` отсюда же. Страж превратился из сверки двух редакций в
 * проверку, что чтение флага НЕ ИСЧЕЗЛО и что сравнение строки не завелось заново
 * (`tests/lib/runtime-flags.test.ts`).
 *
 * `true` — opt-out (выключает только явная 'false'), `false` — opt-in (включает
 * только явная 'true'). Смена значения здесь меняет поведение продукта у всех,
 * кто тумблер не трогал: дефолты под пинами в том же тесте.
 */
export const RUNTIME_FLAG_DEFAULT_ON: Record<RuntimeFlagKey, boolean> = {
  memory_lifecycle: true,
  use_project_brain: true,
  smart_routing: true,
  smart_fallback: true,
  // opt-in — решение Павла от 26.07 (2.1.13): сырой автозахват засорял память.
  auto_capture_memory: false,
  // opt-out с 30.07 (A3 §2.1): цикл планов работает по умолчанию.
  plan_approval_gate: true,
  orchestrator_default: true,
  mutation_check_enabled: true,
}

/** Включён ли флаг по ключу и сохранённому значению — вход для main. */
export function runtimeFlagOn(key: RuntimeFlagKey, stored: string | null | undefined): boolean {
  return isFlagOn(RUNTIME_FLAG_DEFAULT_ON[key], stored)
}

/**
 * Согласование плана перед работой (`plan_approval_gate`).
 *
 * С 30.07 opt-out: цикл планов работает ПО УМОЛЧАНИЮ. Прежде тумблер был
 * выключен, и это была неверная продуктовая логика — человек не пойдёт включать
 * то, о чём не знает, и не откроет раздел, про который не слышал.
 *
 * Константа существует, чтобы main не сравнивал строку сам: одно место на оба
 * слоя, и анти-дрейф стеречь больше нечего. С 15.08 она — псевдоним записи в
 * RUNTIME_FLAG_DEFAULT_ON, чтобы у полярности не осталось второй редакции даже
 * здесь.
 */
export const PLAN_APPROVAL_GATE_DEFAULT_ON = RUNTIME_FLAG_DEFAULT_ON.plan_approval_gate

/** Включено ли согласование плана при таком сохранённом значении. */
export function isPlanApprovalGateOn(stored: string | null | undefined): boolean {
  return isFlagOn(PLAN_APPROVAL_GATE_DEFAULT_ON, stored)
}
