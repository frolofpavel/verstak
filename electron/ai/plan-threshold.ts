/**
 * Порог показа карточки согласования (ТЗ VSK-TASK-FLOW-A1, §4.2).
 *
 * Правило 3 цикла: чтение не требует утверждения. План, который только читает и
 * отвечает, автоутверждается — карточка не показывается, пользователь просто
 * получает ответ. Карточка появляется, когда план объявил запись файлов,
 * изменения во внешних системах или ответственное действие.
 *
 * ЧЕГО ЭТОТ МОДУЛЬ НЕ ДЕЛАЕТ — и это главное. Порог считается по тому, что
 * модель САМА объявила в плане. Модель может ошибиться или соврать: назвать
 * пишущий шаг читающим. Поэтому автоутверждение снимает КАРТОЧКУ и только её —
 * оно НЕ выдаёт прав на запись. Фактическая попытка записи всё равно проходит
 * через `mode-policy.decide()` в общем порядке. Неверная самооценка модели даёт
 * лишний вопрос пользователю, а не тихую запись.
 *
 * Fail-safe: если про шаг решить нельзя, считаем, что карточка НУЖНА.
 * Неизвестное — не то же самое, что безопасное; сомнение = пишет.
 *
 * ЖИВОЙ ПОРОГ НА ЛЕГАСИ-ПУТИ (28.07). Раньше «нельзя решить» означало «нет
 * полного structured spec», и порог вырождался: `parsePlanStepSpec` отдаёт
 * значение только при нуле диагностик по всем шестнадцати полям, а описание
 * `create_plan` прямо разрешает планам spec не передавать. При включённом
 * тумблере карточка вылезала на КАЖДЫЙ многошаговый план, включая читающий, —
 * то есть ломала третье правило §1 ТЗ («вопрос отвечается без единого клика»).
 *
 * Теперь у шага три источника суждения, в порядке доверия:
 *   1) полный spec — объявление модели как есть (прежнее поведение);
 *   2) СЫРОЙ spec, разобранный частично — только те поля, по которым судит порог.
 *      Партиальность живёт ТОЛЬКО здесь и никуда не протекает: outcome-путь и
 *      quality-гейт по-прежнему требуют полного разбора через parsePlanStepSpec;
 *   3) текст шага — консервативный вывод: признак записи перевешивает признак
 *      чтения, а отсутствие обоих оставляет шаг неопределимым (карточка).
 *
 * Инвариант безопасности не изменился ни на йоту: автоутверждение снимает
 * КАРТОЧКУ и не выдаёт прав на запись.
 */

import type { PlanStepSpecV1 } from '../../shared/contracts/outcome'

/** Что именно потребовало карточку — для человеческого объяснения и логов. */
export type PlanApprovalReason =
  | 'write-scope'
  | 'responsible-action'
  | 'high-risk'
  | 'no-declaration'

export interface PlanApprovalVerdict {
  /** true — показать карточку согласования; false — автоутвердить без карточки. */
  needsCard: boolean
  reason: PlanApprovalReason | null
  /** Ключи/номера шагов, которые дали срабатывание. Для объяснения, не для логики. */
  triggeredBy: string[]
}

/**
 * Ответственные действия (правило 2 цикла): платёж, отправка другому человеку,
 * публикация, удаление данных, изменение прав доступа.
 *
 * У русских альтернатив НЕТ ``: в JS граница слова определена по ASCII, и
 * `отправ` не совпадает с «Отправить» — проверено падающим тестом.
 *
 * Список намеренно избыточен и включает англоязычные формы: шаги пишет модель, и
 * язык формулировки заранее неизвестен. Ложное срабатывание стоит одного лишнего
 * вопроса, пропуск — необратимого действия без спроса.
 */
const RESPONSIBLE_HINTS: readonly string[] = [
  // платёж
  'оплат', 'платеж', 'платёж', 'перевод', 'payment', 'invoice', 'charge',
  // отправка другому человеку
  'отправ', 'разосл', 'рассыл', 'письм', 'уведомлени', 'send', 'email', 'notify',
  // публикация
  'опублик', 'публикац', 'выложи', 'publish', 'deploy', 'release',
  // удаление данных
  'удал', 'очист', 'снос', 'delete', 'remove', 'purge', 'truncate', 'drop table',
  // права доступа
  'права доступа', 'разрешени', 'permission', 'access control', 'grant', 'revoke',
]

