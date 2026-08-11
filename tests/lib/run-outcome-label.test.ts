import { describe, it, expect } from 'vitest'
import {
  detectRunOutcome, describesIncompleteWork, RUN_OUTCOME_TITLE,
} from '../../shared/contracts/run-outcome'
import { reduceAgentProgress, buildInitialAgentProgress } from '../../src/lib/agent-progress'
import { currentEntry, entryTitle } from '../../src/components/AgentProgressPanel'

/**
 * Д2 (приёмка браузера 10.08): карточка озаглавлена «Задача выполнена», а тело
 * того же ответа содержит раздел «Что НЕ доделано». Врёт не модель — она как раз
 * написала правду; врёт ярлык, который ставился по правилу «завершился без
 * ошибки». Плюс остаток Д1: прогон с НУЛЕВОЙ работой тоже закрывался как
 * «выполнена», и это верно любой причине отказа.
 *
 * Чинится СТАТУС, а не поведение агента.
 */

/** Ответ из приёмки: честный отчёт с разделом об остатке. */
const HONEST_PARTIAL = [
  'Что сделано: открыл habr.ru, нашёл поле поиска, ввёл «ai агенты».',
  '',
  '## Что НЕ доделано',
  'Форма не отправилась: кнопка отправки — иконка без подписи, а инструмента нажатия клавиш нет.',
  'Содержимое первых результатов назвать не могу — выдумывать заголовки не буду.',
].join('\n')

describe('detectRunOutcome — исход по фактам и словам самого агента', () => {
  it('агент сам назвал работу неполной → partial, а не «выполнена»', () => {
    expect(detectRunOutcome({ toolCallCount: 81, assistantText: HONEST_PARTIAL })).toBe('partial')
  })

  it('ноль вызовов и пустой ответ → no-work (остаток Д1)', () => {
    expect(detectRunOutcome({ toolCallCount: 0, assistantText: '' })).toBe('no-work')
    expect(detectRunOutcome({ toolCallCount: 0, assistantText: null })).toBe('no-work')
  })

  it('КОНТРОЛЬ: обычный разговорный ответ без инструментов — это НЕ отказ', () => {
    // «Привет» законно закрывается без единого вызова: правило про нулевую
    // работу не должно объявлять отказом каждый диалоговый ход.
    expect(detectRunOutcome({ toolCallCount: 0, assistantText: 'Привет! Чем помочь?' })).toBe('completed')
  })

  it('КОНТРОЛЬ: законченная работа остаётся «выполнена»', () => {
    const done = 'Готово: нашёл пять материалов Хабра по запросу, ссылки выше.'
    expect(detectRunOutcome({ toolCallCount: 107, assistantText: done })).toBe('completed')
  })

  it('КОНТРОЛЬ: рассказ о неудачных ПОПЫТКАХ при готовом результате не делает прогон частичным', () => {
    // Прогон приёмки, который ДОШЁЛ до результата: агент честно объявил обход
    // («сам поиск через UI-форму не отправлялся, поэтому использовал RSS»), но
    // задачу закрыл. Назвать это «сделано частично» — обесценить готовый ответ.
    const withDetour = [
      'Первые пять материалов Хабра по запросу «ai агенты»: …',
      'Оговорка: поиск через UI-форму не отправлялся, поэтому я использовал официальный RSS-поиск — тот же движок, те же результаты.',
    ].join('\n')
    expect(detectRunOutcome({ toolCallCount: 107, assistantText: withDetour })).toBe('completed')
  })

  // В3 (живой кейс Павла 11.08 09:35): агент написал «до конца задачу не довёл —
  // упёрся в ограничение», предложил варианты и задал вопрос, а карточка сверху —
  // «Задача выполнена». Прежние маркеры ловили «Что НЕ доделано», но не эту
  // формулировку. Расширение осторожное: фразы — про САМ результат.
  it('В3: «до конца задачу не довёл — упёрся в ограничение» → partial', () => {
    const live = [
      'Открыл выдачу, но до конца задачу не довёл — упёрся в ограничение встроенного браузера.',
      'Варианты: 1) открыть страницу в обычном браузере, 2) дать доступ к web_fetch. Как поступим?',
    ].join('\n')
    expect(detectRunOutcome({ toolCallCount: 42, assistantText: live })).toBe('partial')
  })

  it('В3: «не удалось получить …» и «не вижу результатов» — отказ о результате', () => {
    expect(describesIncompleteWork('Не удалось получить содержимое выдачи: страница осталась пустой.')).toBe(true)
    expect(describesIncompleteWork('Поиск отправил, но не вижу результатов на странице.')).toBe(true)
  })

  it('В3-КОНТРОЛЬ: полный ответ + вопрос в конце — по-прежнему «выполнена»', () => {
    // Вопрос пользователю сам по себе НЕ признак частичности: агент может
    // спрашивать «что дальше?» после полного результата.
    const full = 'Готово: сумма по всем счетам — $1 240, таблица выше. Перевести в рубли?'
    expect(detectRunOutcome({ toolCallCount: 9, assistantText: full })).toBe('completed')
  })

  it('describesIncompleteWork читает и раздел, и оговорку в тексте', () => {
    expect(describesIncompleteWork('## Что осталось\n— отправить форму')).toBe(true)
    expect(describesIncompleteWork('Задача не выполнена: сайт недоступен.')).toBe(true)
    expect(describesIncompleteWork('Всё готово, проверил тестами.')).toBe(false)
    expect(describesIncompleteWork('')).toBe(false)
  })
})

