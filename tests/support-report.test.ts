import { describe, it, expect } from 'vitest'
import { buildSupportReport, MAX_LOG_LINES } from '../electron/support-report'

// Отчёт о проблеме — единственный путь, которым провал у пользователя доходит до автора.
// Он же — путь, которым секрет может уехать в чужой чат: человек копирует текст и
// вставляет его в переписку, не перечитывая. Поэтому чистка здесь не «желательна», а
// является условием существования функции.

const BASE = {
  message: 'Агент не смог собрать отчёт, окно зависло',
  rating: 2,
  appVersion: '2.7.0',
  platform: 'win32',
  osRelease: '10.0.26200',
  providerId: 'deepseek',
  model: 'deepseek-v4-flash',
  now: Date.UTC(2026, 7, 22, 9, 30),
}

describe('отчёт о проблеме: содержание', () => {
  it('несёт то, без чего разбор невозможен', () => {
    const out = buildSupportReport(BASE)
    expect(out).toContain('2.7.0')
    expect(out).toContain('win32')
    expect(out).toContain('deepseek')
    expect(out).toContain('Агент не смог собрать отчёт')
  })

  it('человек мог не написать словами — отчёт всё равно собирается', () => {
    const out = buildSupportReport({ ...BASE, message: '   ' })
    expect(out).toContain('не описал словами')
    expect(out).toContain('2.7.0')
  })

  it('хвост журнала обрезается — непрочитанный отчёт равен телеметрии', () => {
    const many = Array.from({ length: 500 }, (_, i) => `строка ${i}`)
    const out = buildSupportReport({ ...BASE, logTail: many })
    expect(out).toContain('строка 499')
    expect(out).not.toContain('строка 400')
    expect(out).toContain(`(${MAX_LOG_LINES})`)
  })

  it('говорит человеку, что ничего не ушло само', () => {
    expect(buildSupportReport(BASE)).toContain('никуда не отправлен автоматически')
  })
})

describe('отчёт о проблеме: секреты не уезжают', () => {
  it('ключ из журнала не попадает в отчёт', () => {
    const out = buildSupportReport({
      ...BASE,
      logTail: ['curl -H "Authorization: Bearer sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"'],
    })
    expect(out).not.toContain('sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ')
    expect(out).toContain('REDACTED')
  })

  it('ключ, вставленный человеком в текст жалобы, тоже режется', () => {
    // Частый случай: «у меня не работает вот с этим ключом …» — и ключ уезжает в чат.
    const out = buildSupportReport({
      ...BASE,
      message: 'не работает с ключом AKIAIOSFODNN7EXAMPLE, помогите',
    })
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(out).toContain('REDACTED')
  })

  // КОНТРОЛЬНЫЙ КЕЙС. Без него оба утверждения выше зелены и тогда, когда чистка
  // вырезает всё подряд: «секрета нет» неотличимо от «отчёта нет».
  it('обычный текст чистка НЕ трогает — иначе отчёт бесполезен', () => {
    const out = buildSupportReport({
      ...BASE,
      message: 'Открыл проект, нажал отправить, окно побелело',
      logTail: ['run_command: npm run build', 'exit code 1: Cannot find module foo'],
    })
    expect(out).toContain('окно побелело')
    expect(out).toContain('npm run build')
    expect(out).toContain('Cannot find module foo')
  })
})
