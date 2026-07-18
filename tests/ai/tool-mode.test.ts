import { describe, it, expect } from 'vitest'
import { resolveToolMode, isCoaxableProvider, JSON_TOOL_INSTRUCTION, claimsCompletedAction } from '../../electron/ai/tool-mode'

describe('resolveToolMode', () => {
  it('reasoning-модели без function calling → json', () => {
    expect(resolveToolMode('deepseek', 'deepseek-reasoner')).toBe('json')
    expect(resolveToolMode('openrouter', 'deepseek/deepseek-r1')).toBe('json')
    expect(resolveToolMode('deepseek', 'DEEPSEEK-R1-0528')).toBe('json')
  })

  it('локальный Ollama → json (native tool_calls часто не реализованы)', () => {
    expect(resolveToolMode('ollama', 'llama3.3')).toBe('json')
  })

  it('обычные chat/coder модели → native (поведение не меняется)', () => {
    expect(resolveToolMode('deepseek', 'deepseek-v4-flash')).toBe('native')
    expect(resolveToolMode('deepseek', 'deepseek-chat')).toBe('native')
    expect(resolveToolMode('qwen', 'qwen3-coder-plus')).toBe('native')
    expect(resolveToolMode('moonshot', 'kimi-k2.7-code')).toBe('native')
    expect(resolveToolMode('claude', 'claude-sonnet-4-6')).toBe('native')
    expect(resolveToolMode(undefined, undefined)).toBe('native')
  })

  it('не путает r1 внутри других имён (mistral-large ≠ r1)', () => {
    expect(resolveToolMode('mistral', 'mistral-large-latest')).toBe('native')
    expect(resolveToolMode('qwen', 'qwen3-max')).toBe('native')
  })
})

describe('isCoaxableProvider', () => {
  it('китайские/дешёвые OpenAI-compat — coaxable (нужен corrective nudge)', () => {
    expect(isCoaxableProvider('deepseek')).toBe(true)
    expect(isCoaxableProvider('qwen')).toBe(true)
    expect(isCoaxableProvider('moonshot')).toBe(true)
    expect(isCoaxableProvider('ollama')).toBe(true)
    expect(isCoaxableProvider('custom-openai')).toBe(true)
  })

  it('frontier/RU — не coaxable (надёжны, nudge дал бы ложные срабатывания)', () => {
    expect(isCoaxableProvider('claude')).toBe(false)
    expect(isCoaxableProvider('openai')).toBe(false)
    expect(isCoaxableProvider('gemini-api')).toBe(false)
    expect(isCoaxableProvider('yandex-gpt')).toBe(false)
    expect(isCoaxableProvider('gigachat')).toBe(false)
    expect(isCoaxableProvider(undefined)).toBe(false)
  })
})

describe('JSON_TOOL_INSTRUCTION', () => {
  it('содержит формат, который распознаёт parseTextToolCalls', () => {
    expect(JSON_TOOL_INSTRUCTION).toContain('<tool_call>')
    expect(JSON_TOOL_INSTRUCTION).toContain('"arguments"')
  })
})