describe('Д2: карточка прогона повторяет исход, а не обещает выполнение', () => {
  /** Лента завершённого прогона с заданным исходом. */
  function finishedRun(outcome?: string) {
    let progress = buildInitialAgentProgress('найди на хабре ai агентов')
    progress = reduceAgentProgress(progress, { type: 'text', text: 'отвечаю' })
    return reduceAgentProgress(progress, outcome ? { type: 'done', outcome } : { type: 'done' })
  }

  it('частичный исход озаглавлен честно — «Задача выполнена» не показывается', () => {
    const progress = finishedRun('partial')
    const current = currentEntry(progress, false)!

    expect(entryTitle(current, false)).toBe(RUN_OUTCOME_TITLE.partial)
    expect(entryTitle(current, false)).not.toBe('Задача выполнена')
  })

  it('нулевая работа озаглавлена как невыполненная (остаток Д1)', () => {
    const progress = finishedRun('no-work')
    const current = currentEntry(progress, false)!

    expect(entryTitle(current, false)).toBe(RUN_OUTCOME_TITLE['no-work'])
  })

  it('КОНТРОЛЬ: успешный прогон по-прежнему озаглавлен «Задача выполнена»', () => {
    // Иначе «починкой» было бы снятие ярлыка вообще — человек перестал бы
    // видеть, что работа закончена.
    for (const progress of [finishedRun('completed'), finishedRun()]) {
      const current = currentEntry(progress, false)!
      expect(entryTitle(current, false)).toBe('Задача выполнена')
    }
  })

  it('финал — САМАЯ ПОЗДНЯЯ запись ленты, иначе шапка покажет живой шаг вместо итога', () => {
    // Пин на первопричину, а не на её симптом. Пока finishRunning брал своё
    // время, между ним и меткой записи 'done' могла смениться миллисекунда —
    // закрытые шаги оказывались НОВЕЕ финала, и заголовок карточки зависел от
    // того, успел ли тик смениться. Тест выше ловил это через раз и выглядел
    // недетерминированным; недетерминированным было поведение (§3.1).
    let progress = buildInitialAgentProgress('найди на хабре ai агентов')
    progress = reduceAgentProgress(progress, { type: 'text', text: 'отвечаю' })
    progress = reduceAgentProgress(progress, { type: 'done', outcome: 'partial' })

    const done = progress.find(e => e.id === 'done')!
    for (const entry of progress) {
      expect(entry.timestamp, `шаг «${entry.title}» новее финала — шапка покажет его`).toBeLessThanOrEqual(done.timestamp)
    }
  })

  it('ЗАЩИТА В ГЛУБИНУ: даже если живой шаг оказался новее, шапка берёт финал', () => {
    // Зеркальный случай, собранный руками: лента, в которой 'final' новее 'done'.
    // Продукт такой больше не порождает, но currentEntry обязан быть устойчив —
    // иначе один недосмотр во времени снова вернёт «Пишу видимый ответ» в шапку.
    const skewed = [
      { id: 'final', phase: 'final' as const, title: 'Пишу видимый ответ', status: 'done' as const, timestamp: 99 },
      { id: 'done', phase: 'final' as const, title: RUN_OUTCOME_TITLE.partial, status: 'done' as const, timestamp: 99 },
    ]
    expect(currentEntry(skewed, false)?.id).toBe('done')
  })

  it('КОНТРОЛЬ: пока прогон ИДЁТ, шапка показывает живой шаг, а не ярлык исхода', () => {
    // Финала ещё не было — исход неизвестен, и обещать его нечем. Иначе правка
    // выродилась бы в «всегда показывать итог», в том числе посреди работы.
    let progress = buildInitialAgentProgress('найди на хабре ai агентов')
    progress = reduceAgentProgress(progress, { type: 'text', text: 'отвечаю' })

    const current = currentEntry(progress, true)!

    expect(current.status).toBe('running')
    expect(entryTitle(current, true)).toBe('Пишу видимый ответ')
  })
})
