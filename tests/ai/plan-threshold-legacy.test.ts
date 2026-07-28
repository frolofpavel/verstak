// §4.2, живой порог на ЛЕГАСИ-ПУТИ (28.07).
//
// ДЕФЕКТ, найденный ранее и записанный пином с честным комментарием: порог
// требовал structured spec у ВСЕХ шагов, `parsePlanStepSpec` отдаёт значение
// только при нуле диагностик по всем шестнадцати полям, а описание `create_plan`
// прямо разрешает планам spec не передавать (tools.ts). Значит fail-safe «нет
// объявления → карточка» вырождался: при включённом тумблере карточка вылезала на
// КАЖДЫЙ многошаговый план, включая читающий, и ломала третье правило §1 ТЗ —
// «вопрос отвечается без единого клика».
//
// ВТОРАЯ ПРИЧИНА, найденная при разборе: даже когда модель spec ПРИСЫЛАЛА,
// чат-путь его не видел. `createPlanHandler` заполняет `specs` только внутри
// `if (ctx.outcome)`, а порогу отдавал `specs[index] ?? null` — то есть на
// чат-пути всегда null. Одного текстового вывода мало: сначала надо перестать
// выбрасывать то, что модель уже объявила.
//
// ЧТО ЗАКРЕПЛЕНО. Читающий план без spec автоутверждается; пишущий — нет;
// неопределимый по-прежнему даёт карточку (fail-safe не ослаблен: неизвестное не
// равно безопасному, сомнение = пишет).
import { describe, it, expect } from 'vitest'
import { planApprovalVerdict } from '../../electron/ai/plan-threshold'

/** Сценарий 3 ТЗ: «Что лежит в папке проекта и что из этого устарело?» */
const READING_PLAN = [
  { title: 'Прочитать файлы проекта', detail: 'Просмотреть src/ и собрать список модулей.' },
  { title: 'Проанализировать зависимости', detail: 'Сравнить package.json с фактическими импортами.' },
  { title: 'Ответить в чате', detail: 'Сформулировать вывод: что устарело и почему.' },
]

/** Тот же по форме план, но пишущий (сценарий 2 ТЗ). */
const WRITING_PLAN = [
  { title: 'Прочитать файлы проекта', detail: 'Просмотреть src/ и собрать список модулей.' },
  { title: 'Записать лендинг', detail: 'Создать src/index.html с блоками про натяжные потолки.' },
]

describe('§4.2 на легаси-пути: план без structured spec', () => {
  it('читающий многошаговый план БЕЗ spec автоутверждается — ни одного клика', () => {
    const v = planApprovalVerdict(READING_PLAN)
    expect(v.needsCard, 'карточка на чтении ломает правило «вопрос без клика»').toBe(false)
    expect(v.reason).toBeNull()
  })

  it('пишущий план БЕЗ spec даёт карточку', () => {
    const v = planApprovalVerdict(WRITING_PLAN)
    expect(v.needsCard).toBe(true)
    expect(v.reason).toBe('write-scope')
    expect(v.triggeredBy).toContain('Записать лендинг')
  })

  it('ответственное действие в тексте без spec узнаётся ИМЕННО как ответственное', () => {
    const v = planApprovalVerdict([
      { title: 'Прочитать список клиентов', detail: 'Открыть выгрузку.' },
      { title: 'Отправить письма клиентам', detail: 'Разослать приглашения.' },
    ])
    expect(v.needsCard).toBe(true)
    expect(v.reason, 'до фикса это глохло в общем no-declaration').toBe('responsible-action')
  })

  // КОНТРОЛЬНЫЙ КЕЙС FAIL-SAFE. Без него первый тест был бы зелёным просто от
  // того, что порог разучился требовать карточку.
  it('шаг, про который решить нельзя, по-прежнему даёт карточку', () => {
    const v = planApprovalVerdict([{ title: 'Что-то сделать' }])
    expect(v.needsCard).toBe(true)
    expect(v.reason).toBe('no-declaration')
  })

  it('читающий план с ОДНИМ неопределимым шагом — карточка (сомнение = пишет)', () => {
    const v = planApprovalVerdict([...READING_PLAN, { title: 'Разобраться с остальным' }])
    expect(v.needsCard).toBe(true)
    expect(v.reason).toBe('no-declaration')
  })
})