describe('claimsCompletedAction', () => {
  // — СТРЕЛЯЕТ: модель претендует на выполненное действие (симптом DeepSeek-цикла) —
  it('завершение задачи → претензия', () => {
    expect(claimsCompletedAction('Задача выполнена.')).toBe(true)
    expect(claimsCompletedAction('Готово!')).toBe(true)
    expect(claimsCompletedAction('Всё сделано, проверь.')).toBe(true)
    expect(claimsCompletedAction('task completed')).toBe(true)
    expect(claimsCompletedAction('The task is done.')).toBe(true)
    expect(claimsCompletedAction('All done — check it.')).toBe(true)
  })

  it('действие над файлом/кодом в прошедшем/пассиве → претензия (ru + en)', () => {
    expect(claimsCompletedAction('Я создал файл config.ts')).toBe(true)
    expect(claimsCompletedAction('Готово, я создал файл config.ts.')).toBe(true)
    expect(claimsCompletedAction('Обновил src/foo.ts, добавил логирование.')).toBe(true)
    expect(claimsCompletedAction('Файл создан, патч применён.')).toBe(true)
    expect(claimsCompletedAction("I've updated the file.")).toBe(true)
    expect(claimsCompletedAction('Applied the patch to main.ts.')).toBe(true)
    expect(claimsCompletedAction('Created the config file for you.')).toBe(true)
  })

  it('диф / код-блок с путём → претензия', () => {
    expect(claimsCompletedAction('Вот изменения:\n```diff\n- a\n+ b\n```')).toBe(true)
    expect(claimsCompletedAction('```ts\n// src/foo.ts\nexport const x = 1\n```')).toBe(true)
  })

  it('претензия в первой клаузе не гасится оффером во второй (поклаузно)', () => {
    expect(claimsCompletedAction('Задача выполнена. Если хочешь, могу ещё помочь.')).toBe(true)
    expect(claimsCompletedAction('Я создал файл. Дальше можно добавить тесты, если нужно.')).toBe(true)
  })

  // — НЕ СТРЕЛЯЕТ: чистая проза, оффер, гипотеза, инструкция, будущее время —
  it('разговорный ответ (кейс Павла) → НЕ претензия', () => {
    expect(claimsCompletedAction('Я работаю через агентный цикл: читаю запрос, выбираю инструменты и объясняю ход. Какие есть вопросы?')).toBe(false)
    expect(claimsCompletedAction('Какой файл открыть?')).toBe(false)
    expect(claimsCompletedAction('')).toBe(false)
    expect(claimsCompletedAction(undefined)).toBe(false)
  })

  it('оффер / условие / гипотеза / инструкция → НЕ претензия', () => {
    expect(claimsCompletedAction('Могу создать файл, если хочешь.')).toBe(false)
    expect(claimsCompletedAction('Вот как я бы изменил этот код: ...')).toBe(false)
    expect(claimsCompletedAction('Чтобы создать файл, нужно вызвать write_file.')).toBe(false)
    expect(claimsCompletedAction('I can create the file if you want.')).toBe(false)
    expect(claimsCompletedAction('You should update the config first.')).toBe(false)
  })

  it('будущее время / намерение (не завершённое действие) → НЕ претензия', () => {
    expect(claimsCompletedAction('Сейчас прочитаю файл и поправлю его.')).toBe(false)
    expect(claimsCompletedAction('Я создам файл и добавлю туда функцию.')).toBe(false)
    expect(claimsCompletedAction("I'll update the file now.")).toBe(false)
  })
})

// Харднинг по адверсариальному ревью 18.07 (11 подтверждённых находок). Каждый кейс — прямая
// репродукция находки; вместе держат ДВА инварианта: A (разговор Павла → 0), B (анти-DeepSeek → 1).
describe('claimsCompletedAction — харднинг по адверс-ревью', () => {
  it('#1/#3 guard не гасит claim через запятую (цель/шаг/приглашение проверить)', () => {
    expect(claimsCompletedAction('Я обновил конфиг, чтобы включить логирование.')).toBe(true)
    expect(claimsCompletedAction('Я добавил тест, надо проверить.')).toBe(true)
    expect(claimsCompletedAction('Готово, можешь проверить.')).toBe(true)
    expect(claimsCompletedAction('Я обновил файл, можешь глянуть.')).toBe(true)
  })

  it('#2 самоописание «я создан / меня создали» → НЕ претензия (инвариант A)', () => {
    expect(claimsCompletedAction('Я создан на основе большой языковой модели.')).toBe(false)
    expect(claimsCompletedAction('Меня создали в компании Anthropic.')).toBe(false)
    expect(claimsCompletedAction('Я создан для работы с кодом.')).toBe(false)
  })

  it('#2 инвариант B НЕ сломан: активное «я создал файл» / «файл создан» → претензия', () => {
    expect(claimsCompletedAction('Я создал файл config.ts')).toBe(true)
    expect(claimsCompletedAction('Файл создан.')).toBe(true)
    expect(claimsCompletedAction('Файл создан, патч применён.')).toBe(true)
  })

  it('#7/#10 временно́е придаточное (описание процесса) → НЕ претензия (инвариант A)', () => {
    expect(claimsCompletedAction('Когда задача выполнена, я пишу краткий итог.')).toBe(false)
    expect(claimsCompletedAction('Когда задача выполнена, я показываю результат.')).toBe(false)
  })

  it('#8 тех-стек продукта («написан на …», «реализовано N …») → НЕ претензия (инвариант A)', () => {
    expect(claimsCompletedAction('Этот агент написан на TypeScript и Electron.')).toBe(false)
    expect(claimsCompletedAction('В системе реализовано 18 провайдеров и 5 режимов.')).toBe(false)
  })

  it('#9 получатель/фича продукта («мне добавили», «добавлено N …») → НЕ претензия (инвариант A)', () => {
    expect(claimsCompletedAction('Недавно мне добавили доступ к инструментам.')).toBe(false)
    expect(claimsCompletedAction('В последнюю версию добавлено 8 коннекторов.')).toBe(false)
  })

  it('#5/#11 частотные ru-перфективы завершения → претензия (инвариант B)', () => {
    expect(claimsCompletedAction('Настроил конфигурацию.')).toBe(true)
    expect(claimsCompletedAction('Запустил тесты, всё зелёное.')).toBe(true)
    expect(claimsCompletedAction('Установил зависимость.')).toBe(true)
    expect(claimsCompletedAction('Выполнил всё, что просил.')).toBe(true)
  })

  it('#4/#6 канонные en-завершения → претензия (инвариант B)', () => {
    expect(claimsCompletedAction('Done.')).toBe(true)
    expect(claimsCompletedAction('I completed the task.')).toBe(true)
    expect(claimsCompletedAction('I finished updating the config.')).toBe(true)
  })

  it('осознанно НЕ ловим двусмысленные en/ru (нет ложного nudge на разговоре)', () => {
    expect(claimsCompletedAction('I made a mistake earlier.')).toBe(false)   // made — не добавлен
    expect(claimsCompletedAction('I ran into an issue.')).toBe(false)        // ran — не добавлен
    expect(claimsCompletedAction("I'm not done yet.")).toBe(false)           // якорь ^done$
    expect(claimsCompletedAction('Are you done?')).toBe(false)
  })
})