/**
 * Подстрочный поиск, а не регулярка. Причина конкретная: в JS граница слова
 * определена по ASCII, поэтому шаблон с ней НЕ совпадает с «Отправить» — на этом
 * уже поймал себя падающий тест. Смешивать в одном шаблоне кириллицу без границ
 * и латиницу с границами оказалось хрупко; простое includes по нижнему регистру
 * ведёт себя предсказуемо в обоих языках.
 */
function mentionsResponsible(text: string): boolean {
  const hay = text.toLowerCase()
  return RESPONSIBLE_HINTS.some(hint => hay.includes(hint))
}

/**
 * Признаки ИЗМЕНЕНИЯ мира — для шагов, у которых объявления нет вовсе.
 * Список намеренно шире буквальной записи файла: запуск команды и установка
 * пакета тоже меняют состояние, и ошибка в эту сторону стоит лишнего вопроса,
 * а в обратную — тихой правки. Подстрочный поиск по тем же причинам, что у
 * RESPONSIBLE_HINTS (граница слова в JS — ASCII, «Записать» её не даёт).
 */
const WRITE_HINTS: readonly string[] = [
  'запис', 'созда', 'измен', 'правк', 'отредакт', 'редактир', 'обнов', 'перепиш', 'перезапиш',
  'сгенерир', 'сохран', 'установ', 'запуст', 'выполн команд', 'коммит', 'закоммит', 'деплой',
  'мигра', 'переимен', 'настро', 'внедр', 'добав',
  'write', 'create', 'modify', 'update', 'edit', 'generate', 'save', 'install',
  'commit', 'patch', 'apply', 'rewrite', 'rename', 'migrat', 'scaffold',
]

/**
 * Признаки ЧТЕНИЯ. Нужны как ПОЛОЖИТЕЛЬНОЕ доказательство: без него шаг остаётся
 * неопределимым и получает карточку. Отсутствие признака записи само по себе
 * основанием не является — иначе пустой заголовок проезжал бы как чтение.
 */
const READ_HINTS: readonly string[] = [
  'прочит', 'прочесть', 'читать', 'посмотр', 'изуч', 'проанализ', 'анализ', 'сравн',
  'найд', 'поиск', 'поищ', 'посчит', 'подсчит', 'оцен', 'объясн', 'ответ', 'сводк',
  'просмотр', 'перечисл', 'собрать список', 'сформулир',
  'read', 'list', 'search', 'analyz', 'inspect', 'review', 'summar', 'explain',
  'compare', 'count', 'audit', 'diagnose',
]
// СОЗНАТЕЛЬНО НЕ ВКЛЮЧЕНЫ «разобраться», «выяснить», «уточнить»: это не
// доказательство чтения, а расплывчатое намерение — за ним одинаково часто идёт
// и правка. Поймано собственным тестом: «Разобраться с остальным» проезжало как
// чтение и автоутверждало план. Сомнение = пишет = карточка.

const mentionsAny = (text: string, hints: readonly string[]): boolean => {
  const hay = text.toLowerCase()
  return hints.some(hint => hay.includes(hint))
}

/** Шаг в том виде, в котором его отдал `create_plan`. */
export interface DeclaredStep {
  title: string
  detail?: string | null
  spec?: PlanStepSpecV1 | null
  /**
   * Spec, присланный моделью, но НЕ прошедший полный разбор. На чат-пути это
   * единственный вид объявления: `createPlanHandler` заполняет `specs` только
   * внутри `if (ctx.outcome)`, поэтому раньше объявление модели здесь просто
   * выбрасывалось, а порог судил по пустоте.
   */
  rawSpec?: unknown
}

/** Ровно те поля объявления, по которым судит порог. Больше ему не нужно. */
interface DeclaredView {
  writeScope: string[]
  actions: string[]
  intent: string
  risk: string | null
  key: string | null
}

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/**
 * Частичный разбор сырого spec. Судить по нему можно ТОЛЬКО если объявлен
 * `writeScope` массивом: это и есть заявление «пишу вот сюда» либо «никуда».
 * Без него объект нам ничего не сказал (обрезан, опечатка в имени поля), и шаг
 * уходит на текстовый вывод — иначе дыра: сломанное объявление читалось бы как
 * «писать некуда».
 */