describe('§4.2: spec, присланный моделью на чат-пути, больше не выбрасывается', () => {
  const rawSpec = (patch: Record<string, unknown>) => ({
    key: 's1', title: 'Шаг', intent: 'Сделать', files: [], symbols: [], actions: [],
    dependsOn: [], readScope: ['src'], writeScope: [], acceptanceCriterionIds: [],
    verification: [], expectedEvidence: [], rollback: '', role: 'executor',
    execution: 'main', risk: 'low', ...patch,
  })

  it('объявленный writeScope в СЫРОМ spec даёт карточку', () => {
    const v = planApprovalVerdict([{ title: 'Шаг', rawSpec: rawSpec({ writeScope: ['src/index.html'] }) }])
    expect(v.needsCard).toBe(true)
    expect(v.reason).toBe('write-scope')
  })

  it('пустой writeScope в сыром spec + читающий текст → автоутверждение', () => {
    const v = planApprovalVerdict([{ title: 'Прочитать конфиг', rawSpec: rawSpec({}) }])
    expect(v.needsCard).toBe(false)
  })

  it('высокий риск в сыром spec даёт карточку', () => {
    const v = planApprovalVerdict([{ title: 'Прочитать конфиг', rawSpec: rawSpec({ risk: 'high' }) }])
    expect(v.needsCard).toBe(true)
    expect(v.reason).toBe('high-risk')
  })

  // Дыра, которую закрываем сознательно: spec БЕЗ writeScope (опечатка в имени
  // поля, обрезанный объект) не должен читаться как «писать некуда».
  it('сырой spec без writeScope судится текстом, а не считается безопасным', () => {
    const noScope = { key: 's1', intent: 'Сделать', actions: [] }
    expect(planApprovalVerdict([{ title: 'Что-то сделать', rawSpec: noScope }]).needsCard).toBe(true)
    expect(planApprovalVerdict([{ title: 'Прочитать конфиг', rawSpec: noScope }]).needsCard).toBe(false)
  })

  it('мусор вместо spec не ломает разбор и не выдаётся за объявление', () => {
    for (const junk of [null, 'строка', 42, [], { writeScope: 'не массив' }]) {
      expect(planApprovalVerdict([{ title: 'Что-то сделать', rawSpec: junk }]).needsCard).toBe(true)
    }
  })
})

// ДОЛГ РЕВЬЮ 28.07, пункты 1, 2 и 5 — закрыты здесь.
describe('долг: пробелы в признаках записи закрыты', () => {
  const step = (title: string, detail?: string) => ({ title, detail: detail ?? null })

  it('починка и правка — это ЗАПИСЬ, а не неопределимость', () => {
    for (const t of [
      'Исправить опечатку в src/app.ts',
      'Починить сборку',
      'Поправить отступы в layout.css',
      'Убрать мёртвый код',
      'Заменить старый логотип',
      'Fix broken import',
      'Refactor the loader',
      'Remove unused export',
    ]) {
      const v = planApprovalVerdict([step(t)])
      expect(v.needsCard, t).toBe(true)
      expect(v.reason, t).toBe('write-scope')
    }
  })

  // ГЛАВНЫЙ пин пункта 1: раньше один читающий глагол рядом выводил пишущий шаг
  // из-под fail-safe целиком — «посмотреть и поправить» проезжало как чтение.
  it('читающий глагол рядом с пишущим НЕ выводит шаг из-под проверки', () => {
    const v = planApprovalVerdict([
      step('Посмотреть логи и поправить конфиг', 'Открыть logs/app.log и исправить config.json'),
    ])
    expect(v.needsCard, 'признак записи обязан перевешивать признак чтения').toBe(true)
    expect(v.reason).toBe('write-scope')
  })

  it('пустой writeScope в сыром spec НЕ перебивает собственные actions', () => {
    const contradictory = {
      key: 's1', intent: 'Записать лендинг', actions: ['Создать src/index.html'],
      writeScope: [], readScope: ['src'],
    }
    const v = planApprovalVerdict([{ title: 'Шаг', rawSpec: contradictory }])
    expect(v.needsCard, 'объявление «пишу никуда» при действии «создать файл» проехало как чтение').toBe(true)
    expect(v.reason).toBe('write-scope')
  })

  it('непротиворечивый частичный spec по-прежнему автоутверждается', () => {
    const honest = {
      key: 's1', intent: 'Посчитать итог', actions: ['Прочитать выгрузку'],
      writeScope: [], readScope: ['data'],
    }
    expect(planApprovalVerdict([{ title: 'Прочитать данные', rawSpec: honest }]).needsCard).toBe(false)
  })
})

// ДОЛГ, пункт 5: READING_PLAN этого файла был подобран в обход WRITE_HINTS —
// проверить это можно только на формулировках, которых человек напишет сам.
describe('долг: читающий план узнаётся на естественных формулировках', () => {
  it('обычные читающие задачи автоутверждаются', () => {
    const plans = [
      [
        { title: 'Изучить структуру проекта', detail: 'Просмотреть src/components и перечислить модули.' },
        { title: 'Объяснить, что устарело', detail: 'Сравнить с package.json и сформулировать вывод.' },
      ],
      [
        { title: 'Проанализировать рекламные кампании', detail: 'Прочитать выгрузку data/ads.csv и посчитать расход.' },
        { title: 'Ответить в чате', detail: 'Сформулировать вывод по data/ads.csv для клиента.' },
      ],
    ]
    for (const plan of plans) {
      const v = planApprovalVerdict(plan)
      expect(v.needsCard, JSON.stringify(plan.map(s => s.title))).toBe(false)
    }
  })
})
