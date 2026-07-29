// ДЕФЕКТ 1 ЖИВОЙ ПРИЁМКИ (29.07): генератор планов не работал у самого частого
// пользователя. Активный провайдер Павла — `codex-cli`, то есть ПОДПИСКА, а
// генерация переиспользовала unattended-прогон, который принимает только
// `transport === 'API'` с ключом. Ответ на кнопку: «Провайдер codex-cli не годится
// для unattended (нужен API + ключ)». Планов ноль.
//
// ПОЧЕМУ 4198 ТЕСТОВ ЭТОГО НЕ УВИДЕЛИ: во всех фикстурах провайдер был API.
// Поэтому здесь фикстура ровно обратная — КАЖДЫЙ значимый кейс идёт на
// CLI-провайдере, и половина пинов доказывает, что вызов НЕ ПРОШЁЛ, а не что в
// тексте есть предупреждение.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createPlans } from '../../electron/storage/plans'
import { generatePlan, __resetPlanGenerationForTests } from '../../electron/ipc/plans-generate'
import { choosePlanGenerationProvider } from '../../electron/ai/plan-generation-provider'
import { PROVIDERS, providerCapabilities } from '../../electron/ai/registry'
import { rememberPlanForRun, __resetPlanForRunForTests } from '../../electron/ai/runner-shared'

let dir: string
let db: Database | undefined

/** Подписочные провайдеры Павла — именно на них всё и сломалось. */
const SUBSCRIPTION_PROVIDERS = ['codex-cli', 'claude-cli', 'gemini-cli', 'grok-cli'] as const

const withKeys = (...keys: string[]) => (k: string) => keys.includes(k)
const noKeys = () => false

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gg-plan-cli-'))
  __resetPlanForRunForTests()
  __resetPlanGenerationForTests()
})
afterEach(() => { db?.close(); db = undefined; rmSync(dir, { recursive: true, force: true }) })

// ─────────────────────────────────────────────────────────────────────────────
// ПОЧЕМУ ВООБЩЕ ФОЛБЭК. Это не вкусовщина, а свойство рантайма, и оно закреплено
// пином: у CLI/Tunnel нет `capabilities.tools`, а план создаётся ВЫЗОВОМ
// инструмента create_plan. Если однажды CLI научится отдавать инструменты —
// этот пин покраснеет, и фолбэк надо будет пересматривать. Так и задумано.
// ─────────────────────────────────────────────────────────────────────────────
describe('почему подписка не может собрать план сама', () => {
  it('у подписочных провайдеров нет инструментов — create_plan вызвать нечем', () => {
    for (const id of SUBSCRIPTION_PROVIDERS) {
      expect(providerCapabilities(PROVIDERS[id]).tools, id).toBe(false)
    }
  })

  it('контроль: у API-провайдеров инструменты есть', () => {
    for (const id of ['claude', 'openai', 'gemini-api'] as const) {
      expect(providerCapabilities(PROVIDERS[id]).tools, id).toBe(true)
    }
  })
})