function partialView(raw: unknown): DeclaredView | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.writeScope)) return null
  return {
    writeScope: stringsOf(obj.writeScope),
    actions: stringsOf(obj.actions),
    intent: typeof obj.intent === 'string' ? obj.intent : '',
    risk: typeof obj.risk === 'string' ? obj.risk : null,
    key: typeof obj.key === 'string' ? obj.key : null,
  }
}

/** Объявление шага: полный spec сильнее частичного, частичный — сильнее текста. */
function viewOf(step: DeclaredStep): DeclaredView | null {
  if (step.spec) {
    return {
      writeScope: step.spec.writeScope ?? [],
      actions: step.spec.actions ?? [],
      intent: step.spec.intent ?? '',
      risk: step.spec.risk ?? null,
      key: step.spec.key ?? null,
    }
  }
  return partialView(step.rawSpec)
}

/**
 * Нужна ли карточка согласования для плана.
 *
 * @param steps шаги в объявленном моделью виде.
 * @param hasStructuredSpecs есть ли у плана structured spec вообще. Если нет —
 *        судить не по чему, и мы честно требуем карточку.
 */
export function planApprovalVerdict(steps: readonly DeclaredStep[]): PlanApprovalVerdict {
  if (steps.length === 0) {
    return { needsCard: true, reason: 'no-declaration', triggeredBy: [] }
  }

  // Разбираем каждый шаг ОДИН раз: объявление (полное или частичное), текст для
  // текстовых проверок и вывод «пишет / читает / неопределим».
  const judged = steps.map((s, i) => {
    const view = viewOf(s)
    const haystack = [s.title, s.detail ?? '', view?.intent ?? '', ...(view?.actions ?? [])].join(' \n ')
    // Объявленный writeScope сильнее текста: порог считается по тому, что модель
    // САМА объявила (текст остаётся судьёй только там, где объявления нет).
    const writes = view ? view.writeScope.length > 0 : mentionsAny(haystack, WRITE_HINTS)
    const reads = view ? true : mentionsAny(haystack, READ_HINTS)
    return {
      label: view?.key || s.title || `шаг ${i + 1}`,
      writes,
      responsible: mentionsResponsible(haystack),
      highRisk: view?.risk === 'high',
      // Неопределим = объявления нет И текст молчит в обе стороны.
      unknown: !view && !writes && !reads,
    }
  })

  const pick = (predicate: (j: typeof judged[number]) => boolean) => judged.filter(predicate).map(j => j.label)

  // Порядок причин прежний: запись → ответственное действие → высокий риск →
  // неопределимость. Он же зафиксирован пинами `reason`.
  const writers = pick(j => j.writes)
  if (writers.length > 0) return { needsCard: true, reason: 'write-scope', triggeredBy: writers }

  const responsible = pick(j => j.responsible)
  if (responsible.length > 0) return { needsCard: true, reason: 'responsible-action', triggeredBy: responsible }

  const risky = pick(j => j.highRisk)
  if (risky.length > 0) return { needsCard: true, reason: 'high-risk', triggeredBy: risky }

  const unknown = pick(j => j.unknown)
  if (unknown.length > 0) return { needsCard: true, reason: 'no-declaration', triggeredBy: unknown }

  return { needsCard: false, reason: null, triggeredBy: [] }
}

/** Человеческое объяснение вердикта — для результата инструмента и журнала. */
export function explainVerdict(v: PlanApprovalVerdict): string {
  if (!v.needsCard) return 'План только читает и отвечает — согласование не требуется.'
  const what = v.triggeredBy.length > 0 ? ` (${v.triggeredBy.join(', ')})` : ''
  switch (v.reason) {
    case 'write-scope': return `План изменяет файлы${what} — нужно согласование.`
    case 'responsible-action': return `План содержит ответственное действие${what} — нужно согласование.`
    case 'high-risk': return `План содержит шаг высокого риска${what} — нужно согласование.`
    case 'no-declaration': return 'План не объявил, что именно делает, — нужно согласование.'
    // needsCard=true без причины невозможен по построению, но молчать нельзя:
    // такой вердикт означает баг выше, и человеку нужен внятный текст.
    case null: return 'Согласование требуется.'
  }
}
