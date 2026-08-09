// Фикстуры под пять классов задач из ТЗ Agent Runtime V2 (§5): существующий набор
// закрывал «разобраться в незнакомой части» (lsp-navigation) и частично «найти
// причину бага», но не имел ни одного многофайлового сценария, ни написания
// функции с нуля, ни регрессии от собственной правки. Стиль тот же, что в core.mjs:
// детерминированный оракул в verify-скрипте, защищённые файлы, малый maxTurns.

export const TASK_CLASS_FIXTURES = Object.freeze([
  {
    // Класс «найти причину бага»: задача НЕ называет виновный файл — диагноз
    // и есть работа. Оракул запрещает компенсирующие правки в соседях конвейера.
    id: 'diagnose-root-cause',
    fixtureVersion: 1,
    suite: 'core',
    category: 'diagnose-root-cause',
    recipe: 'bugfix',
    maxTurns: 10,
    expectedFiles: ['normalize.mjs'],
    unrelatedFiles: ['parse.mjs', 'format.mjs', 'pipeline.test.mjs'],
    verify: ['npm run test:fast'],
    requiresReview: false,
    task: 'npm run test:fast падает: конвейер parse → normalize → format теряет данные. Найди, какой шаг виноват, и почини его минимальным диффом. Тест pipeline.test.mjs и остальные шаги конвейера не менять. Прогони npm run test:fast до зелёного.',
    scripts: {
      type: 'node pipeline.test.mjs',
      'test:fast': 'node pipeline.test.mjs',
      test: 'node pipeline.test.mjs',
    },
    files: {
      'parse.mjs': 'export function parse(raw) {\n  return raw.split(",").map(s => s.trim())\n}\n',
      'normalize.mjs': 'export function normalize(items) {\n  return items.slice(0, -1).map(s => s.toLowerCase())\n}\n',
      'format.mjs': 'export function format(items) {\n  return items.join("|")\n}\n',
      'pipeline.test.mjs': [
        "import { strict as assert } from 'node:assert';",
        "import { readFileSync } from 'node:fs';",
        "import { parse } from './parse.mjs';",
        "import { normalize } from './normalize.mjs';",
        "import { format } from './format.mjs';",
        "assert.equal(format(normalize(parse('A, B, C'))), 'a|b|c');",
        "if (readFileSync('parse.mjs', 'utf8') !== 'export function parse(raw) {\\n  return raw.split(\",\").map(s => s.trim())\\n}\\n') throw new Error('parse.mjs changed: fix the guilty step, not its neighbours');",
        "if (readFileSync('format.mjs', 'utf8') !== 'export function format(items) {\\n  return items.join(\"|\")\\n}\\n') throw new Error('format.mjs changed: fix the guilty step, not its neighbours');",
        "console.log('tests ok');",
        '',
      ].join('\n'),
    },
  },
  {
    // Класс «маленькая функция»: написать с нуля по готовым тестам, а не править готовое.
    id: 'small-function',
    fixtureVersion: 1,
    suite: 'core',
    category: 'small-function',
    recipe: 'small-edit',
    maxTurns: 9,
    expectedFiles: ['slugify.mjs'],
    unrelatedFiles: ['slugify.test.mjs'],
    verify: ['npm run test:fast'],
    requiresReview: false,
    task: 'Напиши функцию slugify в slugify.mjs по тестам из slugify.test.mjs: нижний регистр, пробелы и подчёркивания в дефисы, прочие не-буквенно-цифровые символы удалить, дефисы не дублировать и не оставлять по краям. Тест не менять. Прогони npm run test:fast.',
    scripts: {
      type: 'node slugify.test.mjs',
      'test:fast': 'node slugify.test.mjs',
      test: 'node slugify.test.mjs',
    },
    files: {
      'slugify.mjs': 'export function slugify(text) {\n  throw new Error("not implemented")\n}\n',
      'slugify.test.mjs': [
        "import { strict as assert } from 'node:assert';",
        "import { slugify } from './slugify.mjs';",
        "assert.equal(slugify('Hello World'), 'hello-world');",
        "assert.equal(slugify('  Draft_#7:  Final  '), 'draft-7-final');",
        "assert.equal(slugify('---'), '');",
        "console.log('tests ok');",
        '',
      ].join('\n'),
    },
  },
  {
    // Класс «правка в связанных файлах»: изменение контракта обязано пройти по
    // обоим файлам согласованно — оракул проверяет и функцию, и потребителя.
    id: 'linked-files-edit',
    fixtureVersion: 1,
    suite: 'core',
    category: 'linked-files-edit',
    recipe: 'bugfix',
    maxTurns: 10,
    expectedFiles: ['price.mjs', 'receipt.mjs'],
    unrelatedFiles: ['unrelated.mjs'],
    verify: ['npm run test:fast'],
    requiresReview: false,
    task: 'Расширь контракт: formatPrice(cents, currency) в price.mjs должен возвращать строку вида "12.34 RUB", и все места вызова обязаны передавать валюту. Обнови потребителя receipt.mjs согласованно. unrelated.mjs не трогать. Прогони npm run test:fast.',
    scripts: {
      type: 'node linked.test.mjs',
      'test:fast': 'node linked.test.mjs',
      test: 'node linked.test.mjs',
    },
    files: {
      'price.mjs': 'export function formatPrice(cents) {\n  return (cents / 100).toFixed(2)\n}\n',
      'receipt.mjs': [
        "import { formatPrice } from './price.mjs'",
        '',
        'export function receiptTotal(cents) {',
        '  return `Итого: ${formatPrice(cents)}`',
        '}',
        '',
      ].join('\n'),
      'linked.test.mjs': [
        "import { strict as assert } from 'node:assert';",
        "import { formatPrice } from './price.mjs';",
        "import { receiptTotal } from './receipt.mjs';",
        "assert.equal(formatPrice(1234, 'RUB'), '12.34 RUB');",
        "assert.equal(receiptTotal(1234), 'Итого: 12.34 RUB');",
        "console.log('tests ok');",
        '',
      ].join('\n'),
      'unrelated.mjs': 'export const marker = "linked"\n',
    },
  },
  {
    // Класс «починить регрессию после своей же правки»: задача называет ТОЛЬКО
    // правку в settings.mjs, но она ломает согласованный hint в widget.mjs —
    // увидеть красный тест и дочинить второй файл обязан сам агент. Ровно тот
    // сценарий, который измеряет метрика «проверил ли себя» (self-check).
    id: 'self-inflicted-regression',
    fixtureVersion: 1,
    suite: 'core',
    category: 'self-inflicted-regression',
    recipe: 'bugfix',
    maxTurns: 10,
    expectedFiles: ['settings.mjs', 'widget.mjs'],
    unrelatedFiles: ['unrelated.mjs'],
    verify: ['npm run test:fast'],
    requiresReview: false,
    task: 'Увеличь DEFAULT_PAGE_SIZE в settings.mjs с 10 до 25. После правки прогони npm run test:fast и доведи прогон до зелёного, починив всё, что сломала твоя правка. unrelated.mjs не трогать.',
    scripts: {
      type: 'node consistency.test.mjs',
      'test:fast': 'node consistency.test.mjs',
      test: 'node consistency.test.mjs',
    },
    files: {
      'settings.mjs': 'export const DEFAULT_PAGE_SIZE = 10\n',
      'widget.mjs': "export const PAGE_HINT = 'показываем по 10 на странице'\n",
      'consistency.test.mjs': [
        "import { strict as assert } from 'node:assert';",
        "import { DEFAULT_PAGE_SIZE } from './settings.mjs';",
        "import { PAGE_HINT } from './widget.mjs';",
        'assert.equal(DEFAULT_PAGE_SIZE, 25);',
        'assert.ok(PAGE_HINT.includes(String(DEFAULT_PAGE_SIZE)), `PAGE_HINT (${PAGE_HINT}) must mention DEFAULT_PAGE_SIZE (${DEFAULT_PAGE_SIZE})`);',
        "console.log('tests ok');",
        '',
      ].join('\n'),
      'unrelated.mjs': 'export const marker = "regression"\n',
    },
  },
])