describe('выбор провайдера генерации', () => {
  it('подписка + настроенный ключ → осознанный фолбэк с объяснением', () => {
    for (const active of SUBSCRIPTION_PROVIDERS) {
      const c = choosePlanGenerationProvider({ active, hasSecret: withKeys('openai_api_key') })
      expect(c.providerId, `${active}: фолбэка не случилось`).toBe('openai')
      expect(c.error, `${active}: отказ вместо фолбэка`).toBeNull()
      expect(c.notice ?? '', `${active}: подмена без объяснения — это обман`).toContain(PROVIDERS[active].name)
      expect(c.notice ?? '').toContain(PROVIDERS.openai.name)
    }
  })

  // КОНТРОЛЬ. Без него первый кейс был бы зелёным и от «подменяем всегда»:
  // молчаливая подмена рабочего провайдера — свой дефект, не лечение.
  it('контроль: годный провайдер НЕ подменяется и объяснения не показывает', () => {
    const c = choosePlanGenerationProvider({ active: 'claude', hasSecret: withKeys('anthropic_api_key') })
    expect(c.providerId).toBe('claude')
    expect(c.notice, 'показано объяснение там, где подмены не было').toBeNull()
    expect(c.error).toBeNull()
  })

  it('API-провайдер без ключа тоже уходит на фолбэк, и причина другая', () => {
    const c = choosePlanGenerationProvider({ active: 'claude', hasSecret: withKeys('gemini_api_key') })
    expect(c.providerId).toBe('gemini-api')
    expect(c.notice ?? '').toContain('ключ')
  })

  it('подписка и ни одного ключа → сообщение говорит, ЧТО СДЕЛАТЬ', () => {
    const c = choosePlanGenerationProvider({ active: 'codex-cli', hasSecret: noKeys })
    expect(c.providerId).toBeNull()
    const err = c.error ?? ''
    expect(err, 'человеку не сказали, куда идти').toContain('Настройки')
    expect(err).toContain('Провайдеры')
    expect(err, 'текст задачи — единственное, что человек боится потерять').toContain('текст задачи сохранён')
    // §(б) буквально: внутренних терминов в сообщении человеку быть не должно.
    for (const term of ['unattended', 'transport', 'API + ключ', 'headless']) {
      expect(err.toLowerCase(), `внутренний термин «${term}» в тексте для человека`).not.toContain(term.toLowerCase())
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// СКВОЗНОЕ: тот самый сценарий Павла — форма заполнена, активен codex-cli.
// ─────────────────────────────────────────────────────────────────────────────
describe('сквозной сценарий приёмки: активен codex-cli', () => {
  const REQ = () => ({
    projectPath: dir,
    title: 'Настройка Директа',
    taskDescription: 'Проверь кампании и составь порядок исправлений.',
  })

  function stores() {
    db = openDb(join(dir, 'verstak.db'))
    return createPlans(db)
  }

  it('план СОБИРАЕТСЯ, прогон идёт на API-провайдере, человек видит почему', async () => {
    const plans = stores()
    const runPlanning = vi.fn(async ({ projectPath, sendId }: { projectPath: string; sendId: number }) => {
      const plan = plans.create(projectPath, 'План', [{ title: 'Шаг' }])
      rememberPlanForRun(sendId, plan.id)
      return { ok: true, text: 'готово' }
    })

    const res = await generatePlan({
      plans, runPlanning, isKnownProject: () => true,
      choosePlanProvider: () => choosePlanGenerationProvider({ active: 'codex-cli', hasSecret: withKeys('openai_api_key') }),
    }, REQ())

    expect(res.ok, 'та же ошибка приёмки: план не собрался').toBe(true)
    expect(plans.list(dir), 'плана нет в БД').toHaveLength(1)
    // Прогон обязан идти на провайдере ВЫБОРА, а не на активном codex-cli.
    expect(runPlanning.mock.calls[0][0]).toMatchObject({ providerId: 'openai' })
    expect(res.notice ?? '', 'подмена провайдера скрыта от человека').toContain(PROVIDERS.openai.name)
    expect(res.notice ?? '', 'не сказано, чей выбор подменили').toContain(PROVIDERS['codex-cli'].name)
  })

  // ГЛАВНЫЙ ПИН ПРАВИЛА №1: механизм обязан ДОКАЗАТЬ, что вызова не было.
  it('ключей нет вовсе → прогон НЕ стартовал, в БД пусто, сказано что делать', async () => {
    const plans = stores()
    const runPlanning = vi.fn(async () => ({ ok: true, text: '' }))

    const res = await generatePlan({
      plans, runPlanning, isKnownProject: () => true,
      choosePlanProvider: () => choosePlanGenerationProvider({ active: 'codex-cli', hasSecret: noKeys }),
    }, REQ())

    expect(runPlanning, 'прогон стартовал, хотя генерировать не на чем').not.toHaveBeenCalled()
    expect(plans.list(dir)).toHaveLength(0)
    expect(res.ok).toBe(false)
    expect(res.error ?? '').toContain('Настройки')
    expect((res.error ?? '').toLowerCase()).not.toContain('unattended')
  })

  it('объяснение доезжает и тогда, когда план в итоге не собрался', async () => {
    const plans = stores()
    const runPlanning = vi.fn(async () => ({ ok: true, text: 'Не хватает доступа к кабинету.' }))

    const res = await generatePlan({
      plans, runPlanning, isKnownProject: () => true,
      choosePlanProvider: () => choosePlanGenerationProvider({ active: 'claude-cli', hasSecret: withKeys('openai_api_key') }),
    }, REQ())

    expect(res.ok).toBe(false)
    expect(res.notice ?? '', 'подмена была, а объяснения нет').not.toBe('')
    expect(res.error ?? '').toContain('доступа к кабинету')
  })
})

// АНТИ-ДРЕЙФ. Лечили мы генерацию плана, а НЕ unattended-прогон: у расписанных
// задач без надзора ограничение «только API с ключом» осмысленное и остаётся.
// Пин читает исходник — если гейт уберут заодно, страж упадёт.
describe('unattended-прогон своё ограничение сохранил', () => {
  it('runScheduledHeadless по-прежнему отсекает не-API провайдеров', () => {
    const src = readFileSync(join(process.cwd(), 'electron/ipc/ai.ts'), 'utf8')
    expect(src).toContain("descriptor.transport !== 'API'")
  })
})
