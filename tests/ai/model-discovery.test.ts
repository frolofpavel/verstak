// Срез 2.0.7-E: живое обнаружение моделей (первый адаптер — grok models).
//
// Фикстуры построены на РЕАЛЬНОМ обезличенном stdout `~/.grok/bin/grok.exe models`
// (захвачен 15.07 на залогиненном grok — см. scratchpad/grok-models-real-output.txt).
// Формат plain-text (JSON grok models НЕ отдаёт). Парсер НЕ угадан — сверен с фактом.
import { describe, it, expect } from 'vitest'
import { parseGrokModels } from '../../electron/ai/model-discovery'

// === AUTH: реальный вывод (залогинен, захвачен на машине Павла 15.07) ===
const REAL_AUTH = `You are logged in with grok.com.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
  - grok-composer-2.5-fast
`

// === UNAUTH: реальный вывод в НЕзалогиненном состоянии (дословно от координатора).
// КЛЮЧЕВОЙ факт: команда всё равно отдаёт каталог, exit 0, БЕЗ ошибки; баннер
// «You are not authenticated.» идёт первой строкой — парсер обязан его пережить. ===
const REAL_UNAUTH = `You are not authenticated.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
  - grok-composer-2.5-fast
`

// === EMPTY: структурно-защитный (секция есть, строк нет) — НЕ заявляем как подтверждённый
// grok-вывод, но парсер обязан обработать корректно. ===
const EMPTY = `You are logged in with grok.com.

Available models:
`

describe('parseGrokModels — реальный формат grok models (auth + unauth)', () => {
  it('AUTH: извлекает модели/дефолт, authenticated=true', () => {
    const r = parseGrokModels(REAL_AUTH, 0)
    expect(r.status).toBe('available')
    expect(r.models).toEqual(['grok-4.5', 'grok-composer-2.5-fast'])
    expect(r.defaultModel).toBe('grok-4.5')
    expect(r.authenticated).toBe(true)
    expect(r.reasonCode).toBeUndefined()
  })

  it('UNAUTH: баннер «not authenticated» ПЕРЕЖИТ — каталог отдаётся, authenticated=false', () => {
    const r = parseGrokModels(REAL_UNAUTH, 0)
    expect(r.status).toBe('available') // НЕ error — команда вернула каталог
    expect(r.models).toEqual(['grok-4.5', 'grok-composer-2.5-fast'])
    expect(r.defaultModel).toBe('grok-4.5')
    expect(r.authenticated).toBe(false) // но каталог может быть неполным → гейт не блокирует
  })

  it('маркер (default) не попадает в id (строгий разбор строки)', () => {
    const r = parseGrokModels(REAL_AUTH, 0)
    expect(r.models).not.toContain('grok-4.5 (default)')
    expect(r.models.every(m => !m.includes(' '))).toBe(true)
  })

  it('EMPTY: секция есть, моделей нет → empty + reasonCode (структурно-защитный)', () => {
    const r = parseGrokModels(EMPTY, 0)
    expect(r.status).toBe('empty')
    expect(r.models).toEqual([])
    expect(r.reasonCode).toBe('EMPTY_CATALOG')
  })

  it('ERROR: ненулевой exit code → error, даже если stdout выглядит ок', () => {
    const r = parseGrokModels(REAL_AUTH, 1)
    expect(r.status).toBe('error')
    expect(r.reasonCode).toBe('EXIT_NONZERO')
  })

  it('пустой/мусорный вывод → error PARSE_FAILED, не падение', () => {
    const r = parseGrokModels('', 0)
    expect(r.status).toBe('error')
    expect(r.reasonCode).toBe('PARSE_FAILED')
    expect(r.models).toEqual([])
  })

  it('reasonCode — только машинный код (UPPER_SNAKE, без секретов/путей)', () => {
    for (const [s, code] of [[EMPTY, 0], ['', 0], [REAL_AUTH, 1]] as const) {
      const r = parseGrokModels(s, code)
      if (r.reasonCode) expect(r.reasonCode).toMatch(/^[A-Z_]+$/)
    }
  })

  it('grok-специфичных выдуманных error-строк в парсере НЕТ (только exit/parse)', () => {
    // Регресс-страж: раньше были придуманные ветки LOGGED_OUT/FORBIDDEN по несуществующему
    // формату. Реальный unauth возвращает каталог → «not authenticated» не должен быть error.
    expect(parseGrokModels(REAL_UNAUTH, 0).status).not.toBe('error')
  })
})