// Ре-ревью раунд 2 (10 подтверждённых регрессий хардининга). Каждый кейс — прямая репродукция;
// принцип фикса: СУЖАТЬ (двусмысленные пассивы вон, guard'ы точнее), не расширять.
describe('claimsCompletedAction — ре-ревью раунд 2 (регрессии хардининга)', () => {
  it('#1/#6 двусмысленные пассивы (настроен/проверен) → НЕ претензия (инвариант A)', () => {
    expect(claimsCompletedAction('Я настроен помогать с кодом.')).toBe(false)
    expect(claimsCompletedAction('Вебхук настроен, уведомления приходят автоматически.')).toBe(false)
    expect(claimsCompletedAction('Этот подход проверен временем и надёжен.')).toBe(false)
  })

  it('#5 «я проверил …, там написано …» (Q&A / цитата) → НЕ претензия (инвариант A)', () => {
    expect(claimsCompletedAction('Я проверил документацию, там написано, что параметр называется timeout.')).toBe(false)
    expect(claimsCompletedAction('Я проверил документацию.')).toBe(false)
    expect(claimsCompletedAction('В документации написано, что таймаут по умолчанию 30 секунд.')).toBe(false)
  })

  it('активные перфективы (настроил/написал) всё ещё претензия (инвариант B)', () => {
    expect(claimsCompletedAction('Настроил вебхук.')).toBe(true)
    expect(claimsCompletedAction('Я написал функцию в utils.ts.')).toBe(true)
  })

  it('#2 «done» как элемент перечисления → НЕ; одиночное «Done.» → претензия', () => {
    expect(claimsCompletedAction('The states are: pending, done, failed.')).toBe(false)
    expect(claimsCompletedAction('Build, test, done.')).toBe(false)
    expect(claimsCompletedAction('Done.')).toBe(true)
    expect(claimsCompletedAction('All done.')).toBe(true)
  })

  it('#3/#7/#10 отчёт о правке с числом (файлы/строки) → претензия (инвариант B)', () => {
    expect(claimsCompletedAction('Обновлено 5 файлов, добавлено 12 строк.')).toBe(true)
    expect(claimsCompletedAction('Создано 2 файла.')).toBe(true)
    expect(claimsCompletedAction('Обновлено 3 файла.')).toBe(true)
  })

  it('#3/#7 перечень возможностей продукта с числом → НЕ претензия (инвариант A)', () => {
    expect(claimsCompletedAction('В системе реализовано 18 провайдеров и 5 режимов.')).toBe(false)
    expect(claimsCompletedAction('В последнюю версию добавлено 8 коннекторов.')).toBe(false)
  })

  it('#4 хвостовое «когда/после того …» после claim → претензия (инвариант B)', () => {
    expect(claimsCompletedAction('Я создал файл когда закончил рефакторинг.')).toBe(true)
    expect(claimsCompletedAction('Обновил тесты после того, как всё проверил.')).toBe(true)
  })

  it('#4 ведущее «когда …» (описание процесса) → НЕ претензия (инвариант A, не сломано)', () => {
    expect(claimsCompletedAction('Когда задача выполнена, я показываю результат.')).toBe(false)
  })

  it('#9 «я вам обновил» (подлежащее — ассистент) → претензия; «мне добавили» → НЕ', () => {
    expect(claimsCompletedAction('Я вам обновил конфиг.')).toBe(true)
    expect(claimsCompletedAction('Мне добавили доступ.')).toBe(false)
  })
})
