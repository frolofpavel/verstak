import { describe, it, expect } from 'vitest'
import { attributeFailure, formatAttribution } from '../../electron/ai/failure-attribution'

// ДЕФЕКТ (01.09): при падении команды модели летел сырой вывод и общее «почини». Она
// начинала менять КОД даже там, где код ни при чём — открытое приложение держит
// нативный модуль, занят файл, оборвался прогон. Это стоит ходов вслепую и, хуже,
// правок в исправном коде.
//
// Сигнатуры взяты не у конкурентов, а из CLAUDE.md §3.1 — там это записано как
// правило ДЛЯ ЧЕЛОВЕКА («счёт падений — не вердикт; вердикт — это СООБЩЕНИЯ плюс
// УСЛОВИЯ прогона»). У агента такого правила не было.
//
// ГЛАВНЫЙ ПИН — не в том, что классификатор срабатывает, а в том, что он МОЛЧИТ,
// когда не уверен. Неверная атрибуция опаснее её отсутствия: «код верен, дело в
// окружении», сказанное про сломанный код, уводит от причины авторитетным тоном.

describe('атрибуция сбоя: узнаёт условие прогона', () => {
  it('ABI нативного модуля → не регрессия, закрыть приложение', () => {
    const out = `Error: The module was compiled against a different Node.js version
NODE_MODULE_VERSION 137. NODE_MODULE_VERSION 127. NODE_MODULE_VERSION 137.`
    const f = attributeFailure(out, 1)
    expect(f?.category).toBe('abi-lock')
    expect(f?.action).toMatch(/НЕ правь код/i)
    expect(f?.action, 'не названа настоящая причина — открытое приложение').toMatch(/приложени/i)
  })

  it('занятый файл → условие окружения, логику не менять', () => {
    const f = attributeFailure('⨯ EBUSY: resource busy or locked, unlink v8_context_snapshot.bin', 1)
    expect(f?.category).toBe('resource-busy')
    expect(f?.action).toMatch(/не меняй|Логику не меняй/i)
  })

  it('занятый порт опознаётся', () => {
    expect(attributeFailure('Error: listen EADDRINUSE: address already in use :::3000', 1)?.category).toBe('port-busy')
  })

  it('нет команды → правка исходников не поможет', () => {
    const f = attributeFailure("'vitest' is not recognized as an internal or external command", 1)
    expect(f?.category).toBe('command-missing')
    expect(f?.action).toMatch(/PATH|установ/i)
  })

  it('оборванный прогон → вердикта нет ни зелёного, ни красного', () => {
    const out = 'Test Files  12 failed (600)\nFATAL ERROR: heap out of memory'
    const f = attributeFailure(out, 1)
    expect(f?.category).toBe('run-truncated')
    expect(f?.action, 'не сказано про восстановление полноты').toMatch(/полнот|maxWorkers/i)
  })

  it('таймаут → утверждение НЕ проверялось, это про нагрузку', () => {
    const out = 'Test timed out in 20000ms\nTest timed out in 20000ms\nTest timed out in 20000ms'
    const f = attributeFailure(out, 1)
    expect(f?.category).toBe('timeout')
    expect(f?.action).toMatch(/не проверял|измерь/i)
  })

  it('много падений без подписи → усомниться в «регрессии», но диагноз не выдумывать', () => {
    const f = attributeFailure('Tests  87 failed | 12 passed', 1)
    expect(f?.category).toBe('run-truncated')
    // Важно: советует ПОСМОТРЕТЬ сообщения, а не объявляет причину.
    expect(f?.action).toMatch(/СООБЩЕНИЯ|посмотри/i)
  })
})

describe('атрибуция сбоя: молчит, когда не уверена', () => {
  // КОНТРОЛЬНЫЕ КЕЙСЫ. Без них все пины выше зелены и у классификатора, который
  // навешивает ярлык на что угодно, — а это ровно то, чего делать нельзя.
  it('обычное падение утверждения НЕ объявляется проблемой окружения', () => {
    const out = `AssertionError: expected 3 to be 4
 ❯ tests/sum.test.ts:12:5
Tests  1 failed | 40 passed`
    expect(attributeFailure(out, 1), 'настоящая ошибка кода помечена как условие прогона').toBeNull()
  })

  it('ошибка типов не подменяется догадкой про окружение', () => {
    expect(attributeFailure("src/a.ts(9,3): error TS2322: Type 'string' is not assignable", 1)).toBeNull()
  })

  it('пустой вывод не рождает диагноз', () => {
    expect(attributeFailure('', 1)).toBeNull()
  })

  it('успешная команда не разбирается вовсе', () => {
    // Шапку добавляет только падение; на успехе классификатор не зовётся, но и сам
    // по себе он на пустом выводе молчит.
    expect(attributeFailure('', 0)).toBeNull()
  })

  it('нет причины — нет и шапки', () => {
    expect(formatAttribution(null)).toBe('')
  })
})
